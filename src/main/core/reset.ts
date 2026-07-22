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

// confirmMatches is renderer-safe (no node deps) so it lives in reset-pure.ts;
// re-exported here so main + tests keep importing it from reset.ts.
export { confirmMatches } from './reset-pure.ts';

/**
 * The ONLY filesystem directories a factory reset removes — every path is
 * confined to the workspace or the app data dir. The DB file (cleared via SQL,
 * not deleted) and the Keychain secrets are handled separately in the caller.
 */
export function factoryResetPaths(workspace: string, dataDir: string): string[] {
  return [join(workspace, 'memory'), join(workspace, 'projects'), join(dataDir, 'browser-profile')];
}
