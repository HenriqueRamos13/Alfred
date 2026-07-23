/**
 * agent_study — an agent learns a topic ON DEMAND (Phase 5, stage 3).
 *
 * A named roster agent runs ONE research turn (read-only web browsing) and the
 * TRUSTED runner — not the agent — persists the synthesised findings as a
 * knowledge note in the agent's OWN folder + adds the topic to the shared index.
 *
 * The research turn REUSES the delegate_to_agent runner verbatim: same model,
 * same assembled context (role + shared index + own notes), same per-tool grant
 * enforcement, same attended governance, same per-run trifecta escalation (once
 * the agent reads untrusted web content, any outbound action escalates to human
 * approval), and the same GLOBAL daily token kill-switch. The agent never gets an
 * arbitrary file-write tool — it only researches; the runner writes the note to a
 * path confined to `agents/<agentId>/knowledge/`.
 *
 * T2 (egress research + persisted knowledge), gated once before it runs.
 */
import { getAgent, saveStudyNote, addStudyTopicToIndex } from '../core/team.ts';
import { grantAllows } from '../core/jobs-pure.ts';
import { delegateToAgent } from './delegate-to-agent.ts';
import type { Tool } from './types.ts';

interface Args {
  agentId: string;
  topic: string;
  model?: string;
}

/** The research brief handed to the agent. It only researches + synthesises — the runner saves the note. */
function researchPrompt(topic: string): string {
  return (
    'Research the topic below in depth using the browser tool (read-only web browsing): open relevant, ' +
    'reputable sources and read them. Then synthesise what you learned into clear, concise knowledge notes — ' +
    'facts, patterns, gotchas, and the sources you used. Output ONLY that synthesis as your final message; ' +
    'do NOT try to save files (your notes are persisted for you automatically).\n\n' +
    `# Topic to study\n${topic}`
  );
}

export const agentStudy: Tool<Args> = {
  name: 'agent_study',
  description:
    'Have a roster agent LEARN a topic on demand: it runs one read-only web-research turn on ITS model + context, ' +
    'bounded by ITS grant, then the synthesised findings are saved as a knowledge note in that agent\'s private folder ' +
    'and the topic is added to the shared who-knows-what index (so Alfred can route by it). {agentId, topic, model?}. ' +
    'The agent needs "read" in its grant (to browse read-only) — otherwise returns a clear error to grant it. ' +
    'Sensitive/outbound actions still hit normal approval (attended); token spend counts against the global daily budget. ' +
    'Requires approval (T2).',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'The roster agent id to teach (from the team tool op=list).' },
      topic: { type: 'string', description: 'What to study (e.g. "Rust async runtimes"). Becomes the note filename slug.' },
      model: {
        type: 'string',
        description: 'Optional model override — must be in the agent\'s provider catalog, else the agent\'s configured model is used.',
      },
    },
    required: ['agentId', 'topic'],
  },

  // Egress research + persisted knowledge — always a T2 verify-first action.
  risk: () => 'T2',

  async execute(a, ctx) {
    if (!a.agentId) return { ok: false, error: 'agentId is required' };
    if (!a.topic || !a.topic.trim()) return { ok: false, error: 'topic is required' };

    const agent = getAgent(ctx.db, a.agentId);
    if (!agent) {
      return { ok: false, error: `no roster agent with id "${a.agentId}" (create one with the team tool, or team op=list to see them)` };
    }

    // Research is browser READ (read-only egress) → the 'read' capability. If the
    // agent's grant lacks it the runner would refuse every browse call, so fail
    // early with a clear ask instead of burning a turn.
    if (!grantAllows(agent.grant, 'browser', { op: 'goto' })) {
      return {
        ok: false,
        error: `${agent.id}'s grant does not permit web research — grant it "read" (team op=create … grant:["read", …]) so it can browse read-only`,
      };
    }

    const topic = a.topic.trim();
    // Reuse the delegate runner verbatim (model/context/grant/governance/trifecta/budget).
    const run = await delegateToAgent.execute({ agentId: agent.id, task: researchPrompt(topic), model: a.model }, ctx);
    if (!run.ok) return run;
    const findings = ((run.result as { text?: string } | undefined)?.text ?? '').trim();
    if (!findings) return { ok: false, error: 'the agent returned no findings to save' };

    // Trusted persistence: confined note write + shared-index topic (local, not egress).
    const note = await saveStudyNote(ctx.workspace, agent.id, topic, findings);
    await addStudyTopicToIndex(ctx.workspace, agent.id, topic);

    return {
      ok: true,
      result: {
        agent: agent.id,
        topic,
        note: note.relativePath,
        mode: note.mode,
        indexUpdated: 'agents/index.md',
        findings,
      },
    };
  },
};
