/**
 * SSRF classifier — PURE (no node:*, renderer-safe, strip-types testable).
 *
 * Phase 6 Stage 3: the full port of Hermes' `url_safety`. This file is the
 * decision layer only — given a URL string or an IP literal, is it allowed to
 * be reached? The connect-time enforcement (a custom DNS `lookup` that resolves
 * the host and re-checks the IP right before the socket connects, DNS-rebinding
 * aware, plus per-redirect revalidation) lives in the IO wrapper `url-safety.ts`.
 *
 * Blocks: non-http(s) schemes; loopback, RFC1918 private, link-local,
 * unspecified, and their IPv6 equivalents (::1, ::, fe80::/10, fc00::/7,
 * ::ffff:a.b.c.d mapped); and ALWAYS the cloud-metadata endpoints
 * (169.254.169.254, fd00:ec2::254, metadata.google.internal) even if private
 * ranges were ever allowed.
 */

/** Cloud-metadata endpoints — always blocked, independent of the private ranges. */
const METADATA_IPS = new Set(['169.254.169.254', 'fd00:ec2::254']);
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

/** True for an IPv4 literal in a blocked range (loopback / private / link-local / unspecified). */
function isBlockedIpv4(h: string): boolean {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false; // not a real v4 literal
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 (this-host / unspecified)
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // private 10/8
  if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT 100.64/10 (RFC6598)
  return false;
}

/**
 * Extract the embedded IPv4 of an IPv4-mapped IPv6 (`::ffff:*`), or null.
 * The WHATWG URL parser AND node's dns.lookup serialize the mapped v4 in HEX
 * (`::ffff:7f00:1`, not `::ffff:127.0.0.1`) — so a dotted-only match let
 * `http://[::ffff:7f00:1]/` (== 127.0.0.1) and `[::ffff:a9fe:a9fe]` (== the AWS
 * metadata IP) sail straight through. Decode both the hex form and the dotted form.
 */
function mappedIpv4(x: string): string | null {
  const dotted = x.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True for an IPv6 literal in a blocked range (loopback / unspecified / link-local / ULA / mapped-private). */
function isBlockedIpv6(h: string): boolean {
  const x = h.toLowerCase().replace(/%.*$/, ''); // strip a zone id (fe80::1%eth0)
  if (!x.includes(':')) return false;
  if (x === '::1' || x === '::') return true; // loopback / unspecified
  if (x.startsWith('fe80:') || x.startsWith('fe80::')) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{0,2}:/.test(x)) return true; // unique-local fc00::/7 (covers fd00:ec2::254)
  const m4 = mappedIpv4(x); // IPv4-mapped ::ffff:a.b.c.d — hex or dotted
  if (m4) return isBlockedIpv4(m4);
  return false;
}

/**
 * True when an IP LITERAL (v4 or v6, brackets/zone already tolerated) must never
 * be connected to. Returns false for a non-IP string (a plain hostname) — host
 * classification is `isBlockedHostname`. The connect-time guard feeds every
 * DNS-resolved address here before the socket opens.
 */
export function ipIsBlocked(ip: string): boolean {
  const h = String(ip ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (METADATA_IPS.has(h.replace(/%.*$/, ''))) return true; // always block metadata
  return isBlockedIpv4(h) || isBlockedIpv6(h);
}

/**
 * True when a hostname must never be reached: localhost, mDNS/internal TLDs, the
 * cloud-metadata names, and any loopback/private/link-local IP literal. A normal
 * public name (`api.example.com`) returns false here — but the connect-time guard
 * still resolves it and re-checks each IP via `ipIsBlocked` (DNS rebinding).
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (METADATA_HOSTS.has(h)) return true; // always block metadata
  return ipIsBlocked(h); // false for a non-IP hostname
}

export interface UrlClassification {
  ok: boolean;
  reason?: string;
  /** Present when the URL parsed: `http:` / `https:`. */
  protocol?: string;
  /** Present when the URL parsed: the lowercased host with IPv6 brackets stripped. */
  hostname?: string;
}

/**
 * Classify a URL string for SSRF. http(s) only; blocked hosts rejected. This is
 * the STATIC check (scheme + literal/known host). The connect-time guard adds the
 * dynamic DNS-resolution check on top — a public name that resolves to a private
 * IP passes here but is killed at connect.
 */
export function classifyUrl(raw: string): UrlClassification {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'only http:// and https:// URLs are allowed', protocol: u.protocol };
  }
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: `blocked local/internal/metadata address (${hostname})`, protocol: u.protocol, hostname };
  }
  return { ok: true, protocol: u.protocol, hostname };
}

/**
 * Whether a response is a redirect whose target must be re-classified and
 * re-connect-checked before it is followed. Every hop is revalidated — a public
 * URL cannot 302 to `http://169.254.169.254/`. Pure so the follow loop's decision
 * is testable without a socket.
 */
export function shouldRevalidateRedirect(status: number, location: string | null | undefined): boolean {
  return status >= 300 && status < 400 && typeof location === 'string' && location.trim() !== '';
}
