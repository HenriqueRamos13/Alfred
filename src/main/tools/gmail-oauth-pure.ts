export type OAuthCallback =
  | { kind: 'ignore' }
  | { kind: 'invalid-state' }
  | { kind: 'error'; error: string }
  | { kind: 'code'; code: string };

/** Parse and bind a loopback callback to the exact OAuth attempt that opened it. */
export function classifyOAuthCallback(rawUrl: string, expectedState: string): OAuthCallback {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return { kind: 'ignore' };
  if (!expectedState || url.searchParams.get('state') !== expectedState) return { kind: 'invalid-state' };
  if (error) return { kind: 'error', error };
  return { kind: 'code', code: code! };
}
