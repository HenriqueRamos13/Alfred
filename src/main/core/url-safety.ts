/**
 * SSRF enforcement — IO wrapper around the pure classifier (`url-safety-pure.ts`).
 * MAIN-only (imports node:*). Phase 6 Stage 3, part B.
 *
 * `safeFetch` is a drop-in GET/HTTP client that enforces SSRF at CONNECT TIME: a
 * custom DNS `lookup` resolves the host and rejects the request if ANY resolved
 * address is blocked — closing the DNS-rebinding hole a static URL check leaves
 * open (a public name that resolves to 169.254.169.254). The original hostname
 * stays in the `Host` header and TLS SNI (Node derives `servername` from it), so
 * name-based vhosts/certs still work. Redirects are followed MANUALLY and every
 * hop is re-classified + re-connect-checked.
 *
 * `assertUrlSafe` is the pre-flight for surfaces that do their own connecting
 * (the Playwright browser): classify the URL, then resolve + IP-check before the
 * caller navigates.
 */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupP } from 'node:dns/promises';
import { classifyUrl, ipIsBlocked, shouldRevalidateRedirect } from './url-safety-pure.ts';

const MAX_BODY = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

/**
 * A DNS `lookup` that validates every resolved address before the socket
 * connects. Passed to http(s).request so the guard runs on the ACTUAL IP the
 * connection will use — not a name that could rebind between check and connect.
 */
function guardedLookup(
  hostname: string,
  options: { family?: number; all?: boolean; hints?: number },
  callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err, null);
    for (const a of addrs) {
      if (ipIsBlocked(a.address)) {
        return callback(new Error(`SSRF guard: ${hostname} resolves to blocked ${a.address}`), null);
      }
    }
    const first = addrs[0];
    if (!first) return callback(new Error(`SSRF guard: ${hostname} did not resolve`), null);
    if (options.all) return callback(null, addrs);
    callback(null, first.address, first.family);
  });
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The final URL (after any redirects). */
  url: string;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
}

/**
 * SSRF-guarded HTTP(S) fetch with connect-time IP validation and per-redirect
 * revalidation. Throws on a blocked target, a redirect loop, an oversized body,
 * or a timeout. GET-oriented (no request body) — that is all the fetch-job
 * runner and any read path need.
 */
export function safeFetch(url: string, opts: SafeFetchOptions = {}, hop = 0): Promise<SafeFetchResult> {
  const cls = classifyUrl(url);
  if (!cls.ok) return Promise.reject(new Error(`SSRF guard: ${cls.reason} (${url})`));

  const mod = cls.protocol === 'https:' ? https : http;
  return new Promise<SafeFetchResult>((resolve, reject) => {
    const req = mod.request(
      url,
      { method: opts.method ?? 'GET', headers: opts.headers, lookup: guardedLookup as never },
      (res) => {
        const status = res.statusCode ?? 0;
        if (shouldRevalidateRedirect(status, res.headers.location)) {
          res.resume(); // drain the redirect body
          if (hop >= MAX_REDIRECTS) return reject(new Error('SSRF guard: too many redirects'));
          const next = new URL(res.headers.location as string, url).toString();
          // The recursive call re-classifies AND re-connect-checks the new hop.
          safeFetch(next, opts, hop + 1).then(resolve, reject);
          return;
        }
        let body = '';
        let bytes = 0;
        res.on('data', (d: Buffer) => {
          bytes += d.length;
          if (bytes <= MAX_BODY) body += d.toString();
          else {
            req.destroy();
            reject(new Error('SSRF guard: response exceeds size cap'));
          }
        });
        res.on('end', () => resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body, url }));
      },
    );
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('SSRF guard: request timed out')));
    req.end();
  });
}

/**
 * Pre-flight guard for surfaces that connect themselves (Playwright browser).
 * Classify the URL, then resolve the host and reject if any IP is blocked
 * (DNS-rebinding aware). Throws with a clear reason; the caller turns it into a
 * tool error. Cannot pin the exact socket like `safeFetch`, but closes the
 * literal-and-resolved-IP holes before navigation.
 */
export async function assertUrlSafe(url: string): Promise<void> {
  const cls = classifyUrl(url);
  if (!cls.ok) throw new Error(`SSRF guard: ${cls.reason} (${url})`);
  const addrs = await dnsLookupP(cls.hostname as string, { all: true, verbatim: true });
  for (const a of addrs) {
    if (ipIsBlocked(a.address)) {
      throw new Error(`SSRF guard: ${cls.hostname} resolves to blocked ${a.address}`);
    }
  }
}
