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

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

/** Optional extras a weather-like payload MAY carry — every field is best-effort
 * and only rendered when present (never fabricated). */
interface Weather {
  conditions?: string;
  wind?: string;
  max?: string;
  min?: string;
  humidity?: string;
  forecast?: { label?: string; value: number }[];
}
function asWeather(v: unknown): Weather | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const w: Weather = {
    conditions: str(o.conditions ?? o.description ?? o.summary ?? o.weather),
    wind: str(o.wind ?? o.windSpeed ?? o.wind_speed),
    max: str(o.max ?? o.tempMax ?? o.temp_max ?? o.high),
    min: str(o.min ?? o.tempMin ?? o.temp_min ?? o.low),
    humidity: str(o.humidity ?? o.hum),
  };
  const fc = o.forecast ?? o.daily ?? o.days;
  if (Array.isArray(fc)) {
    const parsed = fc
      .map((d) => {
        if (typeof d === 'number') return { value: d };
        if (d && typeof d === 'object') {
          const r = d as Record<string, unknown>;
          const val = r.value ?? r.temp ?? r.temperature ?? r.max ?? r.high;
          if (typeof val === 'number') return { label: str(r.label ?? r.day ?? r.date), value: val };
        }
        return null;
      })
      .filter((x): x is { label?: string; value: number } => x != null);
    if (parsed.length) w.forecast = parsed.slice(0, 7);
  }
  return w.conditions || w.wind || w.max || w.min || w.humidity || w.forecast ? w : null;
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 220;
  const h = 64;
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
      <polyline points={`${pts} ${w},${h} 0,${h}`} fill={color} fillOpacity={0.1} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}

/** Forecast bars (only shown when the payload actually carries a forecast). */
function ForecastBars({ days }: { days: { label?: string; value: number }[] }) {
  const min = Math.min(...days.map((d) => d.value));
  const max = Math.max(...days.map((d) => d.value));
  const span = max - min || 1;
  return (
    <div style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'flex-end', paddingBottom: 4 }}>
      {days.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--amb)' }}>{Math.round(d.value)}°</span>
          <div
            style={{
              width: '100%',
              maxWidth: 38,
              height: `${30 + (55 * (d.value - min)) / span}%`,
              background: 'linear-gradient(180deg, var(--amb), var(--acc))',
              opacity: 0.85,
              borderRadius: '2px 2px 0 0',
            }}
          />
          {d.label && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--dim)' }}>{d.label}</span>}
        </div>
      ))}
    </div>
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
  const weather = series || !scalar ? null : asWeather(value);

  // Series (e.g. Bitcoin): big current value + Δ% vs the window start, colour by sign.
  if (series) {
    const first = series[0];
    const last = series.at(-1)!;
    const deltaPct = first ? ((last / first - 1) * 100) : 0;
    const up = deltaPct >= 0;
    const color = up ? 'var(--grn, #4dffa6)' : 'var(--red, #ff5f6e)';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--amb)' }}>
            {last.toLocaleString()}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color }}>
            {up ? '+' : ''}
            {deltaPct.toFixed(1)}%
          </span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--dim)', letterSpacing: '0.14em' }}>
          {series.length} PONTOS
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Sparkline data={series} color="var(--amb, #ffb45e)" />
        </div>
      </div>
    );
  }

  // Weather-like object: big temperature + conditions + máx/mín/hum + 7-day bars.
  if (scalar && weather) {
    return (
      <div style={{ display: 'flex', gap: 20, height: '100%', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 130 }}>
          <div
            style={{
              fontSize: 48,
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              lineHeight: 1,
              background: 'linear-gradient(180deg, var(--amb), var(--acc))',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {scalar.value}
            {scalar.unit ?? '°'}
          </div>
          {weather.conditions && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              {weather.conditions}
              {weather.wind && ` · vento ${weather.wind}`}
            </div>
          )}
          {(weather.max || weather.min || weather.humidity) && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--dim)', letterSpacing: '0.12em', marginTop: 4 }}>
              {[weather.max && `máx ${weather.max}°`, weather.min && `mín ${weather.min}°`, weather.humidity && `hum ${weather.humidity}%`]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
        {weather.forecast && <ForecastBars days={weather.forecast} />}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, justifyContent: 'center' }}>
      {scalar ? (
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
