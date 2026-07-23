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
    <div className="reference-chat no-drag" role="complementary" aria-label="Reference">
      <div className="reference-head">
        <span className="reference-badge">◈ REFERENCE</span>
        <span className="reference-title">
          <span className="kind">{kind} </span>
          <span className="name">{title}</span>
        </span>
        <button
          type="button"
          className="reference-close no-drag"
          onClick={onClose}
          title="Close (clears this ephemeral thread)"
        >
          ✕
        </button>
      </div>

      <div className="reference-body">
        {messages.length === 0 && !streaming ? (
          <div className="empty">
            Ask a focused question about this {kind.toLowerCase()}. Isolated — nothing here touches the main chat.
          </div>
        ) : (
          <ChatLog messages={messages} streaming={streaming} />
        )}
      </div>

      <form className="reference-form" onSubmit={submit}>
        <input
          className="reference-input no-drag"
          value={text}
          autoFocus
          placeholder={busy ? 'Thinking…' : 'Ask about this note…'}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="reference-send no-drag" disabled={busy || !text.trim()}>
          ↵
        </button>
      </form>
    </div>
  );
}
