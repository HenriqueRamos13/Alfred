/**
 * Tier-2 widget HTML wrapping (Phase 4, stage 4). Renderer-safe & PURE: no
 * `node:*` / electron / better-sqlite3 import, so it is shared by the renderer
 * card and unit-tested via `node --experimental-strip-types`.
 *
 * ── Why a HASH, not `'unsafe-inline'` (the real root cause) ──────────────────
 * The card renders the widget as the `srcdoc` of `<iframe sandbox="allow-scripts">`.
 * A `srcdoc` iframe INHERITS the parent document's CSP, and multiple CSPs compose
 * by INTERSECTION (the most restrictive wins). The parent (src/renderer/index.html)
 * ships `script-src 'self'` — NO `'unsafe-inline'`. So an inline `<script>` in the
 * widget was blocked by the inherited parent policy no matter what the widget's own
 * `<meta>` CSP said: `window.Alfred` never existed and the widget never updated.
 *
 * Fix: the runtime is a FIXED, trusted script. We pin it by its SHA-256 hash in
 * BOTH policies:
 *   - parent index.html: `script-src 'self' 'sha256-<hash>'` — allows exactly this
 *     runtime (and same-origin app scripts), still no `'unsafe-inline'`;
 *   - widget meta CSP (below): `script-src 'sha256-<hash>'` — allows ONLY this runtime.
 * The runtime therefore survives the intersection (both policies list its hash), while
 * ANY model-authored inline script is blocked by BOTH (wrong hash, no unsafe-inline) —
 * defence in depth. The hash is over the EXACT text between `<script>` and `</script>`,
 * so `WIDGET_RUNTIME` must stay a constant literal (never interpolate) and any edit to
 * it must be reflected in `WIDGET_RUNTIME_SHA256` + index.html — a test enforces this.
 *
 * ── Declarative contract (the model writes NO JS) ────────────────────────────
 * Because model scripts can't run anyway, the model writes only pretty HTML/CSS plus
 * declarative binding attributes; the trusted runtime fills them on every refresh:
 *   - `data-alfred="path"`            → element.textContent = value at `path`
 *   - `data-alfred-sparkline="path"`  → inline-SVG sparkline of the numeric array at `path`
 *   - `data-alfred-attr="attr:path"`  → element.setAttribute(attr, value at `path`)
 * `path` is a dot/bracket path (e.g. `current.temperature_2m`, `hourly.temp[0]`).
 * Only textContent + setAttribute + the runtime-built SVG are used — never innerHTML
 * with model/remote data — so a hostile payload can't XSS even inside its own frame.
 */

/**
 * Resolve a dot/bracket path into a value. Mirrors `extractValue`/`parsePath` in
 * jobs-pure.ts. Exported so a pure test can exercise the exact logic the runtime
 * uses for its bindings.
 * ponytail: this is duplicated verbatim inside WIDGET_RUNTIME (a hash-pinned string
 * that can't import TS). The SHA-256 test fails loudly if the runtime copy drifts.
 */
export function widgetResolvePath(data: unknown, path?: string): unknown {
  if (!path) return data;
  const re = /\[\s*(['"])(.*?)\1\s*\]|\[\s*([^\]]*?)\s*\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  let cur: unknown = data;
  while ((m = re.exec(path)) !== null) {
    const k = m[2] ?? m[3] ?? m[4];
    if (k === undefined || k === '') continue;
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * The trusted, FIXED runtime injected before the model HTML. A declarative binding
 * engine: it buffers the latest `postMessage` payload (order-independent delivery)
 * and, on both message and DOMContentLoaded (the runtime runs in <head>, before the
 * model's body exists), fills every `data-alfred*` binding from that value. Kept as
 * an ES5-ish string constant — its bytes are hash-pinned in the CSPs, so NEVER
 * interpolate anything into it.
 */
export const WIDGET_RUNTIME = `(function(){
  function resolve(o, p){
    if (!p) return o;
    var re = /\\[\\s*(['"])(.*?)\\1\\s*\\]|\\[\\s*([^\\]]*?)\\s*\\]|([^.[\\]]+)/g, m, cur = o;
    while ((m = re.exec(p)) !== null){
      var k = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
      if (k === undefined || k === '') continue;
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[k];
    }
    return cur;
  }
  function text(v){ return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); }
  function sparkline(el, arr){
    var a = (arr || []).map(Number).filter(function(n){ return isFinite(n); });
    if (a.length < 2){ el.textContent = a.length ? String(a[0]) : ''; return; }
    var w = 200, h = 46, pad = 3;
    var min = Math.min.apply(null, a), max = Math.max.apply(null, a);
    var span = (max - min) || 1, n = (a.length - 1) || 1, pts = [];
    for (var i=0;i<a.length;i++){
      var x = pad + (i / n) * (w - 2*pad);
      var y = h - pad - ((a[i] - min) / span) * (h - 2*pad);
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var lp = pts[pts.length-1].split(',');
    el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none" style="display:block">'
      + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#35e5ff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>'
      + '<circle cx="' + lp[0] + '" cy="' + lp[1] + '" r="2.5" fill="#35e5ff"/></svg>';
  }
  function apply(data){
    var els, i, el;
    els = document.querySelectorAll('[data-alfred]');
    for (i=0;i<els.length;i++){ el = els[i]; el.textContent = text(resolve(data, el.getAttribute('data-alfred'))); }
    els = document.querySelectorAll('[data-alfred-sparkline]');
    for (i=0;i<els.length;i++){ el = els[i]; sparkline(el, resolve(data, el.getAttribute('data-alfred-sparkline'))); }
    els = document.querySelectorAll('[data-alfred-attr]');
    for (i=0;i<els.length;i++){
      el = els[i];
      var spec = el.getAttribute('data-alfred-attr'), ci = spec.indexOf(':');
      if (ci < 0) continue;
      var v = resolve(data, spec.slice(ci+1));
      if (v != null) el.setAttribute(spec.slice(0, ci), String(v));
    }
  }
  var last, hasLast = false;
  function render(){ if (hasLast) apply(last); }
  window.addEventListener('message', function(ev){ last = ev.data; hasLast = true; render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
  // Ready-handshake: tell the parent card the runtime is mounted, so it can (re)seed
  // the current value even if its first post raced the load.
  parent.postMessage({ __alfredWidgetReady: 1 }, '*');
})();`;

/**
 * Base64 SHA-256 of the EXACT bytes of `WIDGET_RUNTIME`. Pinned in both CSPs (this
 * file's `WIDGET_CSP` and src/renderer/index.html). A test recomputes it and asserts
 * both places match — edit the runtime and the test fails until you refresh this.
 */
export const WIDGET_RUNTIME_SHA256 = 'sha256-nHokzg6tLqDaJAsGcEuAKs7Y+LGAnMEaMQbDZ4g7zQg=';

/**
 * The one trusted widget CSP. `default-src 'none'` = zero network; scripts pinned to
 * the runtime hash (NOT `'unsafe-inline'`) so no model script can ever run.
 */
export const WIDGET_CSP =
  `default-src 'none'; script-src '${WIDGET_RUNTIME_SHA256}'; style-src 'unsafe-inline'; img-src data:`;

/**
 * The CSP for the JS-ENABLED path (widget_scripts_enabled ON). Served in the
 * RESPONSE HEADER by the custom `alfred-widget://` protocol (see src/main/index.ts),
 * NOT as a srcdoc meta — a header CSP on a real (custom-scheme) origin is the
 * widget's OWN policy and is NOT intersected with the parent's like a srcdoc's is,
 * so `script-src 'unsafe-inline'` here actually lets the model's inline JS RUN.
 * Crucially `default-src 'none'` means connect-src/frame-src/etc. all fall back to
 * none: fetch / XHR / WebSocket / sendBeacon are DEAD and img is data:-only, so a
 * script can compute and animate but has NO way to exfiltrate — data still arrives
 * only via the parent's postMessage. That is why JS-on stays safe.
 */
export const WIDGET_CSP_JS = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`;

/**
 * Wrap model HTML for the JS-enabled path. Same trusted runtime (data-alfred
 * bindings + postMessage seed + ready handshake) plus the model body. The
 * protocol handler ALSO sets WIDGET_CSP_JS on the Response header (the primary
 * policy); we embed the SAME policy as a `<meta>` too — defence in depth, so a
 * dropped/misconfigured header can never leave the widget with NO policy (which
 * would re-open the network). On the custom (alfred-widget:) origin this meta is
 * the widget's OWN policy — NOT intersected with the parent like a srcdoc's —
 * so `script-src 'unsafe-inline'` still lets the runtime AND the model's inline
 * scripts run, while `default-src 'none'` keeps the network dead either way.
 */
export function wrapWidgetHtmlJs(modelHtml: string): string {
  const body = typeof modelHtml === 'string' ? modelHtml : '';
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP_JS}">` +
    `<script>${WIDGET_RUNTIME}</script>` +
    '</head><body>' +
    body +
    '</body></html>'
  );
}

// ── widget security scanner (heuristic, PURE) ─────────────────────────────────

export type WidgetRisk = 'ok' | 'suspicious' | 'dangerous';
export interface WidgetScan {
  risk: WidgetRisk;
  findings: string[];
}

/** Dangerous patterns: code-injection, network egress, pixel exfil, frame-escape. */
const DANGEROUS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\beval\s*\(/i, label: 'eval() — arbitrary code execution' },
  { re: /\bnew\s+Function\s*\(/i, label: 'new Function() — code from a string' },
  { re: /\bfetch\s*\(/i, label: 'fetch() — network request (egress)' },
  { re: /XMLHttpRequest/i, label: 'XMLHttpRequest — network request (egress)' },
  { re: /\bnew\s+WebSocket\b/i, label: 'WebSocket — network connection (egress)' },
  { re: /\bnew\s+EventSource\b/i, label: 'EventSource — network stream (egress)' },
  { re: /sendBeacon/i, label: 'navigator.sendBeacon — background exfil' },
  { re: /<script[^>]*\ssrc\s*=/i, label: '<script src> — external script load' },
  { re: /document\s*\.\s*cookie/i, label: 'document.cookie access' },
  { re: /\bnew\s+Image\s*\(/i, label: 'new Image() — pixel-beacon exfil' },
  { re: /<img[^>]*\ssrc\s*=\s*["']?\s*https?:/i, label: '<img src=http…> — remote pixel exfil' },
  { re: /\bwindow\s*\.\s*(parent|top|opener)\b/i, label: 'window.parent/top/opener — frame-escape attempt' },
  { re: /\b(parent|top)\s*\.\s*(location|document|postMessage|frames|opener)\b/i, label: 'parent/top.* — frame-escape attempt' },
  { re: /\.\s*opener\b/i, label: 'window.opener — frame-escape attempt' },
  { re: /javascript\s*:/i, label: 'javascript: URI' },
];

/** Suspicious patterns: sandboxed-but-noteworthy (storage, handlers, hidden chars). */
const SUSPICIOUS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(local|session)Storage\b/i, label: 'localStorage/sessionStorage access' },
  { re: /indexedDB/i, label: 'indexedDB access' },
  { re: /\son\w+\s*=\s*["']/i, label: 'inline on*= event handler with code' },
  { re: /<script(\s|>)/i, label: 'inline <script> block (declarative mode ignores it)' },
  // Zero-width / bidi / BOM controls used to hide code or spoof text.
  { re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/, label: 'invisible/bidi Unicode control characters' },
  // Cyrillic / Greek letters in otherwise-Latin markup = possible homoglyph spoof.
  { re: /[\u0400-\u04FF\u0370-\u03FF]/, label: 'Cyrillic/Greek homoglyph characters' },
];

/**
 * Heuristic security scan of a tier-2 widget's model HTML. Flags code-exec,
 * network-egress, pixel-exfil, frame-escape (dangerous) and storage/inline-
 * handler/hidden-Unicode (suspicious). Pure + string-only so it is unit-tested
 * and can run at create/edit time. Defence in depth: even JS-ON widgets are
 * sandboxed with no network, but a `dangerous` verdict blocks creation outright.
 */
export function scanWidgetHtml(html: string): WidgetScan {
  const s = typeof html === 'string' ? html : '';
  const findings: string[] = [];
  for (const { re, label } of DANGEROUS_PATTERNS) if (re.test(s)) findings.push(label);
  const dangerous = findings.length > 0;
  for (const { re, label } of SUSPICIOUS_PATTERNS) if (re.test(s)) findings.push(label);
  const risk: WidgetRisk = dangerous ? 'dangerous' : findings.length ? 'suspicious' : 'ok';
  return { risk, findings };
}

export interface WidgetCreateGuard {
  /** True → refuse to create/edit the widget. */
  block: boolean;
  /** Set when block: why the creation was refused (with findings). */
  error?: string;
  /** Set when created-but-suspicious: a non-blocking warning (findings). */
  warning?: string;
  scan: WidgetScan;
}

/**
 * The create/edit decision for a tier-2 widget's HTML (§2): `dangerous` → refuse
 * with the findings; `suspicious` → allow but warn; `ok` → allow silently. Pure.
 */
export function widgetCreateGuard(html: string): WidgetCreateGuard {
  const scan = scanWidgetHtml(html);
  if (scan.risk === 'dangerous') {
    return { block: true, scan, error: `widget HTML rejected — dangerous patterns: ${scan.findings.join('; ')}` };
  }
  if (scan.risk === 'suspicious') {
    return { block: false, scan, warning: `widget created with a security warning: ${scan.findings.join('; ')}` };
  }
  return { block: false, scan };
}

/**
 * FAIL-LOUD (§3): in the DEFAULT (scripts OFF) declarative mode, a tier-2 widget
 * only updates via `data-alfred*` bindings — a `<script>` never runs and HTML
 * with no binding never refreshes. Returns a clear warning in those cases so the
 * user understands why the widget looks frozen; null when the HTML is fine for
 * declarative mode. Pure.
 */
export function declarativeModeWarning(html: string): string | null {
  const s = typeof html === 'string' ? html : '';
  const hasScript = /<script(\s|>)/i.test(s);
  const hasBinding = /data-alfred(?:-sparkline|-attr)?\s*=/i.test(s);
  if (hasScript || !hasBinding) {
    return 'modo declarativo: usa data-alfred / data-alfred-sparkline, ou liga o toggle Widget JS para HTML com script';
  }
  return null;
}

/** Max bytes of model-authored HTML we accept for a tier-2 widget. */
export const WIDGET_HTML_MAX_BYTES = 256 * 1024;

/**
 * Wrap model-authored widget HTML into the full trusted `srcdoc`. The CSP meta and
 * the hash-pinned runtime always come FIRST, in a head the model cannot precede; the
 * model HTML goes in the body. Returns a complete HTML document string.
 */
export function wrapWidgetHtml(modelHtml: string): string {
  const body = typeof modelHtml === 'string' ? modelHtml : '';
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">` +
    `<script>${WIDGET_RUNTIME}</script>` +
    '</head><body>' +
    body +
    '</body></html>'
  );
}
