/** Exact page identity check; hash changes are allowed for client-side routing. */
export function isTrustedPageUrl(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate);
    const trusted = new URL(expected);
    actual.hash = '';
    trusted.hash = '';
    return actual.href === trusted.href;
  } catch {
    return false;
  }
}

/** Links may leave Alfred only through the operating system's browser/mail app. */
export function isSafeExternalUrl(candidate: string): boolean {
  try {
    const protocol = new URL(candidate).protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}
