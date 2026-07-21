/**
 * AgentStatus — one agent's current state with a pulsing status dot.
 * Theme tokens: see Panel.tsx.
 */
import type { AgentStatus as AgentState } from '../../main/core/types.ts';

const STATE: Record<AgentState, { color: string; label: string; pulse: boolean }> = {
  idle: { color: 'var(--text-dim, #7c8ba1)', label: 'Idle', pulse: false },
  thinking: { color: 'var(--neon-cyan, #22d3ee)', label: 'Thinking', pulse: true },
  tool: { color: 'var(--neon-magenta, #e879f9)', label: 'Running tool', pulse: true },
  'awaiting-approval': { color: 'var(--neon-amber, #fbbf24)', label: 'Awaiting approval', pulse: true },
  error: { color: 'var(--neon-red, #f87171)', label: 'Error', pulse: false },
  done: { color: 'var(--neon-green, #34d399)', label: 'Done', pulse: false },
};

export interface AgentStatusProps {
  agent: string;
  state: AgentState;
  task?: string;
}

export function AgentStatus({ agent, state, task }: AgentStatusProps) {
  const s = STATE[state];
  return (
    <div
      className="alfred-agentstatus"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 13,
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: s.color,
          boxShadow: `0 0 8px ${s.color}`,
          animation: s.pulse ? 'alfred-pulse 1.2s ease-in-out infinite' : undefined,
          flexShrink: 0,
        }}
      />
      <span style={{ color: 'var(--text, #e5eef7)', fontWeight: 600 }}>{agent}</span>
      <span style={{ color: s.color }}>{s.label}</span>
      {task && <span style={{ color: 'var(--text-dim, #7c8ba1)', marginLeft: 'auto' }}>{task}</span>}
    </div>
  );
}
