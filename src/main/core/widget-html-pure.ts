/**
 * Tier-2 widget HTML wrapping (Phase 4, stage 4). Renderer-safe & PURE: no
 * `node:*` / electron / better-sqlite3 import, so it is shared by the renderer
 * card and unit-tested via `node --experimental-strip-types`.
 *
 * Security model (see tasks/PHASE4-SCHEDULED-JOBS-PROMPT.md §5/§6): the model
 * writes only the "glue" (markup + a render(data) using the runtime). We wrap it
 * in a document WE control:
 *
 *   - a restrictive <meta> CSP FIRST in a <head> we own — `default-src 'none'`
 *     (zero network: no fetch/xhr/ws, no external script/style/img). Multiple
 *     CSPs compose by INTERSECTION, so a model-injected policy can only further
 *     restrict, never relax ours — our `default-src 'none'` always holds;
 *   - a trusted RUNTIME (`window.Alfred`) that receives data via `postMessage`
 *     and exposes a dependency-free SVG sparkline helper;
 *   - the model HTML in the <body>.
 *
 * The card renders this as the `srcdoc` of `<iframe sandbox="allow-scripts">`
 * (NO allow-same-origin → opaque origin: no DOM-parent / cookie / storage
 * access). Blast radius of malicious/prompt-injected model HTML: it can only
 * draw junk inside its own iframe — no network, no parent, no IPC.
 */

/** The one trusted CSP. `default-src 'none'` = no network of any kind. */
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

/** Max bytes of model-authored HTML we accept for a tier-2 widget. */
export const WIDGET_HTML_MAX_BYTES = 256 * 1024;

/**
 * The trusted runtime injected before the model HTML. Defines `window.Alfred`:
 *   - `onData(cb)` — register a callback; a single `message` listener fans the
 *     posted payload out to every callback (the parent card posts job.data);
 *   - `sparkline(el, arr)` — draw a minimal inline-SVG line chart of a numeric
 *     array into `el` (no external lib; CSP forbids one anyway).
 * Kept as ES5-ish string so it is valid inside any generated page.
 */
export const WIDGET_RUNTIME = `(function(){
  var cbs = [];
  function fan(v){ for (var i=0;i<cbs.length;i++){ try { cbs[i](v); } catch(e){} } }
  window.addEventListener('message', function(ev){ fan(ev.data); });
  window.Alfred = {
    onData: function(cb){ if (typeof cb === 'function') cbs.push(cb); },
    sparkline: function(el, arr){
      if (!el) return;
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
      var last = pts[pts.length-1].split(',');
      var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none" style="display:block">'
        + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#35e5ff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>'
        + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.5" fill="#35e5ff"/></svg>';
      el.innerHTML = svg;
    }
  };
})();`;

/**
 * Wrap model-authored widget HTML into the full trusted `srcdoc`. The CSP meta
 * and the runtime always come FIRST, in a head the model cannot precede; the
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
