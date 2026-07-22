/**
 * Renderer-safe reset helpers. MUST stay free of any `node:*` import so the
 * renderer bundle (App.tsx imports confirmMatches for the factory-reset gate)
 * never drags Node built-ins into the browser build. Node-dependent bits
 * (factoryResetPaths) live in reset.ts, which is main-only.
 */

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
