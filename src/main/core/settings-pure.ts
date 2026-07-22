/**
 * Renderer-safe settings helpers. MUST stay free of any `node:*` /
 * better-sqlite3 import so it can be shared and unit-tested via strip-types.
 */

/**
 * GRILL-ME toggle: defaults to ON. The setting is absent on a fresh DB, so only
 * an explicit "0" disables it — anything else (including undefined) is ON.
 */
export function grillMeEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}
