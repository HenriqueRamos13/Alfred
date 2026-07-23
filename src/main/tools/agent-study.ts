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
import { getAgent, loadAgentContext, saveStudyNote, addStudyTopicToIndex } from '../core/team.ts';
import { grantAllows } from '../core/jobs-pure.ts';
import { resolveTeamModel } from '../core/team-pure.ts';
import { delegateToAgent, runAgentTurn } from './delegate-to-agent.ts';
import type { Tool, ToolCtx } from './types.ts';

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

export interface RunStudyOpts {
  /** true = scheduled/unattended (fail-closed governance); false = agent_study tool (attended). */
  unattended: boolean;
  model?: string;
  /** UNATTENDED only: DANGEROUS-mode state (still never auto-runs sensitive) + the sensitive-action queue. */
  dangerous?: boolean;
  queueApproval?: (toolName: string, args: unknown) => void;
  /** Per-run hard-interrupt (scheduler) — aborts the research turn when it fires. */
  signal?: AbortSignal;
}

export interface RunStudyResult {
  ok: boolean;
  error?: string;
  /** The per-agent daily budget is exhausted — a scheduled study pauses its job. */
  budgetExhausted?: boolean;
  /** Tokens the research turn spent (unattended path only; attended is tracked globally). */
  tokens?: number;
  result?: {
    agent: string;
    topic: string;
    note: string;
    mode: 'create' | 'append';
    indexUpdated: string;
    findings: string;
  };
}

/**
 * The core of agent_study, FACTORED so BOTH the tool (attended) and the
 * JobScheduler (unattended, kind:"study") call it. A roster agent runs ONE
 * read-only web-research turn on ITS model + context + grant; then the TRUSTED
 * runner (not the agent) persists the synthesis as a confined knowledge note and
 * adds the topic to the shared index. Enforces the per-agent daily budget +
 * global kill-switch (both inside runAgentTurn). Never throws.
 */
export async function runStudy(ctx: ToolCtx, agentId: string, topic: string, opts: RunStudyOpts): Promise<RunStudyResult> {
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!topic || !topic.trim()) return { ok: false, error: 'topic is required' };

  const agent = getAgent(ctx.db, agentId);
  if (!agent) {
    return { ok: false, error: `no roster agent with id "${agentId}" (create one with the team tool, or team op=list to see them)` };
  }

  // Research is browser READ (read-only egress) → the 'read' capability. Fail
  // early with a clear ask instead of burning a turn if the grant lacks it.
  if (!grantAllows(agent.grant, 'browser', { op: 'goto' })) {
    return {
      ok: false,
      error: `${agent.id}'s grant does not permit web research — grant it "read" (team op=create … grant:["read", …]) so it can browse read-only`,
    };
  }

  const t = topic.trim();

  if (opts.unattended) {
    // Scheduled study runs the agent IN-PROCESS (fail-closed governance), so a
    // claude-cli agent (external spawn, attended-only) can't run unattended.
    if (agent.provider === 'claude-cli') {
      return { ok: false, error: `scheduled study needs an API-brain agent; ${agent.id} is a claude-cli agent (run it attended via agent_study)` };
    }
    const context = await loadAgentContext(ctx.workspace, agent);
    const model = resolveTeamModel(opts.model, agent);
    const turn = await runAgentTurn(ctx, {
      agentId: agent.id,
      provider: agent.provider,
      model,
      grant: agent.grant,
      dailyTokenBudget: agent.dailyTokenBudget,
      system: context,
      task: researchPrompt(t),
      signal: opts.signal,
      unattended: { dangerous: opts.dangerous ?? false, queue: opts.queueApproval ?? (() => {}) },
    });
    if (!turn.ok) return { ok: false, error: turn.error, budgetExhausted: turn.budgetExhausted };
    const findings = (turn.result?.text ?? '').trim();
    if (!findings) return { ok: false, error: 'the agent returned no findings to save' };
    const note = await saveStudyNote(ctx.workspace, agent.id, t, findings);
    await addStudyTopicToIndex(ctx.workspace, agent.id, t);
    return { ok: true, tokens: turn.tokens, result: { agent: agent.id, topic: t, note: note.relativePath, mode: note.mode, indexUpdated: 'agents/index.md', findings } };
  }

  // Attended: reuse the delegate runner verbatim (model/context/grant/governance/
  // trifecta/global+per-agent budget). A human is present → sensitive → approval.
  const run = await delegateToAgent.execute({ agentId: agent.id, task: researchPrompt(t), model: opts.model }, ctx);
  if (!run.ok) return run as RunStudyResult;
  const findings = ((run.result as { text?: string } | undefined)?.text ?? '').trim();
  if (!findings) return { ok: false, error: 'the agent returned no findings to save' };
  const note = await saveStudyNote(ctx.workspace, agent.id, t, findings);
  await addStudyTopicToIndex(ctx.workspace, agent.id, t);
  return { ok: true, result: { agent: agent.id, topic: t, note: note.relativePath, mode: note.mode, indexUpdated: 'agents/index.md', findings } };
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
    // Thin wrapper over the factored runStudy (attended). The scheduler calls the
    // same runStudy with {unattended:true} for kind:"study" jobs.
    const run = await runStudy(ctx, a.agentId, (a.topic ?? '').trim(), { unattended: false, model: a.model });
    return run.ok ? { ok: true, result: run.result } : { ok: false, error: run.error };
  },
};
