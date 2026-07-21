/**
 * CommandBar — primary prompt input plus live agent status, budget readout and
 * kill switch. Submits on Enter (Shift+Enter = newline). App-driven (not
 * renderable via render_ui). Theme tokens: see Panel.tsx.
 */
import { useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';
import type { AgentStatus, BudgetState } from '../../main/core/types.ts';

export interface CommandBarProps {
  status: AgentStatus;
  killed: boolean;
  budget: BudgetState | null;
  onSubmit: (text: string) => void;
  onKill: () => void;
  /** Lets the parent focus the input programmatically (e.g. ⌘/Ctrl+K). */
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Fired on input focus/blur so the parent can keep the top strip revealed while typing. */
  onFocus?: () => void;
  onBlur?: () => void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--text-dim, #7c8ba1)',
  thinking: 'var(--neon-cyan, #22d3ee)',
  tool: 'var(--neon-green, #34d399)',
  'awaiting-approval': 'var(--neon-amber, #fbbf24)',
  error: 'var(--neon-red, #f87171)',
  done: 'var(--neon-green, #34d399)',
};

export function CommandBar({ status, killed, budget, onSubmit, onKill, inputRef, onFocus, onBlur }: CommandBarProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || killed) return;
    onSubmit(text);
    setValue('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle;

  return (
    <div
      className="alfred-commandbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--panel, #0e1420)',
        border: `1px solid ${killed ? 'var(--neon-red, #f87171)' : 'var(--neon-cyan, #22d3ee)'}`,
        borderRadius: 8,
        padding: '8px 12px',
        boxShadow: '0 0 14px -8px var(--neon-cyan, #22d3ee)',
      }}
    >
      <span
        aria-hidden
        title={status}
        style={{
          color,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          animation: status === 'thinking' || status === 'tool' ? 'alfred-pulse 1.2s ease-in-out infinite' : undefined,
        }}
      >
        {killed ? '×' : '›'}
      </span>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        rows={1}
        disabled={killed}
        placeholder={killed ? 'Kill switch engaged' : 'Ask Alfred…'}
        aria-label="Command input"
        style={{
          flex: 1,
          resize: 'none',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text, #e5eef7)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 14,
          lineHeight: 1.4,
        }}
      />
      {budget && (
        <span
          title="session / daily tokens"
          style={{
            color: 'var(--text-dim, #7c8ba1)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 11,
            whiteSpace: 'nowrap',
          }}
        >
          {budget.sessionTokens} · {budget.dailyTokens}/{budget.dailyLimit}
        </span>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={killed}
        style={{
          background: 'var(--neon-cyan, #22d3ee)',
          border: 'none',
          color: 'var(--bg, #080c14)',
          borderRadius: 6,
          padding: '6px 14px',
          cursor: killed ? 'not-allowed' : 'pointer',
          fontWeight: 700,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          opacity: killed ? 0.5 : 1,
        }}
      >
        Send
      </button>
      <button
        type="button"
        onClick={onKill}
        title="Kill switch — abort the running task"
        style={{
          background: 'transparent',
          border: '1px solid var(--neon-red, #f87171)',
          color: 'var(--neon-red, #f87171)',
          borderRadius: 6,
          padding: '6px 12px',
          cursor: 'pointer',
          fontWeight: 700,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}
      >
        Kill
      </button>
    </div>
  );
}
