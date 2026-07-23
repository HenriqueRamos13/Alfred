/**
 * HtmlWidgetCard — a Tier-2 job widget (Phase 4, stage 4).
 *
 * Renders the model-authored self-contained page inside a locked-down
 * `<iframe sandbox="allow-scripts">` (NO allow-same-origin → opaque origin: no
 * DOM-parent / cookie / storage access; NO allow-popups/forms/top-navigation).
 * The page has zero network. Data flows ONE way: we subscribe to the SAME
 * `job.data` stream (filtered by jobId) and `postMessage` each value into the
 * frame, where the trusted runtime fills the model's `data-alfred*` bindings. No
 * IPC/preload channel ever crosses into the iframe.
 *
 * TWO CSP modes (the `widget_scripts_enabled` toggle):
 *  - OFF (default): `srcDoc` = the hash-pinned wrapper. The srcdoc iframe INHERITS
 *    the parent CSP (`script-src 'self'`), which intersects with the widget meta
 *    CSP, so the ONLY script that runs is the hash-pinned runtime — the model's own
 *    `<script>` is blocked. Purely declarative.
 *  - ON: `src="alfred-widget://widget/<jobId>"`. A custom-scheme document has its
 *    OWN response-header CSP (`script-src 'unsafe-inline'`) that is NOT intersected
 *    with the parent's (it is a separate origin, not a srcdoc), so the model's JS
 *    RUNS. `default-src 'none'` still kills all network (connect/img-remote), so a
 *    widget can compute but never exfiltrate; data still arrives only via postMessage.
 * Either way the sandbox stays `allow-scripts` WITHOUT `allow-same-origin`, so the
 * frame can reach neither the parent DOM, cookies, nor IPC.
 */
import { useEffect, useRef, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { wrapWidgetHtml } from '../../main/core/widget-html-pure.ts';
import type { Job, StreamEvent } from '../../main/core/types.ts';

export function HtmlWidgetCard({ job, scriptsEnabled }: { job: Job; scriptsEnabled?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc] = useState(() => wrapWidgetHtml(job.render.html ?? ''));
  // The freshest value we should show — persisted lastResult, then each job.data.
  // Held in a ref so the ready-handshake listener can post the CURRENT value.
  const latestRef = useRef<unknown>(job.runtime.lastResult ?? null);

  const post = (value: unknown) => {
    latestRef.current = value;
    iframeRef.current?.contentWindow?.postMessage(value, '*');
  };

  // Push the latest value into the frame. Seed from persisted lastResult, then
  // on every job.data refresh (postMessage only — the iframe never reloads).
  useEffect(() => {
    latestRef.current = job.runtime.lastResult ?? null;
    if (job.runtime.lastResult != null) post(job.runtime.lastResult);
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'job.data' && e.jobId === job.id) post(e.value);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.runtime.lastResult]);

  // Ready-handshake (race-proof seed). The runtime posts {__alfredWidgetReady:1}
  // once mounted; we reply with the current value. STRICTLY confined: accept only
  // messages from OUR OWN iframe, only that exact shape, and do NOTHING but
  // re-post this widget's own display value — never any privileged action.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const d = ev.data as { __alfredWidgetReady?: unknown } | null;
      if (!d || d.__alfredWidgetReady !== 1) return;
      if (latestRef.current != null) post(latestRef.current);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ON → the custom-protocol URL (own header CSP, model JS runs, no network);
  // OFF → the inherited-CSP srcDoc (declarative). Keying on the mode forces a
  // clean remount when the toggle flips, so the frame never mixes src+srcDoc.
  const jsMode = scriptsEnabled === true;
  return (
    <iframe
      ref={iframeRef}
      key={jsMode ? 'js' : 'declarative'}
      // eslint-disable-next-line react/no-danger-with-children
      sandbox="allow-scripts"
      {...(jsMode ? { src: `alfred-widget://widget/${job.id}` } : { srcDoc })}
      onLoad={() => {
        // Extra net: re-seed the freshest value after (re)load. The ready
        // handshake is the primary path; this covers the case where load fires
        // first. Both are idempotent (buffer + replay in the runtime).
        if (latestRef.current != null) post(latestRef.current);
      }}
      style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' }}
      title={job.title}
    />
  );
}
