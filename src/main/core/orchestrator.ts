/**
 * Orchestrator — provider-agnostic agent loop over the Vercel AI SDK.
 *
 * The AI SDK (`streamText` + tools) drives the model↔tool round-trips for ANY
 * brain (Anthropic / OpenAI / DeepSeek — see providers.ts). Alfred's guardrails
 * are layered on top and preserved end to end:
 *   - daily token kill-switch + per-session/day counters (BudgetTracker), counting
 *     usage from whichever provider is active, checked before AND after each call
 *   - per-task step cap
 *   - identical-call loop detection
 *   - risk classification + HITL approvals (T2/T3), performed INSIDE each tool's
 *     wrapper execute (ctx.governance.requestApproval)
 *   - trifecta-lite: block egress once untrusted-read + private data are in play
 *   - audit of every tool call (secrets masked)
 *   - streaming to the UI via the existing StreamEvent contract
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import type { LanguageModel, ToolSet } from 'ai';
import type {
  AccountRecord,
  AlfredConfig,
  ApprovalDecision,
  CardLayout,
  CardPatch,
  ChatMessage,
  CostSnapshot,
  Job,
  JobApproval,
  ProjectRecord,
  StreamEvent,
  Tool,
  ToolCtx,
  WakeStatus,
} from './types.ts';
import { getLayout as readLayout, updateCard as writeCard } from './layout.ts';
import { BudgetTracker, callSignature, isLoop, isOverDailyBudget } from './budget.ts';
import { createGovernance, runGovernedTool } from './governance.ts';
import { startMcpBridge, type McpBridgeHandle } from './mcpServer.ts';
import { ensureClaudeMd, ensureScaffold, readStable, recentMemoryText, formatTranscript, readIndex, listInbox } from './memory.ts';
import { CAPABILITY_MANIFEST } from './manifest.ts';
import { runCurator } from './curator.ts';
import { createSecrets } from './secrets.ts';
import { getProject, listProjects } from './projects.ts';
import { getGraph as buildVaultGraph, getNote as readNotePreview, type Graph } from './graph.ts';
import { factoryResetPaths, factoryResetTables } from './reset.ts';
import { resolveProvider, listBrains, resolveActiveBrainId } from './providers.ts';
import type { BrainInfo } from './providers.ts';
import { askReference as runReferenceTurn } from './reference.ts';
import type { ReferenceRequest } from './reference.ts';
import {
  parseAgentConfig,
  coerceAgent,
  agentToSpec,
  hasPersistedAgent,
  brainToProvider,
  providerToBrain,
  modelSupportsVision,
  buildToolModelOutput,
  DEFAULT_MODEL,
  DEFAULT_MAIN_NAME,
  MODEL_CATALOG,
} from './modelCatalog.ts';
import type { AgentConfig, AgentConfigMap, AgentId, ProviderId, CatalogModel } from './modelCatalog.ts';
import { getSetting, setSetting, insertMessage, getRecentMessages } from './db.ts';
import {
  JobScheduler,
  listJobs,
  listPendingApprovals,
  resolveApproval as resolveJobApprovalDb,
  getJob as getJobDb,
  updateJob as updateJobDb,
  deleteJob as deleteJobDb,
} from './jobs.ts';
import { grillMeEnabled } from './settings-pure.ts';
import { enqueueTurn } from './turn-queue-pure.ts';
import { dayKey } from './budget.ts';
import { spawnClaudeCli, dangerousArgs } from './claudeSpawn.ts';
import * as tts from './tts.ts';
import * as stt from './stt.ts';
import * as wakeword from './wakeword.ts';
import { tools, createBrowserHandle, isCoreTool } from '../tools/index.ts';
import {
  shouldDefer,
  buildCatalog,
  searchCatalog,
  resolveBridgeCall,
  sanitizeToolSchema,
  type ToolMeta,
} from './tool-disclosure-pure.ts';

type AlfredDb = import('better-sqlite3').Database;

const ALFRED_IDENTITY = `You are Alfred, a personal Agent OS running natively on the user's Mac. You
operate the real machine on their behalf and render your own control-centre UI.
You are calm, precise and discreet — a trusted operator, not a chatbot. Act
autonomously within your remit; stop to ask only when governance requires an
approval or when genuinely blocked. Your name is Alfred, always — never "Jarvis".
Your identity and name are "Alfred" no matter which model powers you (Claude,
DeepSeek, OpenAI or any other) — the model is only your engine. If asked who you
are, you are Alfred; do not introduce yourself as "DeepSeek", "ChatGPT" or
"Claude", and name the underlying model only if the user explicitly asks which
model powers you.

In the MAIN CHAT reply with ONLY the final result: one short confirmation per
request. NEVER narrate intermediate steps and NEVER dump internal detail
(pixels, dimensions, colours, coordinates, step-by-step logs) unless the user
explicitly asks. Ask a question only if genuinely blocked. Be verbose ONLY when
explicitly asked.

Governance you must respect:
- Every tool call is risk-tiered. T0 (read/search/list) and T1 (reversible
  workspace writes) run freely; T2 (delete/send/install/egress/delegation) and
  T3 (money/credentials) require the human's approval, which the host enforces.
- The HOST handles all approvals. NEVER ask the user for permission or
  confirmation in text (no "posso abrir o navegador?", "may I proceed?", "preciso
  da tua aprovação"). Just CALL the tool — if an approval is needed the host
  shows the prompt itself. Opening/navigating the browser is T0: no approval, so
  do it without asking.
- You can delegate a self-contained autonomous task to a full Claude Code agent
  via delegate_to_claude_code (headless \`claude -p\`); it needs approval.
- Never print, echo, or log secret values — mask them.
- Honour the token budget and step caps; if a task starts looping, stop and
  report rather than repeating.
Organise substantial work as projects under the workspace (ICM
folder-as-context); render live status into the surface with render_ui using
only the whitelisted components.

Memory: you have a file-based long-term memory via the memory tool. Proactively
'remember' important things as they happen — durable facts about the user or the
world with kind:"semantic", and noteworthy events with kind:"episodic" (a dated
journal). When the user refers to the past ("what did we discuss last week", "do
you remember X"), 'recall' (optionally with a query / sinceDays) or 'list' your
memory BEFORE answering. Never invent memories: if recall finds nothing, say so.
The "Knowledge map" below (index.md) is your L1 router to durable notes; reach
the rest lazily via recall and the [[wikilinks]] it lists.

When you COMPLETE a relevant task, persist its durable knowledge: (a) call memory
op:"note" to write an atomic note (one idea — observations + typed [[wikilink]]
relations), then (b) call memory op:"handoff" with a short summary of what you did
and the note/file path. A dedicated curator later files those handoffs into the
vault — you just capture; you don't organise.

You can inspect and reorganise your own floating control-centre cards with the
ui_layout tool (T1, no approval): get_layout (also returns the canvas viewport
size — the bounds you must stay within), move_card, resize_card, show_card,
hide_card, arrange (tidy every card into a clean grid that fits the window) and
reset (restore defaults). Coordinates are pixels relative to the canvas whose
width/height get_layout reports; call get_layout first, since the user drags
cards too.`;

/** Reason the loop was hard-stopped by a guardrail (vs a plain user stop). */
type StopInfo = { kind: 'budget' | 'step' | 'loop'; message: string };

export interface OrchestratorDeps {
  config: AlfredConfig;
  ctx: ToolCtx;
  tools: Tool[];
  /** Resolved AI-SDK model for this turn (selected brain). */
  model: LanguageModel;
  /** Brain id (e.g. 'anthropic') driving this turn. */
  brainId: string;
  /** Model id (e.g. 'claude-sonnet-5') driving this turn — used for cost. */
  modelId: string;
  /** Brain id/model label, for logs. */
  brainLabel: string;
  /** Extra system context (active project manifest, etc.), assembled by the caller. */
  projectContext?: string;
  /** Cap on model output tokens per turn. */
  maxTokens?: number;
}

export class Orchestrator {
  private readonly budget: BudgetTracker;
  private readonly stepCap: number;
  private readonly maxTokens: number;
  private controller: AbortController | null = null;
  private readonly history: string[] = [];
  private stopInfo: StopInfo | null = null;
  private usdWarned = false;

  constructor(private readonly deps: OrchestratorDeps) {
    this.budget = new BudgetTracker(
      deps.ctx.db,
      {
        dailyLimit: deps.config.dailyTokenBudget,
        stepCap: deps.config.stepCap,
        dailyUsdBudget: deps.config.dailyUsdBudget,
      },
      deps.ctx.sessionId,
    );
    this.stepCap = deps.config.stepCap;
    this.maxTokens = deps.maxTokens ?? 4096;
  }

  /** Kill switch — abort the in-flight model call and stop the loop. */
  abort(): void {
    this.controller?.abort();
  }

  /** Run one user turn to completion (may span many model+tool round-trips). */
  async run(userText: string): Promise<void> {
    const { ctx } = this.deps;
    this.controller = new AbortController();
    const system = await this.buildSystem();

    ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });

    let assistantText = '';
    try {
      const result = streamText({
        model: this.deps.model,
        system,
        prompt: userText,
        maxOutputTokens: this.maxTokens,
        tools: this.buildTools(),
        // Backstop; the real cap is enforced (with an error) in prepareStep.
        stopWhen: stepCountIs(this.stepCap + 1),
        abortSignal: this.controller.signal,
        // Runs before every model call — the "check before each call" guardrail.
        prepareStep: ({ stepNumber }) => {
          if (stepNumber >= this.stepCap) {
            this.hardStop({ kind: 'step', message: `Step cap reached (${this.stepCap}). Halting task.` });
          } else if (isOverDailyBudget(this.budget.snapshot())) {
            const s = this.budget.snapshot();
            this.hardStop({
              kind: 'budget',
              message: `Daily token budget exhausted (${s.dailyTokens}/${s.dailyLimit}). Halting.`,
            });
          }
          return {};
        },
        // Runs after every model call — count usage from ANY provider. Wrapped so a
        // failed SQLite write / malformed emit degrades gracefully instead of
        // rejecting inside the AI-SDK callback and taking the process down.
        onStepFinish: ({ usage }) => {
          try {
            const state = this.budget.record(
              { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
              this.deps.modelId,
            );
            ctx.emit({ kind: 'budget', state });
            const snapshot = this.budget.costSnapshot(this.deps.brainId, this.deps.modelId);
            ctx.emit({ kind: 'cost', snapshot });
            if (snapshot.overUsdBudget && !this.usdWarned) {
              this.usdWarned = true;
              ctx.emit({
                kind: 'error',
                sessionId: ctx.sessionId,
                message: `Soft budget: est. $${snapshot.today.usd.toFixed(2)} today exceeds ALFRED_DAILY_USD_BUDGET ($${snapshot.dailyUsdBudget}). Not blocking (token cap still applies).`,
              });
            }
          } catch (err) {
            console.error('[alfred] post-step accounting failed:', err instanceof Error ? err.message : err);
          }
        },
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });
            break;
          case 'text-delta':
            assistantText += part.text;
            ctx.emit({ kind: 'chat.delta', sessionId: ctx.sessionId, text: part.text });
            break;
          case 'finish-step':
            if (assistantText.trim()) {
              ctx.emit({ kind: 'chat.message', message: this.chatMessage('assistant', assistantText) });
            }
            assistantText = '';
            break;
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          default:
            break;
        }
      }

      if (this.stopInfo) {
        ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message: this.stopInfo.message });
        ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'error' });
        return;
      }
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'done' });
    } catch (err) {
      // A guardrail hard-stop or user stop surfaces here as an AbortError.
      if (this.stopInfo) {
        ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message: this.stopInfo.message });
        ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'error' });
        return;
      }
      if (this.controller?.signal.aborted) {
        // Plain user stop — clean halt, no error.
        ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'done' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit({ kind: 'error', sessionId: ctx.sessionId, message });
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'error' });
    }
  }

  /** Record a guardrail stop and abort the in-flight generation. */
  private hardStop(info: StopInfo): void {
    this.stopInfo = info;
    this.controller?.abort();
  }

  /**
   * Wrap the session's tools as AI-SDK tools; governance runs inside execute.
   *
   * Progressive tool disclosure (Phase 6 Stage 1): when the DEFERRABLE (non-core)
   * tool definitions would exceed the token budget, they are replaced in the
   * model-visible set by 3 bridge tools — tool_search / tool_describe / tool_call.
   * The catalog is rebuilt STATELESS here on every assembly (no session state to
   * drift). tool_call unwraps to the real tool and routes through the SAME
   * governed path (runTool → runGovernedTool), so approvals / risk-tier / trifecta
   * / audit fire identically to a direct call. Below the budget, everything is
   * exposed as before (no bridge). Every schema is run through sanitizeToolSchema
   * so strict backends (Anthropic) don't 400 on MCP-style schemas.
   */
  private buildTools(): ToolSet {
    // Does the active brain accept images? screenshot pixels are only fed to a
    // vision-capable brain; a blind brain gets a "switch brains" nudge instead.
    const brainHasVision = modelSupportsVision(brainToProvider(this.deps.brainId), this.deps.modelId);

    const wrapReal = (t: Tool) =>
      tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema(sanitizeToolSchema(t.inputSchema) as any),
        execute: (args: unknown) => this.runTool(t, args),
        // Feed screenshot pixels to the model as multimodal content when the
        // active brain can see; otherwise keep the JSON result but hint to switch.
        toModelOutput: ({ output }) => buildToolModelOutput(output, brainHasVision),
      });

    const metas: ToolMeta[] = this.deps.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      core: isCoreTool(t.name),
    }));
    const capRaw = Number(process.env.ALFRED_TOOL_DISCLOSURE_TOKENS);
    const plan = shouldDefer(metas, Number.isFinite(capRaw) && capRaw > 0 ? { maxTokens: capRaw } : {});

    const set: ToolSet = {};
    if (!plan.defer) {
      for (const t of this.deps.tools) set[t.name] = wrapReal(t);
      return set;
    }

    // Deferred mode: core tools stay directly callable; the rest hide behind the
    // bridge. Catalog is derived from THIS session's deferrable tools only.
    for (const t of this.deps.tools) if (isCoreTool(t.name)) set[t.name] = wrapReal(t);
    const catalog = buildCatalog(metas);

    set.tool_search = tool({
      description:
        'Search Alfred\'s DEFERRED tools (not currently loaded to save context). ' +
        'Returns matching tool names + one-line summaries. Then use tool_describe(name) for the full schema and tool_call(name, args) to run one.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string', description: 'What you want to do (e.g. "read email", "browse the web").' } },
        required: ['query'],
      } as any),
      execute: (args: unknown) => {
        const query = String((args as { query?: unknown })?.query ?? '');
        return Promise.resolve({ tools: searchCatalog(catalog, query) });
      },
    });

    set.tool_describe = tool({
      description: 'Get the full description + input schema of ONE deferred tool by name (from tool_search).',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact tool name from tool_search.' } },
        required: ['name'],
      } as any),
      execute: (args: unknown): Promise<unknown> => {
        const res = resolveBridgeCall(this.deps.tools, (args as { name?: unknown })?.name);
        if ('error' in res) return Promise.resolve({ error: res.error });
        return Promise.resolve({
          name: res.tool.name,
          description: res.tool.description,
          inputSchema: sanitizeToolSchema(res.tool.inputSchema),
        });
      },
    });

    set.tool_call = tool({
      description:
        'Execute a deferred tool by name with its args. Runs through the EXACT same governance ' +
        '(approvals, risk tier, trifecta, audit) as a direct call — the bridge is only a context-saving indirection.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact tool name from tool_search / tool_describe.' },
          args: { type: 'object', description: 'The tool\'s arguments, matching its schema.' },
        },
        required: ['name'],
      } as any),
      execute: (input: unknown) => {
        const { name, args } = (input as { name?: unknown; args?: unknown }) ?? {};
        const res = resolveBridgeCall(this.deps.tools, name);
        if ('error' in res) return Promise.resolve({ error: res.error });
        // IDENTICAL governed path: loop detection + runGovernedTool, exactly as a
        // direct tool call. The bridge unwraps to the real Tool and hands it off.
        return this.runTool(res.tool, args ?? {});
      },
      toModelOutput: ({ output }) => buildToolModelOutput(output, brainHasVision),
    });

    return set;
  }

  private async buildSystem(): Promise<string> {
    const { ctx } = this.deps;
    // L1 always-loaded layer: identity + the thin capability manifest (index of
    // everything Alfred can do + routing + pointers). The detailed docs it names
    // (docs/**, skills/**) are L2 — referenced, never loaded by default.
    let sys = `${ALFRED_IDENTITY}\n\n${CAPABILITY_MANIFEST}`;
    // Seeing the screen: route layout questions to get_layout (coordinates), real
    // screen content to screenshot, and tell the brain whether it can see at all.
    const canSee = modelSupportsVision(brainToProvider(this.deps.brainId), this.deps.modelId);
    sys +=
      '\n\n# Seeing the screen\n' +
      '- For card/window POSITIONS and coordinates (layout questions), use the ui_layout tool op get_layout — it returns exact coordinates + every display. You do NOT need a screenshot for that.\n' +
      '- To SEE the real content on screen, use the system tool op screenshot.\n' +
      (canSee
        ? '- Your active brain HAS vision: a screenshot is fed to you as an image, so you can actually see it. Never say "I cannot see the screen" — take the screenshot.'
        : '- Your active brain has NO vision, so a screenshot cannot be shown to you. Use get_layout for positions; to see screen content, tell the user to switch to Claude or GPT in SETTINGS.');
    // Read per-turn so toggling the button takes effect on the next turn.
    if (getSetting(ctx.db, 'dangerous_mode') === '1') {
      sys +=
        '\n\nDANGEROUS MODE is ON: all approvals are bypassed — never ask for permission or confirmation, just execute.';
    }
    // GRILL-ME (plan-clarity interview). Default ON; read per-turn like dangerous
    // mode so the topbar/agent toggle takes effect next turn. Orthogonal to
    // governance: it locks the PLAN before acting; it does NOT replace approvals.
    if (grillMeEnabled(getSetting(ctx.db, 'grill_me_enabled'))) {
      sys +=
        '\n\nGRILL-ME is ON: when the user request is ambiguous OR high-stakes ' +
        "(T2/T3, money, delete, a vague project like 'build me an app'), FIRST " +
        'interview them ONE question at a time (grill-me style — see ' +
        'skills/grill-me/SKILL.md) to lock the plan before acting; ask, wait, ' +
        'resolve each branch; only implement once the plan is clear. When the ' +
        'request is simple/unambiguous, act directly. This is about plan CLARITY ' +
        'only — dangerous mode and governance approvals still fully apply. The ' +
        'user can turn this off/on any time ("desativa/ativa o grill me"); when ' +
        'they ask, call the system tool op grill_me_off / grill_me_on / grill_me_toggle.';
    }
    const mem = await readStable(ctx.workspace).catch(() => '');
    if (mem.trim()) sys += `\n\n# Stable memory (honour these)\n${mem}`;
    // L1: the index.md Map of Content — the router to every durable note.
    const index = await readIndex(ctx.workspace).catch(() => '');
    if (index.trim()) sys += `\n\n# Knowledge map (index — L1 router)\n${index}`;
    const recent = await recentMemoryText(ctx.workspace).catch(() => '');
    if (recent.trim()) sys += `\n\n# Recent memory (last 7 days)\n${recent}`;
    // The just-sent user turn is persisted before run() and is passed as the
    // prompt, so drop it here to avoid duplicating it in the transcript.
    const transcript = formatTranscript(getRecentMessages(ctx.db, 13).slice(0, -1), 2000);
    if (transcript.trim()) sys += `\n\n# Recent conversation (for continuity)\n${transcript}`;
    if (this.deps.projectContext?.trim()) sys += `\n\n# Active project\n${this.deps.projectContext}`;
    return sys;
  }

  private chatMessage(role: ChatMessage['role'], content: string): ChatMessage {
    return { id: randomUUID(), sessionId: this.deps.ctx.sessionId, role, content, ts: Date.now() };
  }

  /**
   * Run one tool call: loop detection, risk classification, trifecta escalation,
   * HITL approval, execution and audit. Returns the tool's output value (or an
   * `{ error }` object) for the model — errors don't throw so the agent can react,
   * except a detected loop which hard-stops the whole task.
   */
  private async runTool(t: Tool, args: unknown): Promise<unknown> {
    // Loop detection — hard-stop the whole task, not just this call. Everything
    // after (risk, trifecta, approval, execute, audit) is the shared governance
    // path in runGovernedTool, reused by the MCP bridge.
    const sig = callSignature(t.name, args);
    if (isLoop(this.history, sig)) {
      this.hardStop({ kind: 'loop', message: `Loop detected: "${t.name}" called with identical args >3 times.` });
      return { error: 'Loop detected — task halted.' };
    }
    this.history.push(sig);
    return runGovernedTool(t, args, this.deps.ctx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// claude-code conversational brain — bypasses streamText. Runs `claude -p` with
// session continuity (--resume). Claude Code uses ITS OWN tools; Alfred's tools
// and per-turn HITL do not apply here. cwd is confined to the workspace.
// ─────────────────────────────────────────────────────────────────────────────

interface ClaudeTurn {
  sessionId?: string;
  result?: string;
  error?: string;
  enoent?: boolean;
}

async function spawnClaudeConversation(
  prompt: string,
  cwd: string,
  dangerous: boolean,
  resumeId?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<ClaudeTurn> {
  const args = ['-p', prompt, '--output-format', 'json', ...dangerousArgs(dangerous)];
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', resumeId);
  const out = await spawnClaudeCli(args, { cwd, signal });
  if (out.enoent) return { enoent: true };
  if (out.code !== 0) {
    return { error: `claude -p exited ${out.code}: ${(out.stderr || out.stdout).trim()}` };
  }
  try {
    const parsed = JSON.parse(out.stdout) as { session_id?: string; result?: string };
    return { sessionId: parsed.session_id, result: parsed.result ?? out.stdout.trim() };
  } catch {
    return { result: out.stdout.trim() };
  }
}

/**
 * Cost snapshot for the claude-code brain: spend is billed by the subscription,
 * not Alfred's estimator, so everything is zero and `external` is flagged. Shared
 * by the live turn path and the startup read so the COST card matches.
 */
function externalCostSnapshot(dailyTokenCap: number, model?: string): CostSnapshot {
  const zero = { inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 };
  return {
    activeBrain: 'claude-code',
    activeModel: model ? `claude -p (${model})` : 'claude -p',
    day: dayKey(),
    today: zero,
    session: zero,
    byModel: [],
    dailyTokenCap,
    overUsdBudget: false,
    external: true,
  };
}

/** Prepend recent persisted history to a claude prompt (cold-start continuity). */
function withHistoryPreamble(db: AlfredDb, text: string): string {
  // Drop the just-persisted current user turn (last row); it's the actual prompt.
  const transcript = formatTranscript(getRecentMessages(db, 13).slice(0, -1), 2000);
  if (!transcript.trim()) return text;
  return `# Earlier in our conversation (for continuity)\n${transcript}\n\n# Now\n${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition — builds the ToolCtx, governance and browser handle, then exposes
// the IPC façade the shell (index.ts / ipc.ts) consumes.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateOrchestratorOpts {
  config: AlfredConfig;
  db: AlfredDb;
  emit: (event: StreamEvent) => void;
  /** App data dir; the persistent browser profile lives under it. */
  dataDir: string;
  /**
   * Window controls (injected by the shell so core stays Electron-free). Used by
   * the wake-word voice commands so "esconder"/"mostrar" work from MAIN even
   * while the overlay is hidden. Optional — omitted in tests / headless.
   */
  windowControl?: { hide(): void; show(): void };
  /**
   * System notification sink (injected by the shell so core stays Electron-free).
   * Used by the scheduled-jobs engine to alert the user when an unattended agent
   * job queues a sensitive action or pauses on budget. Optional (tests/headless).
   */
  notify?: (title: string, body: string) => void;
}

/** Exactly what a factory reset erases — surfaced to the confirmation modal. */
export interface FactoryResetInfo {
  /** Absolute directories removed from disk (confined to workspace + data dir). */
  paths: { label: string; path: string }[];
  /** The DB file whose tables are cleared (not deleted, so the handle stays valid). */
  dbPath: string;
  counts: { messages: number; projects: number; accounts: number; secrets: number };
}

export interface OrchestratorHandle {
  send(text: string): Promise<void>;
  /** Recent persisted chat messages (oldest→newest) for the UI to reload on open. */
  getHistory(limit?: number): ChatMessage[];
  stop(): void;
  resolveApproval(resolution: { id: string; decision: ApprovalDecision; remember?: boolean }): void;
  /** DANGEROUS mode (bypass all approvals): read/toggle, persisted. */
  getDangerousMode(): boolean;
  setDangerousMode(on: boolean): boolean;
  /**
   * SPAWN kill-switch (Phase 6 stage 2): when ON, any NEW fan-out (delegate_to_agent,
   * delegate_to_claude_code, a scheduled study) is refused; children already running
   * finish. Read/set, persisted, default OFF.
   */
  getSpawnPaused(): boolean;
  setSpawnPaused(on: boolean): boolean;
  /** GRILL-ME (interview to lock the plan before acting): read/toggle, persisted, default ON. */
  getGrillMe(): boolean;
  setGrillMe(on: boolean): boolean;
  /** Clear all persisted auto-approve rules ("ask again next time"). */
  resetApprovals(): void;
  /**
   * Reset ONLY the main conversation: wipe chat history + the claude-code
   * --resume session id (fresh next turn). Memory, facts and projects are kept.
   */
  resetConversation(): void;
  /** What a factory reset will erase (paths + counts), for the confirmation modal. */
  factoryResetInfo(): FactoryResetInfo;
  /** Nuke everything Alfred knows (DB, memory, projects, browser profile, secrets). */
  factoryReset(): Promise<void>;
  /** Manually run the memory curator (drain inbox → notes, rebuild MOCs/backlinks). */
  runCurator(): Promise<unknown>;
  /** Knowledge-graph data (notes + projects + wikilink edges) for the graph card. */
  getGraph(): Promise<Graph>;
  /** Read-only markdown of one note, for the graph card's node preview. */
  getNote(ref: string): Promise<{ title: string; markdown: string } | null>;
  /**
   * Reference agent: one ISOLATED, read-only turn over a note/node. Streams
   * reference.* events scoped by threadId; never touches the main chat/session.
   */
  askReference(req: ReferenceRequest): Promise<void>;
  listProjects(): ProjectRecord[];
  listAccounts(): AccountRecord[];
  /** Brain availability (enabled/disabled) for the UI. */
  listBrains(): BrainInfo[];
  /** The effective active brain id (derived from the main agent's provider). */
  getActiveBrain(): string | null;
  /** Persist the active brain (only if it exists and is enabled); returns the new effective id. */
  setActiveBrain(id: string): string | null;
  /** Per-agent config (main / reference / curator): name + provider + model. */
  getAgentConfig(): AgentConfigMap;
  /** Patch one agent's config (validated against the catalog); returns the full config. */
  setAgentConfig(id: AgentId, patch: Partial<AgentConfig>): AgentConfigMap;
  /** The hardcoded model catalog, per provider (for the settings-card dropdowns). */
  getModelCatalog(): Record<ProviderId, CatalogModel[]>;
  connectGmail(): Promise<AccountRecord | null>;
  /** Full floating-card layout (seeds defaults on first read). */
  getLayout(): CardLayout[];
  /** Persist a card patch (user drag/resize), emit 'layout', return the new layout. */
  updateCard(id: string, patch: CardPatch): CardLayout[];
  /** Record the live canvas size (renderer) so ui_layout stays in-bounds. */
  setViewport(w: number, h: number): void;
  /** Today's persisted cost snapshot, read at startup so the COST card isn't empty. */
  getCost(): CostSnapshot;
  /** Voice output (Alfred speaks replies): read/toggle, persisted, default OFF. */
  getTts(): boolean;
  setTts(on: boolean): boolean;
  /** ElevenLabs cloud voice on/off — orthogonal to tts_enabled (speaks or not);
   * this picks WHICH voice. Persisted, default OFF. */
  getElevenlabs(): boolean;
  setElevenlabs(on: boolean): boolean;
  /** Auto-send (submit dictation on stt.final, no "Alfred enviar"): read/toggle, persisted, default OFF. */
  getAutosend(): boolean;
  setAutosend(on: boolean): boolean;
  /**
   * Widget JS (run tier-2 widgets' own JavaScript via the alfred-widget:// custom
   * protocol, sandboxed + no network): read/toggle, persisted, default OFF. OFF =
   * the declarative srcdoc + hash-pinned runtime; ON = the model's inline JS runs.
   */
  getWidgetScripts(): boolean;
  setWidgetScripts(on: boolean): boolean;
  /** Voice input (push-to-talk): spawn/stop the native STT helper; streams stt.partial/stt.final. */
  startListening(): void;
  stopListening(): void;
  /** Wake word ("Alfred", always-on): read/toggle, persisted. Default: on if the STT binary exists. */
  getWakeword(): boolean;
  setWakeword(on: boolean): boolean;
  /** Live wake-listener state (listening/suppressed/failed/stopped/disabled), read on mount so the button isn't blind at boot. */
  getWakeStatus(): { status: WakeStatus; reason?: string };
  /** Live MCP bridge endpoint for the claude-code brain, or null (not started / disabled). */
  getMcpEndpoint(): { url: string; token: string } | null;
  /** Tear down the MCP bridge (release the port). */
  shutdownMcp(): Promise<void>;
  // ── Scheduled jobs (Phase 4) ──
  /** Every persisted scheduled job (management card / stage 3). */
  listJobs(): Job[];
  /** Pending sensitive-action approvals for unattended agent jobs (all jobs, or one). */
  listPendingApprovals(jobId?: string): JobApproval[];
  /** Resolve a queued job approval; approve EXECUTES the stored action through normal governance. */
  resolveJobApproval(id: string, approved: boolean): Promise<JobApproval | undefined>;
  /** One job by id (management card detail / refresh after a mutation). */
  getJob(id: string): Job | undefined;
  /** Pause a job (disable + disarm its timer); the card can resume it later. */
  pauseJob(id: string): Job | undefined;
  /** Resume a paused job: re-enable, clear any pausedReason, re-arm the timer. */
  resumeJob(id: string): Job | undefined;
  /** Delete a job (+ its runs/approvals) and disarm its timer. */
  deleteJob(id: string): void;
  /** Stop the in-app job scheduler (clears its timers) on shutdown. */
  stopScheduler(): void;
}

export function createOrchestrator(opts: CreateOrchestratorOpts): OrchestratorHandle {
  const { config, db } = opts;
  const sessionId = randomUUID();

  // Single persistence choke point: every chat.message (assistant, from either
  // brain path) is stored before it streams to the UI. A failed write must not
  // break the turn.
  const emit = (event: StreamEvent): void => {
    if (event.kind === 'chat.message') {
      try {
        insertMessage(db, event.message);
      } catch (err) {
        console.error('[alfred] persist message failed:', err instanceof Error ? err.message : err);
      }
      // Speak assistant replies when voice output is on (covers both brain
      // paths — this is the single point every chat.message flows through).
      if (event.message.role === 'assistant' && getSetting(db, 'tts_enabled') === '1') {
        tts.speak(event.message.content);
      }
    }
    opts.emit(event);
  };

  // Mirror the TTS speaking state to the UI (mic-silenced indicator) AND reflect
  // it in the wake state (listening⇄suppressed) so the WAKE button shows "muted
  // (speaking)" — the wake path is muted in main while this is true (see wakeEmit).
  tts.onSpeaking((isSpeaking) => {
    emit({ kind: 'speaking', sessionId, speaking: isSpeaking });
    wakeword.noteSpeaking(isSpeaking);
  });

  // Persisted approval controls (Phase B): DANGEROUS mode + auto-approve rules.
  const readRules = (): string[] => {
    const raw = getSetting(db, 'auto_approve');
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const isDangerous = (): boolean => getSetting(db, 'dangerous_mode') === '1';

  const gov = createGovernance({
    sessionId,
    emit,
    store: {
      isDangerous,
      rules: readRules,
      rememberRule(key) {
        const rules = readRules();
        if (!rules.includes(key)) setSetting(db, 'auto_approve', JSON.stringify([...rules, key]));
      },
    },
  });
  const browser = createBrowserHandle(join(opts.dataDir, 'browser-profile'));

  const ctx: ToolCtx = {
    sessionId,
    workspace: config.workspace,
    db,
    governance: gov.governance,
    secrets: createSecrets(),
    browser,
    emit,
    sendUi: (payload) => emit({ kind: 'ui.render', payload }),
  };

  void ensureScaffold(config.workspace).catch(() => {});

  // MCP bridge: expose Alfred's tools to the claude-code brain (`claude -p`) with
  // full governance. Starts async (fire-and-forget); claudeSpawn reads the live
  // endpoint when it spawns. Never throws — null just means "no bridge", the
  // fallback. Gated by ALFRED_MCP_BRIDGE (default on).
  let mcpBridge: McpBridgeHandle | null = null;
  void startMcpBridge(tools, ctx)
    .then((h) => {
      mcpBridge = h;
    })
    .catch((err) => {
      console.error('[alfred] MCP bridge start rejected:', err instanceof Error ? err.message : err);
    });

  // ── Wake word ("Alfred", always-on) ────────────────────────────────────────
  // Default: enabled when the native STT binary exists (needs no account). The
  // kill switch suppresses it until the user re-arms it (manual mic or toggle),
  // so no audio is captured after an emergency stop.
  let wakeSuppressed = false;
  const wakeEnabled = (): boolean => {
    const raw = getSetting(db, 'wakeword_enabled');
    if (raw === undefined) return wakeword.isWakeAvailable();
    return raw === '1';
  };
  const startWake = (): void => {
    if (wakeSuppressed || !wakeEnabled()) return;
    wakeword.startWakeword(wakeEmit, sessionId);
  };

  // Wake commands: a {final} from the wake helper is first checked for an ACTION
  // intent (esconder/mostrar/enviar). Only 'dictate' falls through to fill the
  // input (the existing behaviour); everything else is consumed here.
  // The wake words the helper listens for — resolved once (env is fixed per boot);
  // reused for barge-in detection so the list isn't duplicated (mirrors the helper).
  const wakeWords = wakeword.resolveWakeWords();
  const wakeEmit = (e: StreamEvent): void => {
    const speaking = tts.isSpeaking();
    // Barge-in: while Alfred speaks, a wake detection is EITHER the user cutting in
    // OR the echo of Alfred saying his own name ("Olá, sou o Alfred…"). If the line
    // he is speaking NOW does not contain the wake word it's the user → stop him and
    // capture the command; if it does, it's his own voice → drop it so he never
    // self-interrupts his greeting.
    if (speaking && e.kind === 'wake.detected') {
      const hasWake = wakeword.speechContainsWake(tts.currentSpeechText(), wakeWords);
      if (wakeword.shouldBargeIn(e, speaking, hasWake)) {
        tts.stop(); // stop TTS + unmute now (no tail) so the command isn't suppressed
        console.info('[alfred] wake barge-in — user interrupted TTS');
        emit({ ...e, bargeIn: true }); // renderer enters listening + logs the interruption
        return;
      }
      return; // his own-name echo → drop, don't self-interrupt
    }
    // Half-duplex anti-echo: partials/finals while speaking are his own voice.
    if (wakeword.suppressWhileSpeaking(e, speaking)) return;
    if (e.kind === 'stt.final' && handleVoiceIntent(e.text)) return;
    emit(e);
  };
  function handleVoiceIntent(transcript: string): boolean {
    const intent = wakeword.parseVoiceIntent(transcript);
    switch (intent.kind) {
      case 'hide':
        opts.windowControl?.hide();
        emit({ kind: 'voice.command', sessionId, action: 'hide' });
        return true;
      case 'show':
        opts.windowControl?.show();
        emit({ kind: 'voice.command', sessionId, action: 'show' });
        return true;
      case 'send': {
        const body = intent.text?.trim() ?? '';
        // Text after "enviar" → a new turn straight away. Bare "enviar" → let the
        // renderer submit whatever is already in the input (the last dictation).
        emit({ kind: 'voice.command', sessionId, action: 'send', text: body || undefined });
        if (body) void send(body);
        return true;
      }
      default:
        return false; // dictate → stt.final flows through, fills the input
    }
  }

  let active: Orchestrator | null = null;
  // Aborts whatever turn is really running, whichever provider — the AI-SDK
  // Orchestrator OR the `claude -p` child. Kill/reset/factory-reset call this so
  // no provider leaves a zombie turn running after the queue is cleared.
  let activeAbort: (() => void) | null = null;

  // ── Single-flight turn serialisation (FIFO) ─────────────────────────────────
  // A message arriving mid-turn must NOT start a second parallel turn (shared
  // mutable state: gov trifecta, ctx/tools/DB, the emit stream, and — worst — two
  // `claude -p --resume <same session>` corrupting continuity). Every entry point
  // (IPC send, wake "enviar", auto-send) routes through send() → enqueue → drain
  // one at a time.
  const turnQueue: string[] = [];
  let draining = false;

  // ── Curator (memory organiser) — runs on IDLE after a task, debounced ───────
  // Never mid-task: send() awaits the turn, then schedules; a new turn clears the
  // pending timer. `curating` guards against overlap; the run itself is a no-op
  // when the inbox is empty and respects the daily token kill-switch.
  let curating = false;
  let curatorTimer: ReturnType<typeof setTimeout> | null = null;
  const curatorDeps = () => {
    // The curator agent's config wins when explicitly set; otherwise runCurator
    // falls back to ALFRED_CURATOR_MODEL, then the cheapest enabled brain.
    const raw = getSetting(db, 'agent_config');
    const curatorSpec = hasPersistedAgent(raw, 'curator') ? agentToSpec(getAgentConfig().curator) : undefined;
    return {
      db,
      workspace: config.workspace,
      sessionId,
      dailyTokenBudget: config.dailyTokenBudget,
      stepCap: config.stepCap,
      dailyUsdBudget: config.dailyUsdBudget,
      env: process.env,
      curatorSpec,
    };
  };
  async function runCuratorNow(): Promise<ReturnType<typeof runCurator> | void> {
    if (curating) return;
    curating = true;
    try {
      return await runCurator(curatorDeps());
    } catch (err) {
      console.error('[alfred] curator run failed:', err instanceof Error ? err.message : err);
    } finally {
      curating = false;
    }
  }
  function scheduleCurator(): void {
    if (curatorTimer) clearTimeout(curatorTimer);
    curatorTimer = setTimeout(() => {
      curatorTimer = null;
      // Only spend a model call when there is something queued.
      void listInbox(config.workspace)
        .then((items) => {
          if (items.length && !active) void runCuratorNow();
        })
        .catch(() => {});
    }, 4000);
  }

  // Read-only budget view for the startup cost snapshot (turn accounting lives
  // in each turn's own tracker; this only READS the shared SQLite tables).
  const costTracker = new BudgetTracker(
    db,
    { dailyLimit: config.dailyTokenBudget, stepCap: config.stepCap, dailyUsdBudget: config.dailyUsdBudget },
    sessionId,
  );

  const queryAccounts = (): AccountRecord[] =>
    db
      .prepare(
        'SELECT id, provider, email, secret_ref AS secretRef, connected_at AS connectedAt FROM accounts ORDER BY connected_at DESC',
      )
      .all() as AccountRecord[];

  /** Inject a known project's context when the prompt names one (ICM routing). */
  async function projectContext(text: string): Promise<string | undefined> {
    const lower = text.toLowerCase();
    const hit = listProjects(db).find((p) => lower.includes(p.slug) || lower.includes(p.name.toLowerCase()));
    if (!hit) return undefined;
    const detail = await getProject(db, config.workspace, hit.slug);
    if (!detail) return undefined;
    const m = detail.manifest;
    return [
      `${m.name} (${m.slug}) — ${m.stack}, status ${m.status}`,
      `Path: ${m.path}`,
      m.summary ? `Summary: ${m.summary}` : '',
      detail.files.length ? `Files:\n${detail.files.map((f) => `  ${f}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ── per-agent config (main chat / reference / curator) ──────────────────────
  // Single source of truth: the 'agent_config' setting (JSON). The main agent is
  // the primary brain; the BRAINS panel + active_brain reconcile THROUGH it (see
  // getActiveBrain/setActiveBrain below). Defaults derive from ALFRED_PROVIDER
  // and — for a smooth upgrade — the pre-existing persisted active_brain choice.
  const mainAgentDefault = (): AgentConfig => {
    const brainId = resolveActiveBrainId(getSetting(db, 'active_brain'), process.env, listBrains()) ?? 'anthropic';
    const provider = brainToProvider(brainId);
    return { name: DEFAULT_MAIN_NAME, provider, model: DEFAULT_MODEL[provider] };
  };
  const getAgentConfig = (): AgentConfigMap => parseAgentConfig(getSetting(db, 'agent_config'), mainAgentDefault());
  const setAgentConfig = (id: AgentId, patch: Partial<AgentConfig>): AgentConfigMap => {
    const cur = getAgentConfig();
    const next: AgentConfigMap = { ...cur, [id]: coerceAgent({ ...cur[id], ...patch }, cur[id]) };
    setSetting(db, 'agent_config', JSON.stringify(next));
    return next;
  };

  /**
   * claude-code conversational turn: run `claude -p` with session continuity.
   * Claude Code drives its own tools; no Alfred tools, no per-turn HITL. Cost is
   * external (subscription), so the COST panel is flagged external, not estimated.
   */
  async function runClaudeTurn(text: string, model?: string, signal?: AbortSignal): Promise<void> {
    emit({ kind: 'agent.status', sessionId, status: 'thinking' });
    // claude -p reads the CLAUDE.md of its cwd (the workspace) automatically —
    // seed it with Alfred's identity so the vanilla CLI knows it's Alfred.
    // Seed the workspace CLAUDE.md with identity + the capability manifest, so the
    // vanilla CLI (whose cwd is the workspace) gets the same L1 layer Alfred does.
    await ensureClaudeMd(config.workspace, `${ALFRED_IDENTITY}\n\n${CAPABILITY_MANIFEST}`).catch((err) => {
      console.error('[alfred] ensure workspace CLAUDE.md failed:', err instanceof Error ? err.message : err);
    });
    // Stable per-workspace key (not the per-boot sessionId) so --resume picks up
    // the last conversation after Alfred restarts.
    const key = 'claude_session:default';
    const resumeId = getSetting(db, key);
    // On a cold start (no resume id yet) seed the prompt with recent history so
    // continuity survives even the first turn; --resume carries it thereafter.
    const prompt = resumeId ? text : withHistoryPreamble(db, text);
    // DANGEROUS mode wires through to `claude -p`: skip its own permission
    // prompts + append a preamble so the brain never asks for confirmation.
    // The chosen Anthropic model (agent_config.main) is passed as --model.
    const turn = await spawnClaudeConversation(prompt, config.workspace, isDangerous(), resumeId, model, signal);

    // User kill/reset: the child was SIGKILLed → clean halt, not a red error
    // (parity with the AI-SDK path's abort handling).
    if (signal?.aborted) {
      emit({ kind: 'agent.status', sessionId, status: 'done' });
      return;
    }
    if (turn.enoent) {
      emit({
        kind: 'error',
        sessionId,
        message: 'Claude Code CLI not found on PATH. Install it: npm i -g @anthropic-ai/claude-code',
      });
      emit({ kind: 'agent.status', sessionId, status: 'error' });
      return;
    }
    if (turn.error) {
      emit({ kind: 'error', sessionId, message: turn.error });
      emit({ kind: 'agent.status', sessionId, status: 'error' });
      return;
    }
    if (turn.sessionId) {
      try {
        setSetting(db, key, turn.sessionId);
      } catch (err) {
        console.error('[alfred] persist claude session failed:', err instanceof Error ? err.message : err);
      }
    }
    const content = turn.result ?? '';
    if (content.trim()) {
      emit({ kind: 'chat.delta', sessionId, text: content });
      emit({
        kind: 'chat.message',
        message: { id: randomUUID(), sessionId, role: 'assistant', content, ts: Date.now() },
      });
    }
    // Spend is billed by the Claude Code subscription, not Alfred's estimator.
    emit({ kind: 'cost', snapshot: externalCostSnapshot(config.dailyTokenBudget, model) });
    emit({ kind: 'agent.status', sessionId, status: 'done' });
  }

  // The single turn entry point: IPC `alfred:send` and the wake "enviar <text>"
  // command both route through here. A function declaration so the wake handler
  // (defined above) can call it.
  // One drained turn: the body of the old send(). resetTrifecta lives HERE, at
  // the start of every turn — a per-turn reset, never mid-turn from a sibling.
  async function runTurn(text: string): Promise<void> {
      gov.resetTrifecta();
      try {
        const main = getAgentConfig().main;
        const brains = listBrains();

        // claude-cli → the `claude -p` spawn path (the "second Claude"), with the
        // chosen Anthropic model. claude-api/openai/deepseek → the AI SDK.
        if (main.provider === 'claude-cli') {
          const cc = brains.find((b) => b.id === 'claude-code');
          if (!cc?.enabled) {
            emit({
              kind: 'error',
              sessionId,
              message: 'Claude Code CLI not found on PATH. Install it: npm i -g @anthropic-ai/claude-code',
            });
            emit({ kind: 'agent.status', sessionId, status: 'error' });
            return;
          }
          const ac = new AbortController();
          activeAbort = () => ac.abort();
          await runClaudeTurn(text, main.model, ac.signal);
          return;
        }

        const brainId = providerToBrain(main.provider);
        const brain = brains.find((b) => b.id === brainId);
        if (!brain?.enabled) {
          emit({
            kind: 'error',
            sessionId,
            message:
              `Brain "${brainId}" (agent "main") is not connected: set its API key in .env ` +
              '(ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY) or pick a connected provider in Settings, then restart.',
          });
          emit({ kind: 'agent.status', sessionId, status: 'error' });
          return;
        }

        let provider: ReturnType<typeof resolveProvider>;
        try {
          // brainId is enabled and the model comes from the catalog → no noisy fallback.
          provider = resolveProvider(agentToSpec(main));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error('[alfred] cannot start turn:', detail);
          emit({
            kind: 'error',
            sessionId,
            message: `No brain connected: set an API key in .env (ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY) and restart. (${detail})`,
          });
          emit({ kind: 'agent.status', sessionId, status: 'error' });
          return;
        }
        active = new Orchestrator({
          config,
          ctx,
          tools,
          model: provider.languageModel,
          brainId: provider.id,
          modelId: provider.model,
          brainLabel: `${provider.id}:${provider.model}`,
          projectContext: await projectContext(text),
        });
        activeAbort = () => active?.abort();
        await active.run(text);
      } finally {
        active = null;
        activeAbort = null;
      }
  }

  async function send(text: string): Promise<void> {
    // A new turn cancels a pending curator sweep — never organise mid-task.
    if (curatorTimer) {
      clearTimeout(curatorTimer);
      curatorTimer = null;
    }
    // Persist the user turn immediately so it survives restarts, feeds the
    // continuity transcript, and appears in order. The renderer shows it
    // optimistically, so it is stored (not re-emitted) to avoid a duplicate.
    if (text.trim()) {
      try {
        insertMessage(db, { id: randomUUID(), sessionId, role: 'user', content: text, ts: Date.now() });
      } catch (err) {
        console.error('[alfred] persist user message failed:', err instanceof Error ? err.message : err);
      }
    }
    // Enqueue. If a drain is already running, this turn waits its FIFO turn.
    const { dropped } = enqueueTurn(turnQueue, text);
    if (dropped !== null) {
      console.warn(`[alfred] turn queue over cap — dropped oldest pending turn (queue runaway?): ${dropped.slice(0, 80)}`);
    }
    if (draining) return;

    draining = true;
    try {
      // Single-flight: one turn at a time, in order. A failed turn is logged and
      // the drain continues — one bad turn never strands the rest of the queue.
      while (turnQueue.length) {
        const next = turnQueue.shift()!;
        try {
          await runTurn(next);
        } catch (err) {
          console.error('[alfred] turn failed:', err instanceof Error ? err.message : err);
        }
      }
    } finally {
      draining = false;
      scheduleCurator();
    }
  }

  // ── Scheduled-jobs engine (Phase 4) ─────────────────────────────────────────
  // Owned here because the AGENT runner needs the governed ToolCtx + tool
  // registry + brain resolution that only exist in this scope. Re-arms persisted
  // jobs on boot; timers are .unref()'d so it never holds the process open.
  const scheduler = new JobScheduler(db, {
    emit,
    agent: {
      ctx,
      tools,
      dailyTokenBudget: config.dailyTokenBudget,
      stepCap: config.stepCap,
      dailyUsdBudget: config.dailyUsdBudget,
      agentSpec: () => agentToSpec(getAgentConfig().main),
      dangerous: isDangerous,
      notify: opts.notify,
      env: process.env,
    },
  });
  scheduler.start();

  // Sync the ElevenLabs voice override from its persisted toggle at boot (tts.ts
  // has no DB, so the engine override lives here).
  tts.setEngineOverride(getSetting(db, 'elevenlabs_enabled') === '1' ? 'elevenlabs' : null);

  // Arm the wake listener at startup when enabled (no-op without the binary).
  startWake();

  return {
    send,
    async runCurator() {
      return runCuratorNow();
    },
    getGraph() {
      return buildVaultGraph(config.workspace, listProjects(db));
    },
    getNote(ref) {
      return readNotePreview(config.workspace, ref);
    },
    async askReference(req) {
      // Isolated side-thread: uses the reference agent's config; never the main
      // brain's session/history. emit is the same sink but reference.* is not
      // persisted (only chat.message is — see the emit choke point above).
      return runReferenceTurn(
        {
          db,
          workspace: config.workspace,
          sessionId,
          dailyTokenBudget: config.dailyTokenBudget,
          stepCap: config.stepCap,
          dailyUsdBudget: config.dailyUsdBudget,
          reference: getAgentConfig().reference,
          emit,
          env: process.env,
        },
        req,
      );
    },
    getHistory(limit) {
      return getRecentMessages(db, limit ?? 100) as ChatMessage[];
    },
    stop() {
      activeAbort?.(); // abort the live turn — AI-SDK stream OR the claude -p child
      turnQueue.length = 0; // drop pending turns — a kill switch means stop, not "finish the queue"
      tts.stop();
      // Kill switch also silences every mic owner — no audio capture after an
      // emergency stop. wakeSuppressed keeps wake from auto-restarting on the
      // stt.final that stopping the manual session emits.
      wakeSuppressed = true;
      wakeword.stopWakeword();
      stt.stopListening();
    },
    resolveApproval({ id, decision, remember }) {
      gov.resolveApproval(id, decision, remember);
    },
    getDangerousMode() {
      return isDangerous();
    },
    setDangerousMode(on) {
      setSetting(db, 'dangerous_mode', on ? '1' : '0');
      return isDangerous();
    },
    getSpawnPaused() {
      return getSetting(db, 'spawn_paused') === '1';
    },
    setSpawnPaused(on) {
      setSetting(db, 'spawn_paused', on ? '1' : '0');
      return on;
    },
    getGrillMe() {
      return grillMeEnabled(getSetting(db, 'grill_me_enabled'));
    },
    setGrillMe(on) {
      setSetting(db, 'grill_me_enabled', on ? '1' : '0');
      return grillMeEnabled(getSetting(db, 'grill_me_enabled'));
    },
    resetApprovals() {
      setSetting(db, 'auto_approve', '[]');
    },
    resetConversation() {
      activeAbort?.(); // abort the live turn — AI-SDK stream OR the claude -p child
      turnQueue.length = 0; // no queued turns should run against a wiped conversation
      // Clear the persisted chat + the claude-code --resume ids so the next turn
      // starts a fresh session. Memory / facts / projects are untouched.
      try {
        db.prepare('DELETE FROM messages').run();
        db.prepare("DELETE FROM settings WHERE key LIKE 'claude_session:%'").run();
      } catch (err) {
        console.error('[alfred] reset conversation failed:', err instanceof Error ? err.message : err);
      }
      emit({ kind: 'conversation.reset', sessionId });
    },
    factoryResetInfo() {
      const count = (sql: string): number => {
        try {
          return (db.prepare(sql).get() as { n: number }).n;
        } catch {
          return 0;
        }
      };
      const [memory, projectsDir, browserProfile] = factoryResetPaths(config.workspace, opts.dataDir);
      return {
        paths: [
          { label: 'Memória (journal, factos, notas, mapas, inbox, index, preferences, house-rules)', path: memory },
          { label: 'Projetos (ficheiros criados pelo Alfred)', path: projectsDir },
          { label: 'Perfil do browser (logins/cookies)', path: browserProfile },
        ],
        dbPath: join(opts.dataDir, 'alfred.db'),
        counts: {
          messages: count('SELECT COUNT(*) AS n FROM messages'),
          projects: count('SELECT COUNT(*) AS n FROM projects'),
          accounts: count('SELECT COUNT(*) AS n FROM accounts'),
          secrets: count('SELECT COUNT(*) AS n FROM accounts'),
        },
      };
    },
    async factoryReset() {
      const log = (label: string, err: unknown): void =>
        console.error(`[alfred] factory reset — ${label} failed:`, err instanceof Error ? err.message : err);

      // 1. Halt everything that owns a resource: the running turn, TTS, the mic
      //    (wake + manual), the browser and the MCP bridge. Best-effort each.
      activeAbort?.(); // abort the live turn — AI-SDK stream OR the claude -p child
      turnQueue.length = 0; // no queued turns should run against a factory-reset state
      tts.stop();
      scheduler.stop(); // disarm all job timers so no autonomous job fires/re-arms after the wipe
      wakeSuppressed = true;
      try {
        wakeword.stopWakeword();
      } catch (err) {
        log('stop wakeword', err);
      }
      try {
        stt.stopListening();
      } catch (err) {
        log('stop stt', err);
      }
      await browser.close().catch((err) => log('close browser', err));
      await mcpBridge?.shutdown().catch((err) => log('shutdown mcp', err));
      mcpBridge = null;

      // 2. Delete Keychain secrets (service "alfred"). Read the refs BEFORE the
      //    accounts table is cleared. delete() throws off-macOS → caught per key.
      for (const acc of queryAccounts()) {
        await ctx.secrets.delete(acc.secretRef).catch((err) => log(`delete secret ${acc.secretRef}`, err));
      }

      // 3. Clear every DB table (factory-empty), scheduled jobs + their run log
      //    and approval queue included, so no autonomous task survives. The
      //    file/handle stays valid — the whole app holds this handle, so wiping
      //    rows is the robust reset. `db.exec` runs the batch in one call.
      try {
        db.exec(
          factoryResetTables()
            .map((t) => `DELETE FROM ${t};`)
            .join(''),
        );
      } catch (err) {
        log('clear database', err);
      }

      // 4. Remove the on-disk paths — CONFINED to workspace + data dir (reset.ts).
      for (const p of factoryResetPaths(config.workspace, opts.dataDir)) {
        await rm(p, { recursive: true, force: true }).catch((err) => log(`remove ${p}`, err));
      }

      // 5. Re-seed an empty memory scaffold so the app boots clean, not broken.
      await ensureScaffold(config.workspace).catch((err) => log('ensure scaffold', err));

      // 6. Tell the UI to reload into the blank factory state.
      emit({ kind: 'factory.reset.done', sessionId });
    },
    listProjects() {
      return listProjects(db);
    },
    listAccounts() {
      return queryAccounts();
    },
    listBrains() {
      return listBrains();
    },
    getActiveBrain() {
      // Derived from the main agent's provider so the BRAINS panel highlight and
      // the settings card never disagree.
      return providerToBrain(getAgentConfig().main.provider);
    },
    setActiveBrain(id) {
      const brain = listBrains().find((b) => b.id === id);
      if (!brain?.enabled) return providerToBrain(getAgentConfig().main.provider);
      const provider = brainToProvider(id);
      const cur = getAgentConfig().main;
      // Switching provider from the BRAINS panel snaps the model to that
      // provider's default; re-selecting the same provider keeps the model.
      const model = provider === cur.provider ? cur.model : DEFAULT_MODEL[provider];
      setAgentConfig('main', { provider, model });
      setSetting(db, 'active_brain', id); // keep the legacy key roughly in step
      return id;
    },
    getAgentConfig() {
      return getAgentConfig();
    },
    setAgentConfig(id, patch) {
      const next = setAgentConfig(id, patch);
      // Keep the legacy active_brain aligned when the main provider changes.
      if (id === 'main') setSetting(db, 'active_brain', providerToBrain(next.main.provider));
      return next;
    },
    getModelCatalog() {
      return MODEL_CATALOG;
    },
    async connectGmail() {
      const gmailTool = tools.find((t) => t.name === 'gmail');
      if (!gmailTool) return null;
      const out = await gmailTool.execute({ op: 'connect' }, ctx);
      // Surface the tool error (e.g. "Gmail não configurado…") so the IPC guard
      // emits it as a UI alert instead of a silent null.
      if (!out.ok) throw new Error(out.error ?? 'Gmail connect failed');
      const email = (out.result as { email?: string } | undefined)?.email;
      return queryAccounts().find((a) => a.email === email) ?? null;
    },
    getLayout() {
      return readLayout(db);
    },
    updateCard(id, patch) {
      const cards = writeCard(db, id, patch);
      emit({ kind: 'layout', cards });
      return cards;
    },
    setViewport(w, h) {
      setSetting(db, 'viewport', `${Math.round(w)}x${Math.round(h)}`);
    },
    getCost() {
      const main = getAgentConfig().main;
      // claude-cli spend is external (subscription) — mirror the turn-path shape.
      if (main.provider === 'claude-cli') return externalCostSnapshot(config.dailyTokenBudget, main.model);
      return costTracker.costSnapshot(providerToBrain(main.provider), main.model);
    },
    getTts() {
      return getSetting(db, 'tts_enabled') === '1';
    },
    setTts(on) {
      setSetting(db, 'tts_enabled', on ? '1' : '0');
      if (!on) tts.stop(); // silence anything mid-utterance immediately
      return on;
    },
    getElevenlabs() {
      return getSetting(db, 'elevenlabs_enabled') === '1';
    },
    setElevenlabs(on) {
      setSetting(db, 'elevenlabs_enabled', on ? '1' : '0');
      tts.setEngineOverride(on ? 'elevenlabs' : null);
      tts.stop(); // switch voice cleanly — drop anything mid-utterance
      return on;
    },
    getAutosend() {
      return getSetting(db, 'autosend_enabled') === '1';
    },
    setAutosend(on) {
      setSetting(db, 'autosend_enabled', on ? '1' : '0');
      return on;
    },
    getWidgetScripts() {
      return getSetting(db, 'widget_scripts_enabled') === '1';
    },
    setWidgetScripts(on) {
      setSetting(db, 'widget_scripts_enabled', on ? '1' : '0');
      return on;
    },
    startListening() {
      // Barge-in: pressing the mic while Alfred speaks is a deliberate interrupt —
      // silence him and listen (tts.stop() is a no-op when he isn't speaking).
      tts.stop();
      // Single mic owner: free the wake listener, run the manual session, then
      // restart wake when that session ends (its own stt.final flows through the
      // wrapped emit below — the wake helper's finals do not, so no double-start).
      wakeSuppressed = false;
      wakeword.stopWakeword();
      stt.startListening((e) => {
        emit(e);
        if (e.kind === 'stt.final') startWake();
      }, sessionId);
    },
    stopListening() {
      stt.stopListening();
    },
    getWakeword() {
      return wakeEnabled();
    },
    setWakeword(on) {
      setSetting(db, 'wakeword_enabled', on ? '1' : '0');
      if (on) {
        wakeSuppressed = false;
        startWake();
      } else {
        wakeword.stopWakeword();
      }
      return wakeEnabled();
    },
    getWakeStatus() {
      return wakeword.getWakeState();
    },
    getMcpEndpoint() {
      return mcpBridge?.endpoint ?? null;
    },
    async shutdownMcp() {
      await mcpBridge?.shutdown();
      mcpBridge = null;
    },
    listJobs() {
      return listJobs(db);
    },
    listPendingApprovals(jobId) {
      return listPendingApprovals(db, jobId);
    },
    resolveJobApproval(id, approved) {
      // Approve executes the stored tool+args through NORMAL governance (the user
      // is present now): the real ctx, the real tool registry, system notify.
      return resolveJobApprovalDb(db, id, approved, { ctx, tools, notify: opts.notify });
    },
    getJob(id) {
      return getJobDb(db, id);
    },
    pauseJob(id) {
      // Pause = disable; reschedule() won't arm a disabled job (disarms it now).
      const cur = getJobDb(db, id);
      if (!cur) return undefined;
      const updated = updateJobDb(db, id, { enabled: false });
      scheduler.reschedule(id);
      return updated;
    },
    resumeJob(id) {
      // Resume = re-enable + clear any pausedReason (budget/error/approval) and the
      // stale nextRunTs so reschedule() recomputes a fresh fire time and re-arms.
      const cur = getJobDb(db, id);
      if (!cur) return undefined;
      const updated = updateJobDb(db, id, {
        enabled: true,
        runtime: { ...cur.runtime, pausedReason: null, nextRunTs: undefined },
      });
      scheduler.reschedule(id);
      return updated;
    },
    deleteJob(id) {
      deleteJobDb(db, id);
      scheduler.reschedule(id); // gone → disarms
    },
    stopScheduler() {
      scheduler.stop();
    },
  };
}
