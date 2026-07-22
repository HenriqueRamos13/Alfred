/**
 * Reset primitives (pure, testable).
 *
 * Two resets exist (wired in orchestrator.ts):
 *   - resetConversation: clears the chat + the claude-code --resume session id;
 *     keeps memory/facts/projects. No confirmation gate beyond a UI click.
 *   - factoryReset: the most destructive op — wipes everything Alfred knows.
 *     Gated by typing "confirmar" (confirmMatches) and confined to the paths
 *     factoryResetPaths returns (plus the DB tables + the "alfred" Keychain
 *     service). It NEVER touches arbitrary paths.
 */

import { join } from 'node:path';

/**
 * Factory-reset confirmation gate: the user must type "confirmar". Case- and
 * accent-insensitive (so "Confirmar" / "CONFIRMÁR" also pass), surrounding
 * whitespace ignored. Anything else keeps the destructive button disabled.
 */
export function confirmMatches(input: string): boolean {
  return (
    input
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toLowerCase() === 'confirmar'
  );
}

/**
 * The ONLY filesystem directories a factory reset removes — every path is
 * confined to the workspace or the app data dir. The DB file (cleared via SQL,
 * not deleted) and the Keychain secrets are handled separately in the caller.
 */
export function factoryResetPaths(workspace: string, dataDir: string): string[] {
  return [join(workspace, 'memory'), join(workspace, 'projects'), join(dataDir, 'browser-profile')];
}
