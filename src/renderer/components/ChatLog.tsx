/**
 * ChatLog — conversation transcript. Assistant turns render through Markdown;
 * user/system/tool turns render as plain text.
 * App-driven (not renderable via render_ui). Theme tokens: see Panel.tsx.
 */
import type { ChatMessage, ChatRole } from '../../main/core/types.ts';
import { Markdown } from './Markdown.tsx';

const ROLE: Record<ChatRole, { label: string; color: string; align: 'flex-start' | 'flex-end' }> = {
  user: { label: 'You', color: 'var(--neon-cyan, #22d3ee)', align: 'flex-end' },
  assistant: { label: 'Alfred', color: 'var(--neon-magenta, #e879f9)', align: 'flex-start' },
  system: { label: 'System', color: 'var(--text-dim, #7c8ba1)', align: 'flex-start' },
  tool: { label: 'Tool', color: 'var(--neon-green, #34d399)', align: 'flex-start' },
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

  return (
    <div className="alfred-chatlog" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((m) => {
        const r = ROLE[m.role] ?? ROLE.system;
        return (
          <div key={m.key} style={{ display: 'flex', flexDirection: 'column', alignItems: r.align }}>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: r.color,
                marginBottom: 4,
              }}
            >
              {r.label}
            </span>
            <div
              style={{
                maxWidth: '85%',
                background: 'var(--panel-2, #131b2b)',
                border: `1px solid var(--border, #1e2a3a)`,
                borderLeft: `2px solid ${r.color}`,
                borderRadius: 8,
                padding: '8px 12px',
                color: 'var(--text, #e5eef7)',
                fontSize: 14,
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
    </div>
  );
}
