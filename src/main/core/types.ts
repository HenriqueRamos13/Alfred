/**
 * Alfred — shared type contract.
 *
 * This file is the single source of truth imported by every other module.
 * Rules that matter for the test harness:
 *   - NO TS `enum` and NO `namespace` here (union types + `const` objects only),
 *     so that pure-logic files can be run with `node --experimental-strip-types`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema (Anthropic tools format — a pragmatic subset)
// ─────────────────────────────────────────────────────────────────────────────

export interface JSONSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance / risk
// ─────────────────────────────────────────────────────────────────────────────

/** T0 autopilot · T1 reversible · T2 verify (HITL) · T3 human-mandatory (HITL). */
export type RiskTier = 'T0' | 'T1' | 'T2' | 'T3';

export const RiskTiers = {
  T0: 'T0',
  T1: 'T1',
  T2: 'T2',
  T3: 'T3',
} as const satisfies Record<RiskTier, RiskTier>;

/** Tiers that require a human approval before the tool runs. */
export const HITL_TIERS: readonly RiskTier[] = ['T2', 'T3'];

/** Per-session data-flow flags (trifecta-lite). */
export interface TrifectaFlags {
  /** Read web/email/other untrusted content this session. */
  readUntrusted: boolean;
  /** Session touched private/sensitive data. */
  hasPrivate: boolean;
  /** A tool capable of sending data outward is about to run / has run. */
  canEgress: boolean;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  tier: RiskTier;
  reason: string;
  createdAt: number;
}

export type ApprovalDecision = 'approve' | 'deny';

export interface ApprovalResolution {
  id: string;
  decision: ApprovalDecision;
  /** True when the decision came from the fail-safe timeout (treated as deny). */
  timedOut?: boolean;
  /** Provenance when auto-resolved without a prompt (e.g. "auto (rule)", "auto (dangerous mode)"). */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget / kill-switch
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetState {
  /** YYYY-MM-DD (local) this counter belongs to. */
  day: string;
  dailyTokens: number;
  dailyLimit: number;
  sessionTokens: number;
  /** Steps consumed by the current task. */
  steps: number;
  stepCap: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost visibility (estimated USD — the hard cap is still tokens; see budget.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  /** Estimated USD. */
  usd: number;
}

export interface ModelCost extends CostTotals {
  model: string;
  /** True when no price is on file for this model (its usd is 0, not real). */
  unknownPrice: boolean;
}

export interface CostSnapshot {
  /** Brain id currently driving (e.g. 'anthropic'). */
  activeBrain: string;
  /** Model id currently driving (e.g. 'claude-sonnet-5'). */
  activeModel: string;
  day: string;
  today: CostTotals;
  session: CostTotals;
  /** Per-model breakdown for today (all sessions). */
  byModel: ModelCost[];
  /** Hard token kill-switch for the day (from budget). */
  dailyTokenCap: number;
  /** Soft USD budget (ALFRED_DAILY_USD_BUDGET); undefined when unset. */
  dailyUsdBudget?: number;
  /** True when today's estimated USD passed the soft budget (warning only). */
  overUsdBudget: boolean;
  /** True when the active brain's spend is billed externally (claude-code): no US$ estimate. */
  external?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

export type AuditStatus = 'ok' | 'error' | 'denied' | 'blocked';

export interface AuditEntry {
  id?: number;
  sessionId: string;
  ts: number;
  toolName: string;
  /** Secret values MUST be masked before persisting. */
  args: unknown;
  tier: RiskTier;
  status: AuditStatus;
  result?: unknown;
  error?: string;
  durationMs?: number;
  /** Approval provenance when the call ran without a human prompt (e.g. "auto (rule)", "auto (dangerous mode)"). */
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generative UI
// ─────────────────────────────────────────────────────────────────────────────

export interface UiNode {
  component: string;
  props?: Record<string, unknown>;
  children?: UiNode[];
}

export interface RenderUiPayload {
  /** Named surface region; renderer decides default when omitted. */
  target?: string;
  tree: UiNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating card layout (canvas of widgets). Geometry + visibility persist in
// SQLite; `title` is a fixed per-card label supplied by the layout module.
// ─────────────────────────────────────────────────────────────────────────────

export interface CardLayout {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  visible: boolean;
  /**
   * Which display this card lives on: a concrete `display.id` (as a string), or
   * the sentinel `'main'` (follow the primary display) / `'all'` (mirror on
   * every display). x/y are relative to that display's overlay window.
   */
  displayId: string;
}

/** Fields a drag/resize or the AI may patch on a card. */
export type CardPatch = Partial<Pick<CardLayout, 'x' | 'y' | 'w' | 'h' | 'z' | 'visible' | 'displayId'>>;

/** A physical display the overlay can span, exposed to the renderer for the "move to next monitor" control. */
export interface DisplayInfo {
  id: string;
  label: string;
  primary: boolean;
}

/** A rectangle in DIPs (Electron's Display bounds/workArea shape). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A physical display with its coordinate spaces (DIPs), exposed to the
 * `ui_layout` tool so the AI can see every monitor and move cards between them.
 * `workArea` excludes the menu bar / dock; `bounds` is the full display.
 */
export interface DisplayGeom extends DisplayInfo {
  bounds: Rect;
  workArea: Rect;
}

/** Components the AI may render via render_ui (whitelist enforced in the registry). */
export const AI_COMPONENTS = [
  'Panel',
  'StatTile',
  'Card',
  'DataTable',
  'Markdown',
  'LogFeed',
  'AgentStatus',
  'ProjectList',
] as const;
export type AiComponent = (typeof AI_COMPONENTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled jobs (Phase 4) — persisted, in-app scheduler; see
// tasks/PHASE4-SCHEDULED-JOBS-PROMPT.md. Pure logic lives in jobs-pure.ts;
// persistence + the timer engine in jobs.ts (both take Database by param).
// ─────────────────────────────────────────────────────────────────────────────

export type JobKind = 'fetch' | 'agent';

/**
 * A job's autonomy grant is an allowlist of coarse capabilities (default:
 * read + notify). Sensitive capabilities (send/money/delete/secrets) never sit
 * in a normal grant — they are gated separately (isSensitiveAction) and always
 * queue an approval for unattended jobs.
 */
export type Capability = 'read' | 'notify' | 'write' | 'browse' | 'shell' | 'send' | 'delete' | 'money' | 'secrets';

export type JobSchedule =
  | { type: 'interval'; everyMs: number }
  | { type: 'daily'; at: string /* HH:MM, local */ };

export type JobPausedReason = 'budget' | 'approval' | 'error' | null;

/** `fetch` job: a cheap code-level HTTP pull on a timer (zero AI tokens). */
export interface JobSource {
  url: string;
  method?: 'GET';
  headers?: Record<string, string>;
  /** jsonpath-ish / template selecting the card value from the response. */
  extract?: string;
}

export interface JobRender {
  tier: 1 | 2 | 3;
  /** builtin card id | 'html' | 'project'. */
  card: string;
  /** tier-2 only: the self-contained page the model wrote (wrapped in a sandboxed iframe). */
  html?: string;
}

export interface JobPlacement {
  displayId?: number;
  corner?: 'tl' | 'tr' | 'bl' | 'br';
}

/** Mutable per-job runtime state, persisted so the scheduler survives restart. */
export interface JobRuntime {
  lastRunTs?: number;
  nextRunTs?: number;
  lastResult?: unknown;
  tokensToday?: number;
  /** YYYY-MM-DD the tokensToday counter belongs to (for the daily reset). */
  tokensDay?: string;
  pausedReason?: JobPausedReason;
}

export interface Job {
  id: string;
  title: string;
  kind: JobKind;
  schedule: JobSchedule;
  // fetch:
  source?: JobSource;
  // agent:
  prompt?: string;
  grant?: Capability[];
  tokenBudgetDaily?: number;
  // render:
  render: JobRender;
  placement?: JobPlacement;
  enabled: boolean;
  runtime: JobRuntime;
}

/** Append-only run-log row. */
export interface JobRun {
  id: string;
  jobId: string;
  ts: number;
  ok: boolean;
  tokens: number;
  summary?: string;
  error?: string;
}

/**
 * A sensitive tool call an unattended agent job wanted to run, parked for the
 * user to approve/deny (§3.1). Approving executes the stored tool+args through
 * normal governance (the human is present now).
 */
export interface JobApproval {
  id: string;
  jobId: string;
  ts: number;
  toolName: string;
  /** Tool args, secret-KEYED fields masked (content preserved for re-execution). */
  args: unknown;
  status: 'pending' | 'approved' | 'denied';
  resolvedTs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat / streaming
// ─────────────────────────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** Set on tool-result messages. */
  toolName?: string;
  toolUseId?: string;
}

/** Events streamed from main → renderer over IPC (activity log + chat). */
export type StreamEvent =
  | { kind: 'chat.delta'; sessionId: string; text: string }
  | { kind: 'chat.message'; message: ChatMessage }
  // Reference agent — an ISOLATED side-thread over one note/node. Scoped by
  // threadId so it never mixes with the main chat.* stream and is never persisted.
  | { kind: 'reference.delta'; threadId: string; text: string }
  | { kind: 'reference.message'; threadId: string; message: ChatMessage }
  | { kind: 'reference.done'; threadId: string }
  | { kind: 'reference.error'; threadId: string; message: string }
  | { kind: 'stt.partial'; sessionId: string; text: string }
  | { kind: 'stt.final'; sessionId: string; text: string }
  // bargeIn: this detection interrupted Alfred's own speech (the user cut in),
  // so main stopped the TTS — the UI logs it as an interruption, not a plain wake.
  | { kind: 'wake.detected'; sessionId: string; bargeIn?: boolean }
  // Wake listener lifecycle, so the UI can show at a glance WHY it is (not)
  // hearing you: listening (armed) · suppressed (muted while Alfred speaks) ·
  // failed (helper crashed — reason + auto-retry) · stopped (killed) · disabled
  // (no STT helper / toggled off).
  | { kind: 'wake.status'; sessionId: string; status: WakeStatus; reason?: string }
  // A wake command was recognised as an ACTION (not dictation). hide/show are
  // already applied in main; 'send' with no text asks the renderer to submit the
  // current input; text (when present) is what was sent, for the log.
  | { kind: 'voice.command'; sessionId: string; action: 'hide' | 'show' | 'send'; text?: string }
  // Alfred started/stopped speaking (TTS). While true the wake path is muted
  // (half-duplex) so the UI shows the mic as silenced.
  | { kind: 'speaking'; sessionId: string; speaking: boolean }
  | { kind: 'tool.start'; sessionId: string; toolName: string; args: unknown; tier: RiskTier }
  | { kind: 'tool.end'; sessionId: string; toolName: string; status: AuditStatus; error?: string }
  | { kind: 'approval.request'; request: ApprovalRequest }
  | { kind: 'approval.resolved'; resolution: ApprovalResolution }
  | { kind: 'ui.render'; payload: RenderUiPayload }
  | { kind: 'layout'; cards: CardLayout[] }
  | { kind: 'agent.status'; sessionId: string; status: AgentStatus }
  | { kind: 'budget'; state: BudgetState }
  | { kind: 'cost'; snapshot: CostSnapshot }
  // A fetch job refreshed its value (stage 2). Stage-3 data cards listen for
  // this; for now it is just emitted alongside the persisted runtime.lastResult.
  | { kind: 'job.data'; jobId: string; title: string; value: unknown; ts: number }
  // An unattended agent job's sensitive action was queued for approval, or a
  // queued approval was resolved. Stage 3 renders the pending list + buttons.
  | { kind: 'job.approval'; action: 'created' | 'resolved'; approval: JobApproval }
  // The main conversation was reset: the UI clears the chat (every window).
  | { kind: 'conversation.reset'; sessionId: string }
  // A factory reset completed: the UI reloads to a blank factory state.
  | { kind: 'factory.reset.done'; sessionId: string }
  | { kind: 'error'; sessionId: string; message: string };

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'awaiting-approval' | 'error' | 'done';

/** Explicit wake-listener state, surfaced to the UI (see the wake.status event). */
export type WakeStatus = 'listening' | 'suppressed' | 'failed' | 'stopped' | 'disabled';

// ─────────────────────────────────────────────────────────────────────────────
// Projects (ICM folder-as-context)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectManifest {
  name: string;
  slug: string;
  path: string;
  stack: string;
  status: string;
  summary: string;
  created: string;
  keyFiles: string[];
  decisions: string[];
}

/** Row in the sqlite `projects` index (manifest is canonical, this is the index). */
export interface ProjectRecord {
  slug: string;
  name: string;
  path: string;
  summary: string;
  updated: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts (Gmail)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountRecord {
  id: string;
  provider: 'gmail';
  email: string;
  /** Keychain service/key ref; the token itself lives in the OS keychain. */
  secretRef: string;
  connectedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets (macOS Keychain)
// ─────────────────────────────────────────────────────────────────────────────

export interface Secrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance surface exposed to tools
// ─────────────────────────────────────────────────────────────────────────────

export interface Governance {
  classify(toolName: string, args: unknown): RiskTier;
  /** Blocks until approve/deny; timeout resolves as deny. */
  requestApproval(req: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalResolution>;
  markTrifecta(flags: Partial<TrifectaFlags>): void;
  trifecta(): TrifectaFlags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool contract
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/** Lazy Playwright handle; created only when a browser tool first needs it. */
export interface BrowserHandle {
  /** Returns the shared persistent page, launching the context on first use. */
  page(): Promise<import('playwright').Page>;
  close(): Promise<void>;
}

export interface ToolCtx {
  sessionId: string;
  workspace: string;
  db: import('better-sqlite3').Database;
  governance: Governance;
  secrets: Secrets;
  browser: BrowserHandle;
  /** Stream an activity/log event to the UI. */
  emit(event: StreamEvent): void;
  /** Push a generative-UI tree to the renderer. */
  sendUi(payload: RenderUiPayload): void;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(args: A, ctx: ToolCtx): Promise<ToolResult>;
  /** Per-call risk override; falls back to classifyAction(name, args) when absent. */
  risk?: (args: A) => RiskTier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface AlfredConfig {
  anthropicApiKey: string;
  /** Default brain id ('anthropic' | 'openai' | 'deepseek'), from ALFRED_PROVIDER. */
  provider: string;
  model: string;
  workspace: string;
  dailyTokenBudget: number;
  /** Soft daily USD warning threshold (ALFRED_DAILY_USD_BUDGET); does not block. */
  dailyUsdBudget?: number;
  stepCap: number;
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
}
