/**
 * Hardcoded model catalog + per-agent configuration logic.
 *
 * PURE + strip-types-safe: this module value-imports NOTHING from node or the AI
 * SDK, so the renderer (settings card) and test/logic.test.ts can import it
 * directly. The orchestrator (core, node side) supplies the env-derived main
 * default; everything here is data + total functions.
 *
 * Two "Claudes": the Anthropic list is SHARED by two providers that differ only
 * in the execution path — "claude-api" runs it through the Vercel AI SDK
 * (ANTHROPIC_API_KEY), "claude-cli" spawns `claude -p --model <id>` (subscription
 * auth). Same model ids, different transport.
 *
 * Prices are USD per 1,000,000 tokens, researched 2026-07. Always ESTIMATES —
 * providers change these and caching/batch discounts apply.
 */

export type ProviderId = 'claude-api' | 'claude-cli' | 'openai' | 'deepseek';
export const PROVIDER_IDS: readonly ProviderId[] = ['claude-api', 'claude-cli', 'openai', 'deepseek'];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-api': 'Claude (API)',
  'claude-cli': 'Claude (CLI)',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
};

export interface CatalogModel {
  id: string;
  name: string;
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  notes?: string;
}

// Anthropic list — SHARED by claude-api (SDK) and claude-cli (spawn): same ids.
const ANTHROPIC_MODELS: CatalogModel[] = [
  { id: 'claude-fable-5', name: 'Fable 5', inputPerM: 10, outputPerM: 50 },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', inputPerM: 5, outputPerM: 25 },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    inputPerM: 2,
    outputPerM: 10,
    notes: 'Intro pricing ($2/$10) until 2026-08-31; rises to $3/$15 on 2026-09-01.',
  },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', inputPerM: 1, outputPerM: 5 },
  { id: 'claude-opus-4-7', name: 'Opus 4.7 (legacy)', inputPerM: 5, outputPerM: 25 },
  { id: 'claude-opus-4-6', name: 'Opus 4.6 (legacy)', inputPerM: 5, outputPerM: 25 },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6 (legacy)', inputPerM: 3, outputPerM: 15 },
  { id: 'claude-opus-4-5', name: 'Opus 4.5 (legacy)', inputPerM: 5, outputPerM: 25 },
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5 (legacy)', inputPerM: 3, outputPerM: 15 },
];

const OPENAI_MODELS: CatalogModel[] = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', inputPerM: 5, outputPerM: 30 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', inputPerM: 2.5, outputPerM: 15 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', inputPerM: 1, outputPerM: 6 },
  { id: 'gpt-5.5', name: 'GPT-5.5', inputPerM: 5, outputPerM: 30 },
  { id: 'gpt-5.4', name: 'GPT-5.4', inputPerM: 2.5, outputPerM: 15 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', inputPerM: 0.75, outputPerM: 4.5 },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', inputPerM: 0.2, outputPerM: 1.25 },
];

const DEEPSEEK_MODELS: CatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputPerM: 0.14, outputPerM: 0.28 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputPerM: 0.435, outputPerM: 0.87 },
];

/** The catalog by provider. claude-api and claude-cli intentionally share the Anthropic list. */
export const MODEL_CATALOG: Record<ProviderId, CatalogModel[]> = {
  'claude-api': ANTHROPIC_MODELS,
  'claude-cli': ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
};

/** Per-provider default model (main → sonnet-5; the cheap agents → deepseek flash). */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  'claude-api': 'claude-sonnet-5',
  'claude-cli': 'claude-sonnet-5',
  openai: 'gpt-5.6-terra',
  deepseek: 'deepseek-v4-flash',
};

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

export function listModels(provider: ProviderId): CatalogModel[] {
  return MODEL_CATALOG[provider] ?? [];
}

export function findModel(provider: ProviderId, id: string): CatalogModel | undefined {
  return listModels(provider).find((m) => m.id === id);
}

export function priceOf(provider: ProviderId, id: string): { inputPerM: number; outputPerM: number } | undefined {
  const m = findModel(provider, id);
  return m ? { inputPerM: m.inputPerM, outputPerM: m.outputPerM } : undefined;
}

/**
 * Flat {modelId → price} across every provider, for the cost estimator. Anthropic
 * ids dedupe (identical under both claude providers). Pure — merged into
 * pricing.ts's table so the COST card can price any selected model.
 */
export function catalogPrices(): Record<string, { inputPerM: number; outputPerM: number }> {
  const out: Record<string, { inputPerM: number; outputPerM: number }> = {};
  for (const p of PROVIDER_IDS) for (const m of MODEL_CATALOG[p]) out[m.id] = { inputPerM: m.inputPerM, outputPerM: m.outputPerM };
  return out;
}

// ── per-agent config ──────────────────────────────────────────────────────────

export type AgentId = 'main' | 'reference' | 'curator';
export const AGENT_IDS: readonly AgentId[] = ['main', 'reference', 'curator'];

export interface AgentConfig {
  name: string;
  provider: ProviderId;
  model: string;
}
export type AgentConfigMap = Record<AgentId, AgentConfig>;

/** Fixed defaults for the two secondary agents (main derives from env at runtime). */
export const DEFAULT_SECONDARY: Record<'reference' | 'curator', AgentConfig> = {
  reference: { name: 'Reference', provider: 'deepseek', model: 'deepseek-v4-flash' },
  curator: { name: 'Curator', provider: 'deepseek', model: 'deepseek-v4-flash' },
};
export const DEFAULT_MAIN_NAME = 'Main';

// ── brain-id ⇄ provider-id vocabularies ────────────────────────────────────────
// The BRAINS panel + active_brain use brain ids (anthropic/openai/deepseek/
// claude-code); the agent config uses provider ids (claude-api/claude-cli/…).

export function providerToBrain(p: ProviderId): string {
  switch (p) {
    case 'claude-api':
      return 'anthropic';
    case 'claude-cli':
      return 'claude-code';
    case 'openai':
      return 'openai';
    case 'deepseek':
      return 'deepseek';
  }
}

export function brainToProvider(brainId: string): ProviderId {
  switch (brainId) {
    case 'claude-code':
      return 'claude-cli';
    case 'openai':
      return 'openai';
    case 'deepseek':
      return 'deepseek';
    case 'anthropic':
    default:
      return 'claude-api';
  }
}

/** Coerce an untrusted agent value onto a valid config, snapping an invalid model to the provider default. */
export function coerceAgent(raw: unknown, fallback: AgentConfig): AgentConfig {
  const r = (raw ?? {}) as Partial<AgentConfig>;
  const provider = isProviderId(r.provider) ? r.provider : fallback.provider;
  const model = typeof r.model === 'string' && findModel(provider, r.model)
    ? r.model
    : findModel(provider, fallback.model)
      ? fallback.model
      : DEFAULT_MODEL[provider];
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : fallback.name;
  return { name, provider, model };
}

/** Merge the persisted JSON over defaults. `mainDefault` is env-derived by the caller. */
export function parseAgentConfig(raw: string | undefined, mainDefault: AgentConfig): AgentConfigMap {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') parsed = v as Record<string, unknown>;
    } catch {
      // malformed → keep defaults
    }
  }
  return {
    main: coerceAgent(parsed.main, mainDefault),
    reference: coerceAgent(parsed.reference, DEFAULT_SECONDARY.reference),
    curator: coerceAgent(parsed.curator, DEFAULT_SECONDARY.curator),
  };
}

/** True when a given agent was explicitly persisted (vs a pure default) — keeps env fallbacks meaningful. */
export function hasPersistedAgent(raw: string | undefined, id: AgentId): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw);
    return !!(v && typeof v === 'object' && (v as Record<string, unknown>)[id]);
  } catch {
    return false;
  }
}

/** Provider spec for resolveProvider(): "<brainId>:<model>". claude-cli maps to the anthropic SDK brain. */
export function agentToSpec(a: AgentConfig): string {
  const brain = a.provider === 'claude-cli' ? 'anthropic' : providerToBrain(a.provider);
  return `${brain}:${a.model}`;
}

/** Anthropic model to run `claude -p` with for delegation: the main agent's model when it's a Claude provider, else the default. */
export function agentClaudeModel(raw: string | undefined): string {
  const dflt: AgentConfig = { name: DEFAULT_MAIN_NAME, provider: 'claude-api', model: DEFAULT_MODEL['claude-api'] };
  const main = parseAgentConfig(raw, dflt).main;
  if ((main.provider === 'claude-api' || main.provider === 'claude-cli') && findModel(main.provider, main.model)) {
    return main.model;
  }
  return DEFAULT_MODEL['claude-api'];
}
