/**
 * ChatLog — conversation transcript. Assistant turns render through Markdown;
 * user/system/tool turns render as plain text.
 * App-driven (not renderable via render_ui). Theme tokens: see Panel.tsx.
 */
import { useEffect, useRef } from 'react';
import type { ChatMessage, ChatRole } from '../../main/core/types.ts';
import { Markdown } from './Markdown.tsx';

// Bubble language ported from the design canvas: the user's turns sit right and
// amber-tinted, Alfred's sit left and cyan-tinted; system/tool are muted/green.
const ROLE: Record<
  ChatRole,
  { label: string; color: string; align: 'flex-start' | 'flex-end'; border: string; bg: string }
> = {
  user: {
    label: 'Tu',
    color: 'var(--amb, #ffb45e)',
    align: 'flex-end',
    border: 'color-mix(in oklab, var(--amb) 40%, transparent)',
    bg: 'color-mix(in oklab, var(--amb) 7%, transparent)',
  },
  assistant: {
    label: 'Alfred',
    color: 'var(--acc, #59e8ff)',
    align: 'flex-start',
    border: 'color-mix(in oklab, var(--acc) 35%, transparent)',
    bg: 'color-mix(in oklab, var(--acc) 6%, transparent)',
  },
  system: {
    label: 'Sistema',
    color: 'var(--dim, #5b7a8a)',
    align: 'flex-start',
    border: 'color-mix(in oklab, var(--dim) 40%, transparent)',
    bg: 'rgba(0,0,0,0.25)',
  },
  tool: {
    label: 'Tool',
    color: 'var(--grn, #4dffa6)',
    align: 'flex-start',
    border: 'color-mix(in oklab, var(--grn) 35%, transparent)',
    bg: 'color-mix(in oklab, var(--grn) 6%, transparent)',
  },
};

export interface ChatLogProps {
  messages: ChatMessage[];
  /** In-flight assistant text being streamed (not yet a committed message). */
  streaming?: string;
}

export function ChatLog({ messages, streaming }: ChatLogProps) {
  const rows: { role: ChatRole; content: string; key: string }[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
    key: m.id,
  }));
  if (streaming) rows.push({ role: 'assistant', content: streaming, key: '__streaming__' });

  // Auto-scroll to the newest message / streamed token (same behaviour as the activity log).
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  return (
    <div className="alfred-chatlog" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((m) => {
        const r = ROLE[m.role] ?? ROLE.system;
        return (
          <div key={m.key} style={{ display: 'flex', flexDirection: 'column', alignItems: r.align }}>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: r.color,
                marginBottom: 4,
              }}
            >
              {r.label}
            </span>
            <div
              style={{
                maxWidth: '88%',
                background: r.bg,
                border: `1px solid ${r.border}`,
                borderRadius: 2,
                padding: '8px 10px',
                color: 'var(--text, #cfe8f2)',
                fontSize: 13,
              }}
            >
              {m.role === 'assistant' ? (
                <Markdown content={m.content} />
              ) : (
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</span>
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
