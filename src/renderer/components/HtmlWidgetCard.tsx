/**
 * HtmlWidgetCard — a Tier-2 job widget (Phase 4, stage 4).
 *
 * Renders the model-authored self-contained page inside a locked-down
 * `<iframe sandbox="allow-scripts">` (NO allow-same-origin → opaque origin: no
 * DOM-parent / cookie / storage access; NO allow-popups/forms/top-navigation).
 * The page has zero network (a strict CSP in the wrapper blocks it). Data flows
 * ONE way: we subscribe to the SAME `job.data` stream (filtered by jobId) and
 * `postMessage` each value into the frame, where the trusted (hash-pinned) runtime
 * fills the model's `data-alfred*` bindings. No IPC/preload channel ever crosses
 * into the iframe, and the model authors no JS (its scripts are CSP-blocked).
 */
import { useEffect, useRef, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { wrapWidgetHtml } from '../../main/core/widget-html-pure.ts';
import type { Job, StreamEvent } from '../../main/core/types.ts';

export function HtmlWidgetCard({ job }: { job: Job }) {
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

  return (
    <iframe
      ref={iframeRef}
      // eslint-disable-next-line react/no-danger-with-children
      sandbox="allow-scripts"
      srcDoc={srcDoc}
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
