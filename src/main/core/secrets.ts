/**
 * Secrets via the macOS Keychain CLI (`security`). All items live under the
 * generic-password service "alfred", keyed by `key`. On non-macOS platforms
 * every call throws a clear error rather than crashing the process — dev on
 * Linux still boots, secret-backed features simply refuse.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Secrets } from './types.ts';

const run = promisify(execFile);
const SERVICE = 'alfred';

/** `security` exits 44 when a generic-password item is not found. */
function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; stderr?: string };
  return e?.code === 44 || /could not be found/i.test(e?.stderr ?? '');
}

export function createSecrets(): Secrets {
  function ensureMac(): void {
    if (process.platform !== 'darwin') {
      throw new Error(
        `Alfred secrets require the macOS Keychain; current platform is "${process.platform}". ` +
          'Secret-backed features (Gmail tokens) are unavailable here.',
      );
    }
  }

  return {
    async get(key) {
      ensureMac();
      try {
        const { stdout } = await run('security', ['find-generic-password', '-a', key, '-s', SERVICE, '-w']);
        return stdout.replace(/\n$/, '');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async set(key, value) {
      ensureMac();
      // -U updates the item if it already exists.
      await run('security', ['add-generic-password', '-a', key, '-s', SERVICE, '-w', value, '-U']);
    },

    async delete(key) {
      ensureMac();
      try {
        await run('security', ['delete-generic-password', '-a', key, '-s', SERVICE]);
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    },
  };
}
