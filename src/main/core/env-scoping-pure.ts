/**
 * Credential env-scoping — PURE (renderer-safe, strip-types testable).
 *
 * Phase 6 Stage 3, cross-cutting. Any subprocess Alfred spawns (the shell tool,
 * a stdio MCP child, `claude -p`) inherits Alfred's environment by default —
 * which holds provider API keys and OAuth secrets. A model-driven `curl`/script
 * could then read `$ANTHROPIC_API_KEY` and exfiltrate it. `scrubbedEnv` strips
 * the sensitive keys before handing the env down; a subprocess that genuinely
 * needs one gets it via an explicit allowlist.
 *
 * (`claudeSpawn.ts` already dropped the ANTHROPIC_* API-key vars so `claude -p`
 * uses subscription auth; this is the generalised, tested rule.)
 */

/** Key name patterns that mark a value as a credential/secret and must not leave the process. */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^DEEPSEEK_/i,
  /^ELEVENLABS_/i,
  /^GOOGLE_OAUTH_/i,
  /^AWS_/i,
  /_API_?KEY$/i,
  /_TOKEN$/i,
  /SECRET/i, // any key containing SECRET (CLIENT_SECRET, *_SECRET, SECRET_KEY, …)
];

/** True when an env var name looks like a credential that must be withheld from subprocesses. */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(key));
}

/**
 * A copy of `env` with every sensitive key removed, except keys named in
 * `allowlist` (a subprocess that legitimately needs a specific credential passes
 * it explicitly). Benign vars (PATH, HOME, LANG, …) are untouched.
 */
export function scrubbedEnv(
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allow = new Set(allowlist);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (isSensitiveEnvKey(k) && !allow.has(k)) continue;
    out[k] = v;
  }
  return out;
}
