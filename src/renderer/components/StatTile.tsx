/**
 * StatTile — single metric with optional unit and trend arrow.
 * Theme tokens: see Panel.tsx.
 */
import { type Accent, accentVar } from './Panel.tsx';

export interface StatTileProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Direction of change; drives arrow + color. */
  trend?: 'up' | 'down' | 'flat';
  accent?: Accent;
}

const TREND = {
  up: { glyph: '▲', color: 'var(--neon-green, #34d399)' },
  down: { glyph: '▼', color: 'var(--neon-red, #f87171)' },
  flat: { glyph: '▬', color: 'var(--text-dim, #7c8ba1)' },
} as const;

export function StatTile({ label, value, unit, trend, accent = 'cyan' }: StatTileProps) {
  const color = accentVar(accent);
  const t = trend ? TREND[trend] : null;
  return (
    <div
      className="alfred-stattile"
      style={{
        background: 'var(--panel, #0e1420)',
        border: '1px solid var(--border, #1e2a3a)',
        borderRadius: 8,
        padding: '12px 16px',
        minWidth: 120,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-dim, #7c8ba1)',
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 600, color, textShadow: `0 0 10px ${color}` }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: 13, color: 'var(--text-dim, #7c8ba1)' }}>{unit}</span>}
        {t && <span style={{ fontSize: 13, color: t.color, marginLeft: 'auto' }}>{t.glyph}</span>}
      </div>
    </div>
  );
}
