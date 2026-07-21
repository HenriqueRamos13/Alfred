/**
 * Brains / providers — a unified layer over the Vercel AI SDK.
 *
 * Alfred can drive any of four brains:
 *   - anthropic   Anthropic Claude API           (ANTHROPIC_API_KEY, default active)
 *   - openai      OpenAI / ChatGPT API           (OPENAI_API_KEY)
 *   - deepseek    DeepSeek API                   (DEEPSEEK_API_KEY)
 *   - claude-code Claude Code CLI (`claude -p`)  — a delegation *tool*, not an
 *                 API chat brain (see tools/delegate.ts). Listed here only so the
 *                 UI can show its availability.
 *
 * The selection helpers (defaultProviderId / parseProviderSpec / selectBrainId)
 * are PURE and strip-types-safe (no value import needed) and are tested in
 * test/logic.test.ts. The AI-SDK factories are only touched by makeModel().
 */
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

type Env = Record<string, string | undefined>;

/**
 * A key counts as usable only when it's non-empty AND not an obvious placeholder
 * (the `.env.example` keys are `sk-...xxxx...`). Prevents accidentally enabling a
 * brain with a dummy key copied straight from the template.
 */
export function keyEnabled(key: string | undefined): boolean {
  const k = (key ?? '').trim();
  return k.length > 0 && !/xxxx/i.test(k);
}

/** Brain state as surfaced to the UI. */
export interface BrainInfo {
  id: string;
  label: string;
  /** True when the brain's API key (or CLI binary) is present. */
  enabled: boolean;
  model: string;
}

interface ApiBrain extends BrainInfo {
  makeModel: () => LanguageModel;
}

// ── pure selection logic (tested) ─────────────────────────────────────────────

/** Default brain id: ALFRED_PROVIDER when set, else 'anthropic'. */
export function defaultProviderId(env: Env): string {
  const v = (env.ALFRED_PROVIDER ?? '').trim();
  return v || 'anthropic';
}

/** Parse a "provider:model" spec. "anthropic" → {id}, "openai:gpt-4o" → {id, model}. */
export function parseProviderSpec(spec: string): { id: string; model?: string } {
  const trimmed = spec.trim();
  const i = trimmed.indexOf(':');
  if (i === -1) return { id: trimmed };
  const model = trimmed.slice(i + 1).trim();
  return { id: trimmed.slice(0, i).trim(), model: model || undefined };
}

/**
 * Pick a usable brain id: the requested one if enabled, otherwise fall back to
 * the first enabled brain. `fellBack` is true whenever the requested brain was
 * not the one chosen (unknown or disabled). `id` is null when nothing is enabled.
 */
export function selectBrainId(
  requested: string,
  brains: readonly BrainInfo[],
): { id: string | null; fellBack: boolean } {
  const wanted = brains.find((b) => b.id === requested);
  if (wanted?.enabled) return { id: wanted.id, fellBack: false };
  const firstEnabled = brains.find((b) => b.enabled);
  return { id: firstEnabled?.id ?? null, fellBack: !!firstEnabled };
}

// ── registry + resolution (touches the AI SDK) ────────────────────────────────

function anthropicModel(env: Env): string {
  return env.ANTHROPIC_MODEL || env.ALFRED_MODEL || 'claude-sonnet-5';
}

/** API-brain registry (the three AI-SDK providers). */
function apiBrains(env: Env): ApiBrain[] {
  const anthropicKey = env.ANTHROPIC_API_KEY ?? '';
  const openaiKey = env.OPENAI_API_KEY ?? '';
  const deepseekKey = env.DEEPSEEK_API_KEY ?? '';
  const aModel = anthropicModel(env);
  const oModel = env.OPENAI_MODEL || 'gpt-4o';
  const dModel = env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  return [
    {
      id: 'anthropic',
      label: 'Anthropic (Claude API)',
      enabled: keyEnabled(anthropicKey),
      model: aModel,
      makeModel: () => createAnthropic({ apiKey: anthropicKey })(aModel),
    },
    {
      id: 'openai',
      label: 'OpenAI (ChatGPT API)',
      enabled: keyEnabled(openaiKey),
      model: oModel,
      makeModel: () => createOpenAI({ apiKey: openaiKey })(oModel),
    },
    {
      id: 'deepseek',
      label: 'DeepSeek API',
      enabled: keyEnabled(deepseekKey),
      model: dModel,
      makeModel: () => createDeepSeek({ apiKey: deepseekKey })(dModel),
    },
  ];
}

/** True when a `claude` executable is on PATH (Claude Code CLI, for delegation). */
export function hasClaudeCli(env: Env = process.env): boolean {
  return (env.PATH ?? '').split(':').some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, 'claude'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** State of every brain for the UI (three API brains + the claude-code CLI). */
export function listBrains(env: Env = process.env): BrainInfo[] {
  const brains: BrainInfo[] = apiBrains(env).map(({ id, label, enabled, model }) => ({ id, label, enabled, model }));
  brains.push({
    id: 'claude-code',
    label: 'Claude Code CLI (claude -p — delegation)',
    enabled: hasClaudeCli(env),
    model: 'claude -p',
  });
  return brains;
}

export interface ResolvedProvider {
  id: string;
  model: string;
  languageModel: LanguageModel;
}

/**
 * Resolve a brain to an AI-SDK LanguageModel. `idOrDefault` may be a bare id
 * ("openai"), a "provider:model" spec, or undefined (→ ALFRED_PROVIDER/anthropic).
 * Falls back to the first enabled brain (with a clear log) when the requested one
 * isn't available. Throws only when no brain is enabled at all.
 */
export function resolveProvider(idOrDefault?: string, env: Env = process.env): ResolvedProvider {
  const brains = apiBrains(env);
  const spec = (idOrDefault && idOrDefault.trim()) || defaultProviderId(env);
  const { id: reqId, model: overrideModel } = parseProviderSpec(spec);

  const { id, fellBack } = selectBrainId(reqId, brains);
  if (!id) {
    throw new Error(
      'No brain is enabled. Set at least one provider API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY).',
    );
  }
  if (fellBack) {
    console.warn(`[alfred] brain "${reqId}" is not available; falling back to "${id}".`);
  }

  const brain = brains.find((b) => b.id === id)!;
  const model = overrideModel && !fellBack ? overrideModel : brain.model;
  // Re-key the factory when an explicit model override was requested.
  const languageModel = overrideModel && !fellBack ? withModel(brain, model, env) : brain.makeModel();
  return { id: brain.id, model, languageModel };
}

/** Build a LanguageModel for `brain` at a specific model id (honours "provider:model"). */
function withModel(brain: ApiBrain, model: string, env: Env): LanguageModel {
  switch (brain.id) {
    case 'anthropic':
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY ?? '' })(model);
    case 'openai':
      return createOpenAI({ apiKey: env.OPENAI_API_KEY ?? '' })(model);
    case 'deepseek':
      return createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY ?? '' })(model);
    default:
      return brain.makeModel();
  }
}
