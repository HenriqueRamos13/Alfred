/**
 * HtmlWidgetCard — a Tier-2 job widget (Phase 4, stage 4).
 *
 * Renders the model-authored self-contained page inside a locked-down
 * `<iframe sandbox="allow-scripts">` (NO allow-same-origin → opaque origin: no
 * DOM-parent / cookie / storage access; NO allow-popups/forms/top-navigation).
 * The page has zero network (a strict CSP in the wrapper blocks it). Data flows
 * ONE way: we subscribe to the SAME `job.data` stream (filtered by jobId) and
 * `postMessage` each value into the frame, where the trusted runtime's
 * `Alfred.onData` delivers it. No IPC/preload channel ever crosses into the iframe.
 */
import { useEffect, useRef, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import { wrapWidgetHtml } from '../../main/core/widget-html-pure.ts';
import type { Job, StreamEvent } from '../../main/core/types.ts';

export function HtmlWidgetCard({ job }: { job: Job }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc] = useState(() => wrapWidgetHtml(job.render.html ?? ''));

  // Push the latest value into the frame. Seed from persisted lastResult once
  // the frame is loaded, then on every job.data refresh.
  useEffect(() => {
    const post = (value: unknown) => iframeRef.current?.contentWindow?.postMessage(value, '*');
    if (job.runtime.lastResult != null) post(job.runtime.lastResult);
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'job.data' && e.jobId === job.id) post(e.value);
    });
    return off;
  }, [job.id, job.runtime.lastResult]);

  return (
    <iframe
      ref={iframeRef}
      // eslint-disable-next-line react/no-danger-with-children
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      onLoad={() => {
        // Re-seed after (re)load so a late frame still gets the last value.
        if (job.runtime.lastResult != null) iframeRef.current?.contentWindow?.postMessage(job.runtime.lastResult, '*');
      }}
      style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' }}
      title={job.title}
    />
  );
}
