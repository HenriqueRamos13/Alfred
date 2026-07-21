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
import { execFile } from 'node:child_process';
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
import { ensureScaffold, readStable } from './memory.ts';
import { createSecrets } from './secrets.ts';
import { getProject, listProjects } from './projects.ts';
import { resolveProvider, listBrains, resolveActiveBrainId } from './providers.ts';
import type { BrainInfo } from './providers.ts';
import { getSetting, setSetting } from './db.ts';
import { dayKey } from './budget.ts';
import { tools, createBrowserHandle } from '../tools/index.ts';

type AlfredDb = import('better-sqlite3').Database;

const ALFRED_IDENTITY = `You are Alfred, a personal Agent OS running natively on the user's Mac. You
operate the real machine on their behalf and render your own control-centre UI.
You are calm, precise and discreet — a trusted operator, not a chatbot. Act
autonomously within your remit; stop to ask only when governance requires an
approval or when genuinely blocked. Your name is Alfred, always — never "Jarvis".

Governance you must respect:
- Every tool call is risk-tiered. T0 (read/search/list) and T1 (reversible
  workspace writes) run freely; T2 (delete/send/install/egress/delegation) and
  T3 (money/credentials) require the human's approval, which the host enforces.
- You can delegate a self-contained autonomous task to a full Claude Code agent
  via delegate_to_claude_code (headless \`claude -p\`); it needs approval.
- Never print, echo, or log secret values — mask them.
- Honour the token budget and step caps; if a task starts looping, stop and
  report rather than repeating.
Organise substantial work as projects under the workspace (ICM
folder-as-context); render live status into the surface with render_ui using
only the whitelisted components.`;

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
    let sys = ALFRED_IDENTITY;
    const mem = await readStable(this.deps.ctx.workspace).catch(() => '');
    if (mem.trim()) sys += `\n\n# Stable memory (honour these)\n${mem}`;
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

    if (needApproval) {
      ctx.emit({ kind: 'agent.status', sessionId: ctx.sessionId, status: 'awaiting-approval' });
      const resolution = await ctx.governance.requestApproval({
        sessionId: ctx.sessionId,
        toolName: t.name,
        args: maskSecrets(args),
        tier,
        reason,
      });
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
      });
      ctx.emit({ kind: 'tool.end', sessionId: ctx.sessionId, toolName: t.name, status, error: out.error });
      return out.ok ? out.result ?? {} : { error: out.error };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.audit({ toolName: t.name, args, tier, status: 'error', error, durationMs: Date.now() - started });
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

function spawnClaudeConversation(prompt: string, cwd: string, resumeId?: string): Promise<ClaudeTurn> {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (resumeId) args.push('--resume', resumeId);
  return new Promise((resolve) => {
    execFile(
      'claude',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        if ((e as { code?: string } | null)?.code === 'ENOENT') return resolve({ enoent: true });
        if (e && typeof e.code === 'number' && e.code !== 0) {
          return resolve({ error: `claude -p exited ${e.code}: ${(stderr || stdout || '').trim()}` });
        }
        try {
          const parsed = JSON.parse(stdout) as { session_id?: string; result?: string };
          resolve({ sessionId: parsed.session_id, result: parsed.result ?? stdout.trim() });
        } catch {
          resolve({ result: (stdout || '').trim() });
        }
      },
    );
  });
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
  stop(): void;
  resolveApproval(resolution: { id: string; decision: ApprovalDecision }): void;
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
}

export function createOrchestrator(opts: CreateOrchestratorOpts): OrchestratorHandle {
  const { config, db, emit } = opts;
  const sessionId = randomUUID();

  const gov = createGovernance({ sessionId, emit });
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

  let active: Orchestrator | null = null;

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
    const key = `claude_session:${sessionId}`;
    const resumeId = getSetting(db, key);
    const turn = await spawnClaudeConversation(text, config.workspace, resumeId);

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

  return {
    async send(text) {
      gov.resetTrifecta();
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
    },
    stop() {
      active?.abort();
    },
    resolveApproval({ id, decision }) {
      gov.resolveApproval(id, decision);
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
  };
}
