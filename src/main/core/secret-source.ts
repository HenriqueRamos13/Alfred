/**
 * Secret-source IO adapter (MAIN-only). Resolves a named credential at use-time
 * from the configured backend — see `secret-source-pure.ts` for selection and
 * argv assembly, which are pure and tested.
 *
 * SECURITY: the resolved VALUE is never logged and never returned to the model
 * in clear. On a backend failure the error carries only the backend + name +
 * exit code — never the CLI's stdout/stderr, which could contain the secret.
 * Reading a secret is a T3 (credentials) action per governance.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSecretSource, buildSecretArgv, type SecretSourceSpec } from './secret-source-pure.ts';
import type { Secrets } from './types.ts';

const run = promisify(execFile);

export interface SecretSource {
  /** Resolve a named secret's value via the configured backend. Throws (never leaks the value) on failure. */
  getSecret(name: string): Promise<string>;
  /** The selected backend (for diagnostics/UI; never exposes a value). */
  describe(): SecretSourceSpec;
}

/**
 * Build the secret source from env. `keychain` (the default) delegates to the
 * existing Keychain-backed `Secrets` store so nothing that reads secrets today
 * changes. Other backends shell out to a validated argv. A misconfigured source
 * fails CLOSED — the error surfaces only when a secret is actually requested, so
 * boot is never blocked.
 */
export function createSecretSource(env: NodeJS.ProcessEnv, keychain: Secrets): SecretSource {
  const resolved = resolveSecretSource(env);
  if ('error' in resolved) {
    const fail = (): never => {
      throw new Error(resolved.error);
    };
    return { describe: fail, getSecret: async () => fail() };
  }

  return {
    describe: () => resolved,
    async getSecret(name) {
      if (resolved.kind === 'keychain') {
        const v = await keychain.get(name);
        if (v == null) throw new Error(`secret "${name}" not found in keychain`);
        return v;
      }
      const argv = buildSecretArgv(resolved, name);
      if ('error' in argv) throw new Error(argv.error);
      try {
        const { stdout } = await run(argv.file, argv.args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
        return stdout.replace(/\n$/, '');
      } catch (err) {
        // NEVER surface the caught error verbatim: execFile attaches stdout/stderr,
        // which may hold the secret. Log + throw with backend/name/exit only.
        const code = (err as { code?: number }).code;
        console.error(`[alfred] secret source "${resolved.kind}" failed for "${name}" (exit ${code ?? '?'})`);
        throw new Error(`secret source "${resolved.kind}" could not resolve "${name}"`);
      }
    },
  };
}
