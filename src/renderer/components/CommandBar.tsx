/**
 * CommandBar — primary prompt input plus live agent status, budget readout and
 * kill switch. Submits on Enter (Shift+Enter = newline). App-driven (not
 * renderable via render_ui). Theme tokens: see Panel.tsx.
 */
import { useEffect, useRef, useState } from 'react';
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
  /** Voice input (push-to-talk): true while the mic is recording. */
  listening?: boolean;
  /** Live partial transcript to preview while listening. */
  partial?: string;
  /** Toggle the mic (start/stop listening). */
  onMic?: () => void;
  /** A settled transcript to drop into the input; appended when `seq` changes. */
  dictation?: { text: string; seq: number };
  /** Bumped by a bare voice "enviar" command → submit the current input value. */
  submitSignal?: number;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--text-dim, #7c8ba1)',
  thinking: 'var(--neon-cyan, #22d3ee)',
  tool: 'var(--neon-green, #34d399)',
  'awaiting-approval': 'var(--neon-amber, #fbbf24)',
  error: 'var(--neon-red, #f87171)',
  done: 'var(--neon-green, #34d399)',
};

export function CommandBar({
  status,
  killed,
  budget,
  onSubmit,
  onKill,
  inputRef,
  onFocus,
  onBlur,
  listening,
  partial,
  onMic,
  dictation,
  submitSignal,
}: CommandBarProps) {
  const [value, setValue] = useState('');

  // Drop a settled voice transcript into the input (the user still hits Enter).
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!dictation || dictation.seq === lastSeq.current) return;
    lastSeq.current = dictation.seq;
    const t = dictation.text.trim();
    if (t) setValue((v) => (v ? `${v} ${t}` : t));
  }, [dictation]);

  const submit = () => {
    const text = value.trim();
    if (!text || killed) return;
    onSubmit(text);
    setValue('');
  };

  // A bare "Alfred, enviar" voice command submits whatever is in the input now.
  const lastSubmit = useRef(0);
  useEffect(() => {
    if (submitSignal === undefined || submitSignal === lastSubmit.current) return;
    lastSubmit.current = submitSignal;
    submit();
    // submit() reads the latest `value`/`killed` via closure on this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitSignal]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div
      className="alfred-commandbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--glass)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: `1px solid ${killed ? 'var(--neon-red, #f87171)' : 'rgba(64,224,255,0.4)'}`,
        borderRadius: 12,
        padding: '10px 14px',
        boxShadow: killed
          ? 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 22px rgba(255,59,82,0.28)'
          : 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 26px rgba(53,229,255,0.18)',
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
      {onMic && (
        <button
          type="button"
          onClick={onMic}
          disabled={killed}
          title={listening ? 'Listening — click to stop' : 'Voice input — click to dictate'}
          aria-label={listening ? 'Stop voice input' : 'Start voice input'}
          aria-pressed={listening}
          style={{
            background: listening ? 'var(--neon-red, #f87171)' : 'transparent',
            border: `1px solid ${listening ? 'var(--neon-red, #f87171)' : 'var(--neon-cyan, #22d3ee)'}`,
            color: listening ? 'var(--bg, #080c14)' : 'var(--neon-cyan, #22d3ee)',
            borderRadius: 6,
            padding: '6px 12px',
            cursor: killed ? 'not-allowed' : 'pointer',
            fontWeight: 700,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            opacity: killed ? 0.5 : 1,
            animation: listening ? 'alfred-pulse 1.2s ease-in-out infinite' : undefined,
          }}
        >
          {listening ? '● REC' : '🎙'}
        </button>
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
    {listening && (
      <div
        aria-live="polite"
        style={{
          color: 'var(--text-dim, #7c8ba1)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          padding: '0 12px',
          fontStyle: 'italic',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {partial ? partial : 'Listening…'}
      </div>
    )}
    </div>
  );
}
