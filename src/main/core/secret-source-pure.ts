/**
 * Secret-source SELECTION + safe command assembly — PURE (renderer-safe,
 * strip-types testable). The IO (running the CLI, calling the Keychain) lives in
 * `secret-source.ts`.
 *
 * Phase 6 Stage 3, part A. A `SecretSource` resolves a named service credential
 * AT USE-TIME from the configured backend instead of Alfred storing plaintext:
 *   - keychain  — the macOS `security` store (the existing default)
 *   - command   — a user-configured wrapper argv (any vault); the secret NAME is
 *                 appended as an explicit argv element, never concatenated into a
 *                 shell string, so there is no shell-injection surface
 *   - op        — 1Password CLI: `op read <name>`
 *   - bw        — Bitwarden CLI: `bw get password <name>`
 *
 * The two things worth testing on their own — which backend the config selects,
 * and the exact argv assembled for it — are here and pure.
 */

export type SecretSourceKind = 'keychain' | 'command' | 'op' | 'bw';

export interface SecretSourceSpec {
  kind: SecretSourceKind;
  /** For `command`: the wrapper argv prefix (executable + fixed args) the secret name is appended to. */
  command?: string[];
}

/** The subset of env/settings that picks the source. */
export interface SecretSourceConfig {
  /** keychain (default) | command | op | bw. */
  ALFRED_SECRET_SOURCE?: string;
  /** For `command`: the wrapper argv, whitespace-separated (e.g. "my-vault get --field password"). */
  ALFRED_SECRET_COMMAND?: string;
}

export type ResolveResult = SecretSourceSpec | { error: string };

/**
 * Pick the secret backend from config. Empty/absent → keychain (the default, so
 * existing Keychain-backed features keep working untouched). `command` requires
 * ALFRED_SECRET_COMMAND. Returns `{ error }` for an unknown source or a
 * command source with no command — the IO layer fails closed on that.
 */
export function resolveSecretSource(config: SecretSourceConfig): ResolveResult {
  const raw = (config.ALFRED_SECRET_SOURCE ?? '').trim().toLowerCase();
  const kind = raw === '' ? 'keychain' : raw;
  if (kind !== 'keychain' && kind !== 'command' && kind !== 'op' && kind !== 'bw') {
    return { error: `unknown ALFRED_SECRET_SOURCE "${raw}" (expected keychain | command | op | bw)` };
  }
  if (kind === 'command') {
    // ponytail: whitespace split (no shell quoting). Injection-safe regardless —
    // the argv goes straight to execFile, never a shell. Upgrade to a shell-quote
    // parser only if a vault wrapper genuinely needs a quoted fixed arg.
    const argv = (config.ALFRED_SECRET_COMMAND ?? '').trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      return { error: 'ALFRED_SECRET_SOURCE=command requires ALFRED_SECRET_COMMAND (the vault wrapper argv)' };
    }
    return { kind: 'command', command: argv };
  }
  return { kind };
}

export type ArgvResult = { file: string; args: string[] } | { error: string };

/**
 * Assemble the exact `{ file, args }` to run for a secret name. The name is
 * ALWAYS a discrete argv element — it is never interpolated into a string that a
 * shell could re-parse. A name with a NUL/newline (argv smuggling / log
 * injection) is rejected. Pure so the argv is asserted in tests without spawning.
 */
export function buildSecretArgv(spec: SecretSourceSpec, name: string): ArgvResult {
  const n = String(name ?? '').trim();
  if (!n) return { error: 'secret name is required' };
  if (/[\0\r\n]/.test(n)) return { error: 'secret name contains an illegal character' };
  switch (spec.kind) {
    case 'keychain':
      return { file: 'security', args: ['find-generic-password', '-a', n, '-s', 'alfred', '-w'] };
    case 'op':
      return { file: 'op', args: ['read', n] };
    case 'bw':
      return { file: 'bw', args: ['get', 'password', n] };
    case 'command': {
      const argv = spec.command ?? [];
      if (argv.length === 0) return { error: 'command source has no configured command' };
      return { file: argv[0], args: [...argv.slice(1), n] };
    }
  }
}
