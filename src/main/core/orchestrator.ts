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
import { join } from 'node:path';
import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import type { LanguageModel, ToolSet } from 'ai';
import { HITL_TIERS } from './types.ts';
import type {
  AccountRecord,
  AlfredConfig,
  ApprovalDecision,
  AuditEntry,
  CardLayout,
  CardPatch,
  ChatMessage,
  CostSnapshot,
  ProjectRecord,
  RiskTier,
  StreamEvent,
  Tool,
  ToolCtx,
} from './types.ts';
import { getLayout as readLayout, updateCard as writeCard } from './layout.ts';
import { BudgetTracker, callSignature, isLoop, isOverDailyBudget } from './budget.ts';
import {
  classifyAction,
  createGovernance,
  isEgressTool,
  maskSecrets,
  recordAudit,
  trifectaImpact,
} from './governance.ts';
import { ensureClaudeMd, ensureScaffold, readStable, recentMemoryText, formatTranscript, readIndex, listInbox } from './memory.ts';
import { CAPABILITY_MANIFEST } from './manifest.ts';
import { runCurator } from './curator.ts';
import { createSecrets } from './secrets.ts';
import { getProject, listProjects } from './projects.ts';
import { resolveProvider, listBrains, resolveActiveBrainId } from './providers.ts';
import type { BrainInfo } from './providers.ts';
import { getSetting, setSetting, insertMessage, getRecentMessages } from './db.ts';
import { dayKey } from './budget.ts';
import { spawnClaudeCli } from './claudeSpawn.ts';
import * as tts from './tts.ts';
import * as stt from './stt.ts';
import * as wakeword from './wakeword.ts';
import { tools, createBrowserHandle } from '../tools/index.ts';

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

  /** Wrap every registry Tool as an AI-SDK tool; governance runs inside execute. */
  private buildTools(): ToolSet {
    const set: ToolSet = {};
    for (const t of this.deps.tools) {
      set[t.name] = tool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema(t.inputSchema as any),
        execute: (args: unknown) => this.runTool(t, args),
      });
    }
    return set;
  }

  private async buildSystem(): Promise<string> {
    const { ctx } = this.deps;
    // L1 always-loaded layer: identity + the thin capability manifest (index of
    // everything Alfred can do + routing + pointers). The detailed docs it names
    // (docs/**, skills/**) are L2 — referenced, never loaded by default.
    let sys = `${ALFRED_IDENTITY}\n\n${CAPABILITY_MANIFEST}`;
    // Read per-turn so toggling the button takes effect on the next turn.
    if (getSetting(ctx.db, 'dangerous_mode') === '1') {
      sys +=
        '\n\nDANGEROUS MODE is ON: all approvals are bypassed — never ask for permission or confirmation, just execute.';
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
    const { ctx } = this.deps;

    // Loop detection — hard-stop the whole task, not just this call.
    const sig = callSignature(t.name, args);
    if (isLoop(this.history, sig)) {
      this.hardStop({ kind: 'loop', message: `Loop detected: "${t.name}" called with identical args >3 times.` });
      return { error: 'Loop detected — task halted.' };
    }
    this.history.push(sig);

    const tier: RiskTier = t.risk?.(args) ?? classifyAction(t.name, args);

    // Trifecta-lite: reading web/email marks untrusted/private; an egress tool
    // that would complete the trifecta is escalated to a mandatory approval.
    ctx.governance.markTrifecta(trifectaImpact(t.name));
    let needApproval = HITL_TIERS.includes(tier);
    let reason = `Risk tier ${tier}`;
    if (isEgressTool(t.name)) {
      const tf = ctx.governance.trifecta();
      if (tf.readUntrusted && tf.hasPrivate) {
        ctx.governance.markTrifecta({ canEgress: true });
        needApproval = true;
        reason = 'Trifecta: untrusted read + private data + egress in one session';
      }
    }

    ctx.emit({ kind: 'tool.start', sessionId: ctx.sessionId, toolName: t.name, args: maskSecrets(args), tier });

    // Provenance persisted in the audit when the call ran without a human prompt
    // (auto-approve rule or DANGEROUS mode) — so the forensic trail shows the bypass.
    let approvalNote: string | undefined;
    if (needApproval) {
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'awaiting-approval' });
      const resolution = await ctx.governance.requestApproval({
        sessionId: ctx.sessionId,
        toolName: t.name,
        args: maskSecrets(args),
        tier,
        reason,
      });
      approvalNote = resolution.note;
      if (resolution.decision === 'deny') {
        this.audit({
          toolName: t.name,
          args,
          tier,
          status: 'denied',
          error: resolution.timedOut ? 'approval timed out' : 'denied by user',
        });
        ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'denied' });
        ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'thinking' });
        return { error: resolution.timedOut ? 'Approval timed out (treated as deny).' : 'Denied by the human.' };
      }
    }
    ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'tool' });

    const started = Date.now();
    try {
      const out = await t.execute(args, ctx);
      const status = out.ok ? 'ok' : 'error';
      this.audit({
        toolName: t.name,
        args,
        tier,
        status,
        result: out.ok ? out.result : undefined,
        error: out.error,
        durationMs: Date.now() - started,
        note: approvalNote,
      });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status, error: out.error });
      return out.ok ? out.result ?? {} : { error: out.error };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.audit({ toolName: t.name, args, tier, status: 'error', error, durationMs: Date.now() - started, note: approvalNote });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status: 'error', error });
      return { error };
    }
  }

  private audit(e: Omit<AuditEntry, 'sessionId' | 'ts'>): void {
    // Never let an audit write failure crash a turn — log and continue.
    try {
      recordAudit(this.deps.ctx.db, { ...e, sessionId: this.deps.ctx.sessionId, ts: Date.now() });
    } catch (err) {
      console.error('[alfred] audit write failed:', err instanceof Error ? err.message : err);
    }
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

async function spawnClaudeConversation(prompt: string, cwd: string, resumeId?: string): Promise<ClaudeTurn> {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (resumeId) args.push('--resume', resumeId);
  const out = await spawnClaudeCli(args, { cwd });
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
  /** Clear all persisted auto-approve rules ("ask again next time"). */
  resetApprovals(): void;
  /** Manually run the memory curator (drain inbox → notes, rebuild MOCs/backlinks). */
  runCurator(): Promise<unknown>;
  listProjects(): ProjectRecord[];
  listAccounts(): AccountRecord[];
  /** Brain availability (enabled/disabled) for the UI. */
  listBrains(): BrainInfo[];
  /** The effective active brain id (resolved: persisted → env → first enabled). */
  getActiveBrain(): string | null;
  /** Persist the active brain (only if it exists and is enabled); returns the new effective id. */
  setActiveBrain(id: string): string | null;
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
  /** Voice input (push-to-talk): spawn/stop the native STT helper; streams stt.partial/stt.final. */
  startListening(): void;
  stopListening(): void;
  /** Wake word ("Alfred", always-on): read/toggle, persisted. Default: on if the STT binary exists. */
  getWakeword(): boolean;
  setWakeword(on: boolean): boolean;
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
    wakeword.startWakeword(emit, sessionId);
  };

  let active: Orchestrator | null = null;

  // ── Curator (memory organiser) — runs on IDLE after a task, debounced ───────
  // Never mid-task: send() awaits the turn, then schedules; a new turn clears the
  // pending timer. `curating` guards against overlap; the run itself is a no-op
  // when the inbox is empty and respects the daily token kill-switch.
  let curating = false;
  let curatorTimer: ReturnType<typeof setTimeout> | null = null;
  const curatorDeps = () => ({
    db,
    workspace: config.workspace,
    sessionId,
    dailyTokenBudget: config.dailyTokenBudget,
    stepCap: config.stepCap,
    dailyUsdBudget: config.dailyUsdBudget,
    env: process.env,
  });
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

  /** Resolve the effective active brain id from persisted settings + env. */
  const activeBrainId = (): string | null =>
    resolveActiveBrainId(getSetting(db, 'active_brain'), process.env, listBrains());

  /**
   * claude-code conversational turn: run `claude -p` with session continuity.
   * Claude Code drives its own tools; no Alfred tools, no per-turn HITL. Cost is
   * external (subscription), so the COST panel is flagged external, not estimated.
   */
  async function runClaudeTurn(text: string): Promise<void> {
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
    const turn = await spawnClaudeConversation(prompt, config.workspace, resumeId);

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
    emit({
      kind: 'cost',
      snapshot: {
        activeBrain: 'claude-code',
        activeModel: 'claude -p',
        day: dayKey(),
        today: { inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 },
        session: { inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 },
        byModel: [],
        dailyTokenCap: config.dailyTokenBudget,
        overUsdBudget: false,
        external: true,
      },
    });
    emit({ kind: 'agent.status', sessionId, status: 'done' });
  }

  // Arm the wake listener at startup when enabled (no-op without the binary).
  startWake();

  return {
    async send(text) {
      gov.resetTrifecta();
      // A new turn cancels a pending curator sweep — never organise mid-task.
      if (curatorTimer) {
        clearTimeout(curatorTimer);
        curatorTimer = null;
      }
      // Persist the user turn before routing so it survives restarts and feeds
      // the continuity transcript. The renderer shows it optimistically, so it
      // is stored (not re-emitted) to avoid a duplicate bubble in-session.
      if (text.trim()) {
        try {
          insertMessage(db, { id: randomUUID(), sessionId, role: 'user', content: text, ts: Date.now() });
        } catch (err) {
          console.error('[alfred] persist user message failed:', err instanceof Error ? err.message : err);
        }
      }
      try {
        const brainId = activeBrainId();
        if (!brainId) {
          emit({
            kind: 'error',
            sessionId,
            message:
              'No brain connected: set an API key in .env (ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY) or install the Claude Code CLI, then restart.',
          });
          emit({ kind: 'agent.status', sessionId, status: 'error' });
          return;
        }

        if (brainId === 'claude-code') {
          await runClaudeTurn(text);
          return;
        }

        let provider: ReturnType<typeof resolveProvider>;
        try {
          // brainId is already resolved to an enabled API brain → no noisy fallback.
          provider = resolveProvider(brainId);
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
        await active.run(text);
      } finally {
        // Turn over → free the busy flag and schedule an idle curator sweep.
        active = null;
        scheduleCurator();
      }
    },
    async runCurator() {
      return runCuratorNow();
    },
    getHistory(limit) {
      return getRecentMessages(db, limit ?? 100) as ChatMessage[];
    },
    stop() {
      active?.abort();
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
    resetApprovals() {
      setSetting(db, 'auto_approve', '[]');
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
      return activeBrainId();
    },
    setActiveBrain(id) {
      const brain = listBrains().find((b) => b.id === id);
      if (brain?.enabled) setSetting(db, 'active_brain', id);
      return activeBrainId();
    },
    async connectGmail() {
      const gmailTool = tools.find((t) => t.name === 'gmail');
      if (!gmailTool) return null;
      const out = await gmailTool.execute({ op: 'connect' }, ctx);
      if (!out.ok) return null;
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
      const brainId = activeBrainId();
      // claude-code spend is external (subscription) — mirror the turn-path shape.
      if (brainId === 'claude-code') {
        return {
          activeBrain: 'claude-code',
          activeModel: 'claude -p',
          day: dayKey(),
          today: { inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 },
          session: { inputTokens: 0, outputTokens: 0, tokens: 0, usd: 0 },
          byModel: [],
          dailyTokenCap: config.dailyTokenBudget,
          overUsdBudget: false,
          external: true,
        };
      }
      const brain = listBrains().find((b) => b.id === brainId);
      return costTracker.costSnapshot(brainId ?? '—', brain?.model ?? '—');
    },
    getTts() {
      return getSetting(db, 'tts_enabled') === '1';
    },
    setTts(on) {
      setSetting(db, 'tts_enabled', on ? '1' : '0');
      if (!on) tts.stop(); // silence anything mid-utterance immediately
      return on;
    },
    startListening() {
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
  };
}
