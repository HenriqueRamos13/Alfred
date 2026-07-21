/**
 * Panel — titled neon container.
 * Theme tokens (defined in theme.css): --panel, --border, --text, --text-dim,
 * --neon-cyan, --neon-magenta, --neon-green, --neon-amber, --neon-red, --font-mono.
 * Fallback values are inlined so components still render before the theme loads.
 */
import type { ReactNode } from 'react';

export type Accent = 'cyan' | 'magenta' | 'green' | 'amber' | 'red';

export const accentVar = (accent: Accent = 'cyan'): string =>
  ({
    cyan: 'var(--neon-cyan, #22d3ee)',
    magenta: 'var(--neon-magenta, #e879f9)',
    green: 'var(--neon-green, #34d399)',
    amber: 'var(--neon-amber, #fbbf24)',
    red: 'var(--neon-red, #f87171)',
  })[accent];

export interface PanelProps {
  title: string;
  accent?: Accent;
  children?: ReactNode;
}

export function Panel({ title, accent = 'cyan', children }: PanelProps) {
  const color = accentVar(accent);
  return (
    <section
      className="alfred-panel"
      style={{
        background: 'var(--panel, #0e1420)',
        border: '1px solid var(--border, #1e2a3a)',
        borderTop: `2px solid ${color}`,
        borderRadius: 8,
        boxShadow: `0 0 12px -6px ${color}`,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '8px 14px',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color,
          borderBottom: '1px solid var(--border, #1e2a3a)',
        }}
      >
        {title}
      </header>
      <div style={{ padding: 14, color: 'var(--text, #e5eef7)' }}>{children}</div>
    </section>
  );
}
