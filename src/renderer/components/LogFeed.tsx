/**
 * LogFeed — scrolling activity/log lines with severity color.
 * Theme tokens: see Panel.tsx.
 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'ok';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  text: string;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: 'var(--neon-cyan, #22d3ee)',
  warn: 'var(--neon-amber, #fbbf24)',
  error: 'var(--neon-red, #f87171)',
  debug: 'var(--text-dim, #7c8ba1)',
  ok: 'var(--neon-green, #34d399)',
};

const fmt = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

export interface LogFeedProps {
  entries: LogEntry[];
}

export function LogFeed({ entries }: LogFeedProps) {
  return (
    <div
      className="alfred-logfeed"
      style={{
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12,
        lineHeight: 1.6,
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {entries.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <span style={{ color: 'var(--text-dim, #7c8ba1)', flexShrink: 0 }}>{fmt(e.ts)}</span>
          <span style={{ color: LEVEL_COLOR[e.level] ?? LEVEL_COLOR.info, flexShrink: 0, width: 44 }}>
            {e.level.toUpperCase()}
          </span>
          <span style={{ color: 'var(--text, #e5eef7)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {e.text}
          </span>
        </div>
      ))}
    </div>
  );
}
