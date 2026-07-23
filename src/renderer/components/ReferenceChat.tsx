/**
 * ReferenceChat — a right-side overlay panel for the ISOLATED reference agent.
 *
 * It shows the target note's title, the ephemeral thread of Q&A, live streaming,
 * a follow-up input and a close button (closing clears the thread — it never
 * persists). It is fully decoupled from the main chat: App feeds it the scoped
 * reference.* stream by threadId. In Phase 3 the graph will call openReference()
 * with a node target; here it can be opened/tested directly.
 */
import { useState, type FormEvent } from 'react';
import type { ChatMessage } from '../../main/core/types.ts';
import { ChatLog } from './ChatLog.tsx';
import type { ReferenceTarget } from '../../main/core/reference.ts';

export interface ReferenceChatProps {
  target: ReferenceTarget;
  /** Human title for the header (note title / project name / raw ref). */
  title: string;
  messages: ChatMessage[];
  streaming: string;
  busy: boolean;
  onAsk: (question: string) => void;
  onClose: () => void;
}

export function ReferenceChat({ target, title, messages, streaming, busy, onAsk, onClose }: ReferenceChatProps) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    onAsk(q);
    setText('');
  };
  const kind = target.project ? 'PROJECT' : 'NOTE';

  return (
    <div
      className="reference-chat no-drag"
      role="complementary"
      aria-label="Reference"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(420px, 92vw)',
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--glass)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderLeft: '1px solid var(--cyan)',
        boxShadow: '0 0 44px -6px var(--cyan)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid rgba(53, 229, 255, 0.25)',
        }}
      >
        <span
          style={{
            color: 'var(--cyan)',
            border: '1px solid var(--cyan)',
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
          }}
        >
          ◈ REFERENCE
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--dim)', fontSize: 10 }}>{kind} </span>
          <span style={{ fontWeight: 600 }}>{title}</span>
        </span>
        <button
          type="button"
          className="no-drag"
          onClick={onClose}
          title="Close (clears this ephemeral thread)"
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6,
            color: 'var(--dim)',
            cursor: 'pointer',
            padding: '2px 8px',
            fontFamily: 'inherit',
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {messages.length === 0 && !streaming ? (
          <div className="empty" style={{ color: 'var(--dim)', fontSize: 12 }}>
            Ask a focused question about this {kind.toLowerCase()}. Isolated — nothing here touches the main chat.
          </div>
        ) : (
          <ChatLog messages={messages} streaming={streaming} />
        )}
      </div>

      <form
        onSubmit={submit}
        style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid rgba(53, 229, 255, 0.25)' }}
      >
        <input
          className="no-drag"
          value={text}
          autoFocus
          placeholder={busy ? 'Thinking…' : 'Ask about this note…'}
          onChange={(e) => setText(e.target.value)}
          style={{
            flex: 1,
            boxSizing: 'border-box',
            background: 'var(--panel-2, #131b2b)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 8,
            padding: '8px 10px',
            color: 'var(--text)',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        />
        <button
          type="submit"
          className="no-drag"
          disabled={busy || !text.trim()}
          style={{
            background: 'transparent',
            border: '1px solid var(--cyan)',
            borderRadius: 8,
            color: 'var(--cyan)',
            cursor: busy || !text.trim() ? 'default' : 'pointer',
            opacity: busy || !text.trim() ? 0.4 : 1,
            padding: '0 14px',
            fontFamily: 'inherit',
            fontWeight: 600,
          }}
        >
          ↵
        </button>
      </form>
    </div>
  );
}
