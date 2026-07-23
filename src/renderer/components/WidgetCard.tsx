/**
 * WidgetCard — a Tier-1 job data widget (Phase 4, stage 3).
 *
 * Renders one scheduled job's latest value per `render.card`:
 *   - a numeric/scalar VALUE + label (+ unit when the payload carries one),
 *   - a SPARKLINE (inline SVG, no charting dependency) for a numeric series,
 *   - a compact fallback for anything else.
 *
 * Live: seeds from the job's persisted runtime.lastResult, then subscribes to the
 * SAME `job.data` stream (filtered by jobId) so the value updates the moment a
 * fetch/agent refresh fires. Self-contained — no new tools, no IPC round-trip.
 */
import { useEffect, useState } from 'react';
import { alfred } from '../lib/ipc.ts';
import type { Job, StreamEvent } from '../../main/core/types.ts';

/** A finite-number array (a plottable series) → the numbers; else null. */
function asSeries(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const nums = v.map((x) => (typeof x === 'number' ? x : typeof x === 'object' && x && typeof (x as { value?: unknown }).value === 'number' ? (x as { value: number }).value : NaN));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/** Pull a scalar value + optional unit out of a payload (weather-style objects supported). */
function asScalar(v: unknown): { value: string; unit?: string } | null {
  if (typeof v === 'number' || typeof v === 'string') return { value: String(v) };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const val = o.value ?? o.temperature ?? o.temp ?? o.val;
    if (typeof val === 'number' || typeof val === 'string') {
      const unit = typeof o.unit === 'string' ? o.unit : undefined;
      return { value: String(val), unit };
    }
  }
  return null;
}

function Sparkline({ data }: { data: number[] }) {
  const w = 200;
  const h = 46;
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const n = data.length - 1 || 1;
  const pts = data
    .map((v, i) => {
      const x = pad + (i / n) * (w - 2 * pad);
      const y = h - pad - ((v - min) / span) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = pts.split(' ').at(-1)?.split(',').map(Number) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke="var(--cyan, #35e5ff)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--cyan, #35e5ff)" />
    </svg>
  );
}

export function WidgetCard({ job }: { job: Job }) {
  const [value, setValue] = useState<unknown>(job.runtime.lastResult ?? null);

  useEffect(() => {
    setValue(job.runtime.lastResult ?? null);
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'job.data' && e.jobId === job.id) setValue(e.value);
    });
    return off;
  }, [job.id, job.runtime.lastResult]);

  const series = asSeries(value);
  const scalar = series ? null : asScalar(value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, justifyContent: 'center' }}>
      {series ? (
        <>
          <Sparkline data={series} />
          <div style={{ fontSize: 22, fontWeight: 700, textAlign: 'center' }}>{series.at(-1)}</div>
        </>
      ) : scalar ? (
        <div style={{ textAlign: 'center' }}>
          <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1 }}>{scalar.value}</span>
          {scalar.unit && <span style={{ fontSize: 16, color: 'var(--dim)', marginLeft: 4 }}>{scalar.unit}</span>}
        </div>
      ) : value == null ? (
        <div className="empty" style={{ textAlign: 'center' }}>SEM DADOS AINDA</div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text)', opacity: 0.85, wordBreak: 'break-word', maxHeight: '100%', overflow: 'auto' }}>
          {typeof value === 'string' ? value : JSON.stringify(value)}
        </div>
      )}
    </div>
  );
}
