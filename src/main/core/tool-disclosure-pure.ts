/**
 * Progressive tool disclosure — PURE helpers (no node:* / native deps, so they
 * run under `node --experimental-strip-types` and are unit-tested in
 * test/logic.test.ts).
 *
 * Problem: every tool description + schema ships on EVERY model call. With the
 * Phase-5 roster + MCP tools the tool array bloats and every call pays for it in
 * tokens. Fix: keep a small CORE set always visible; when the DEFERRABLE tools'
 * definitions would exceed a token budget, hide them behind 3 bridge tools
 * (tool_search / tool_describe / tool_call). The catalog is rebuilt STATELESS on
 * every assembly — no per-session state that could drift.
 *
 * This file holds only the decisions (defer-or-not, catalog search, bridge-call
 * resolution) + two cross-cutting pure helpers folded into Stage 1: the
 * cross-provider schema sanitizer and the check_fn availability-cache decision.
 * The stateful wiring (wrapping as AI-SDK tools, running the governed path) lives
 * in orchestrator.ts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tool metadata (the pure view of a Tool — name + description + schema + core?)
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: unknown;
  /** True for the always-loaded CORE set; core tools never defer. */
  core?: boolean;
}

/** Bridge tool names — reserved, injected only in deferred mode. */
export const BRIDGE_TOOL_NAMES = ['tool_search', 'tool_describe', 'tool_call'] as const;
export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];

/** Default context window (tokens) when the model's real window is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Default fraction of the context window the deferrable defs may occupy before deferring. */
export const DEFAULT_THRESHOLD_RATIO = 0.12;
/** Rough chars→tokens divisor (~4 chars/token). Deliberately crude; only a budget gate. */
const CHARS_PER_TOKEN = 4;

export interface DisclosureBudget {
  /** Model context window in tokens (defaults to DEFAULT_CONTEXT_WINDOW). */
  contextWindow?: number;
  /** Fraction of the window the deferrable defs may occupy (defaults to DEFAULT_THRESHOLD_RATIO). */
  thresholdRatio?: number;
  /** Absolute token cap; when set it WINS over contextWindow*ratio (a configurable hard cap). */
  maxTokens?: number;
}

export interface DisclosurePlan {
  /** True when deferrable tools are hidden behind the 3 bridge tools. */
  defer: boolean;
  coreNames: string[];
  /** Non-core tools; hidden behind the bridge when `defer`, otherwise exposed directly. */
  deferrableNames: string[];
  /** Estimated tokens of the deferrable tool definitions. */
  deferrableTokens: number;
  /** The token threshold that (didn't) trip the defer. */
  thresholdTokens: number;
}

/** Estimate the token cost of one tool's model-visible definition (name + description + schema). */
export function estimateToolTokens(t: ToolMeta): number {
  const chars = t.name.length + t.description.length + JSON.stringify(t.inputSchema ?? {}).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The token budget the deferrable defs must stay under to be exposed directly. */
export function disclosureThreshold(budget: DisclosureBudget = {}): number {
  if (typeof budget.maxTokens === 'number') return Math.max(0, budget.maxTokens);
  const window = budget.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const ratio = budget.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  return Math.floor(window * ratio);
}

/**
 * Decide whether to defer. Core tools are ALWAYS exposed and never counted
 * against the budget; deferring hides only the deferrable (non-core) tools behind
 * the bridge. Stateless: derived purely from the tools + budget on every call.
 */
export function shouldDefer(tools: ToolMeta[], budget: DisclosureBudget = {}): DisclosurePlan {
  const coreNames: string[] = [];
  const deferrableNames: string[] = [];
  let deferrableTokens = 0;
  for (const t of tools) {
    if (t.core) {
      coreNames.push(t.name);
    } else {
      deferrableNames.push(t.name);
      deferrableTokens += estimateToolTokens(t);
    }
  }
  const thresholdTokens = disclosureThreshold(budget);
  // Nothing to defer → never defer (no point injecting bridge tools for nothing).
  const defer = deferrableNames.length > 0 && deferrableTokens > thresholdTokens;
  return { defer, coreNames, deferrableNames, deferrableTokens, thresholdTokens };
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog — a light index of the deferred tools, searchable via tool_search.
// Rebuilt STATELESS from the live tool list on every assembly.
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogEntry {
  name: string;
  /** First-sentence / truncated summary of the tool description. */
  summary: string;
}

/** Max chars of description kept in a catalog summary (keeps tool_search cheap). */
const SUMMARY_MAX = 160;

/** One-line summary of a description: first sentence (·/newline/period), clamped. */
export function toolSummary(description: string, max: number = SUMMARY_MAX): string {
  const firstLine = description.split(/\n|(?<=\.)\s|·/)[0]?.trim() ?? '';
  const base = firstLine || description.trim();
  return base.length > max ? base.slice(0, max - 1).trimEnd() + '…' : base;
}

/** Build the deferred-tool catalog (name + summary), skipping core + bridge names. */
export function buildCatalog(tools: ToolMeta[]): CatalogEntry[] {
  return tools
    .filter((t) => !t.core && !(BRIDGE_TOOL_NAMES as readonly string[]).includes(t.name))
    .map((t) => ({ name: t.name, summary: toolSummary(t.description) }));
}

function queryTokens(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Search the catalog for tools matching a free-text query. Scores by how many
 * query terms appear in the name (weighted) or summary; returns matches ranked
 * best-first. Empty/whitespace query → the whole catalog (a "list everything"
 * escape hatch). No match → [].
 */
export function searchCatalog(catalog: CatalogEntry[], query: string): CatalogEntry[] {
  const terms = queryTokens(query ?? '');
  if (terms.length === 0) return [...catalog];
  const scored = catalog.map((e) => {
    const name = e.name.toLowerCase();
    const summary = e.summary.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 2;
      if (summary.includes(term)) score += 1;
    }
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.e);
}

/**
 * Resolve a bridge tool_call to a real, SESSION-AVAILABLE tool by name. Returns
 * `{ tool }` or `{ error }`. Scoped to the tools actually present this session, so
 * the model can only reach what it would have reached directly — governance then
 * runs identically on the resolved tool (the caller routes it through the same
 * governed path). A bridge name is never callable through the bridge.
 */
export function resolveBridgeCall<T extends ToolMeta>(
  tools: T[],
  name: unknown,
): { tool: T } | { error: string } {
  if (typeof name !== 'string' || !name.trim()) return { error: 'tool_call: "name" is required.' };
  if ((BRIDGE_TOOL_NAMES as readonly string[]).includes(name)) {
    return { error: `tool_call: "${name}" is a bridge tool and cannot be called through the bridge.` };
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: `tool_call: unknown tool "${name}" (not available this session).` };
  return { tool };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-provider schema sanitizer (cross-cutting, folded into Stage 1).
// Normalises a JSON Schema so strict backends (Anthropic) don't 400 on MCP-style
// schemas: collapse nullable anyOf/oneOf, drop $ref siblings, fix bare/empty
// object types. Pure — clones, never mutates the input.
// ─────────────────────────────────────────────────────────────────────────────

type SchemaObj = Record<string, unknown>;

function isPlainObject(v: unknown): v is SchemaObj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively sanitize a JSON schema for strict tool backends. */
export function sanitizeToolSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  let node: SchemaObj = { ...schema };

  // 1. $ref with siblings: a $ref node's siblings are ignored by JSON-Schema and
  //    rejected by strict backends. Keep ONLY the $ref.
  if (typeof node.$ref === 'string' && Object.keys(node).length > 1) {
    return { $ref: node.$ref };
  }

  // 2. Nullable anyOf/oneOf: partition the branches into null vs the rest. One
  //    non-null branch → collapse into this node (merging sibling keys). Many →
  //    keep an anyOf of the sanitized non-null branches (null dropped).
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      const rest = branches.filter((b) => !(isPlainObject(b) && b.type === 'null'));
      const { [key]: _dropped, ...siblings } = node;
      if (rest.length === 1 && isPlainObject(rest[0])) {
        node = { ...siblings, ...(sanitizeToolSchema(rest[0]) as SchemaObj) };
      } else if (rest.length >= 1) {
        node = { ...siblings, anyOf: rest.map((b) => sanitizeToolSchema(b)) };
      } else {
        // All branches were null → a plain nullable; fall back to a bare null type.
        node = { ...siblings, type: 'null' };
      }
    }
  }

  // Recurse into nested schema-bearing keywords.
  if (isPlainObject(node.properties)) {
    const props: SchemaObj = {};
    for (const [k, v] of Object.entries(node.properties)) props[k] = sanitizeToolSchema(v);
    node.properties = props;
  }
  if (node.items !== undefined) {
    node.items = Array.isArray(node.items)
      ? node.items.map((i) => sanitizeToolSchema(i))
      : sanitizeToolSchema(node.items);
  }
  if (isPlainObject(node.additionalProperties)) {
    node.additionalProperties = sanitizeToolSchema(node.additionalProperties);
  }
  for (const key of ['allOf'] as const) {
    if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map((b) => sanitizeToolSchema(b));
  }

  // 3. Bare/empty object types. A node with `properties` but no `type` → object.
  //    An object type with no `properties` → give it an empty object (strict
  //    backends want the key present). A fully bare `{}` → an empty object schema.
  if (node.properties !== undefined && node.type === undefined) node.type = 'object';
  if (node.type === 'object' && node.properties === undefined) node.properties = {};
  if (Object.keys(node).length === 0) return { type: 'object', properties: {} };

  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// check_fn availability cache (cross-cutting, folded into Stage 1).
// A tool MAY carry a check_fn probe (e.g. "is Gmail connected / browser up").
// Probing on every assembly is wasteful and flaky, so we cache with a TTL and a
// transient-failure GRACE window: a probe that FAILS shortly after a SUCCESS
// serves the last-good value instead of yanking the tool on a trembling probe.
// This file holds the DECISION (fresh vs re-probe, and how to reconcile a fresh
// probe result); no tool ships a check_fn yet, so the mechanism is wired as a
// no-op until one does (see orchestrator.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const PROBE_TTL_MS = 30_000;
/** After a success, a failing probe within this window still serves last-good. */
export const PROBE_GRACE_MS = 60_000;

export interface ProbeEntry {
  /** The value last SERVED to callers (may be last-good, not the raw last probe). */
  available: boolean;
  /** Last time the probe actually returned `true`. */
  lastOkTs?: number;
  /** Last time we actually ran the probe. */
  probedTs: number;
}

export interface CheckCacheOpts {
  ttlMs?: number;
  graceMs?: number;
}

/** Is the cached probe value still fresh (within TTL), so we can skip re-probing? */
export function isProbeFresh(entry: ProbeEntry | undefined, now: number, opts: CheckCacheOpts = {}): boolean {
  if (!entry) return false;
  const ttl = opts.ttlMs ?? PROBE_TTL_MS;
  return now - entry.probedTs < ttl;
}

/**
 * Reconcile a FRESH probe result into a new cache entry, applying the grace
 * window. A `true` probe is served as-is and refreshes lastOkTs. A `false` probe
 * within `graceMs` of the last success is treated as transient → serve last-good
 * (`available: true`) while still recording that we probed (probedTs advances,
 * lastOkTs does NOT — so the grace window keeps shrinking and eventually expires).
 */
export function reconcileProbe(
  prev: ProbeEntry | undefined,
  probed: boolean,
  now: number,
  opts: CheckCacheOpts = {},
): ProbeEntry {
  if (probed) return { available: true, lastOkTs: now, probedTs: now };
  const grace = opts.graceMs ?? PROBE_GRACE_MS;
  const withinGrace = prev?.lastOkTs !== undefined && now - prev.lastOkTs <= grace;
  return { available: withinGrace, lastOkTs: prev?.lastOkTs, probedTs: now };
}
