/**
 * AgentThreads — the USER's side of a direct conversation with a roster agent
 * (Phase 8, stage 9). Two exports, both PROPS-DRIVEN (the ReferenceChat idiom: zero
 * `alfred.*` calls, zero fetching — App owns the state, the stream and the sends, so
 * these render identically inside the Inbox overlay and the project modal):
 *   - ThreadsPane — the left column: one row per thread + the "✎ Nova conversa" picker.
 *   - ThreadView  — the right column: bubbles + per-message status chips + composer.
 *
 * Renderer-safe: the only domain imports are the *-pure modules (thread-pure for the
 * chip vocabulary + shapes, jobs-format-pure for the relative clock) and a type-only
 * TeamAgentInfo. No node/electron anywhere.
 *
 * A conversation can be OPEN before it exists: a `new:<agentId>` sentinel (see
 * thread-pure) arrives here as `thread: null` + a resolved `agentName`, so the user
 * types into an empty history and the first send mints the real thread.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { statusChipPt, type ThreadInfo, type ThreadMessage } from '../../main/core/thread-pure.ts';
import { relativeTime } from '../../main/core/jobs-format-pure.ts';
import type { TeamAgentInfo } from '../../main/core/types.ts';

/**
 * Avatar initials. Deliberately local (Inbox.tsx has its own): Inbox IMPORTS this
 * module for the CONVERSAS tab, so importing back would close a module cycle.
 */
function initials(label: string): string {
  return label.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '·';
}

/** Display name for an agent id — its roster name, the raw id when it's gone. */
function nameOf(agents: readonly TeamAgentInfo[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.name?.trim() || agentId;
}

function ActiveThreadStatus({ label, since }: { label: string; since: number }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((clock - since) / 1000));
  const time = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  return <span className="th-chip s-executing">{label} · {time}</span>;
}

export interface ThreadsPaneProps {
  threads: ThreadInfo[];
  agents: TeamAgentInfo[];
  openThreadId: string | null;
  onOpenThread: (threadId: string) => void;
  onNewThread: (agentId: string) => void;
}

export function ThreadsPane({ threads, agents, openThreadId, onOpenThread, onNewThread }: ThreadsPaneProps) {
  const now = Date.now();
  return (
    <div className="ib-list th-list">
      {/* Controlled with a constant empty value → the picker RESETS after each pick,
          so the same agent can be chosen twice in a row. */}
      <div className="th-new">
        <select
          className="th-pick no-drag"
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id) onNewThread(id);
          }}
          title="Abre uma conversa direta com um agente do roster"
        >
          <option value="">✎ Nova conversa — falar com…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name?.trim() || a.id}
            </option>
          ))}
        </select>
      </div>

      {threads.length === 0 ? (
        <div className="empty ib-empty">SEM CONVERSAS</div>
      ) : (
        threads.map((t) => {
          const label = nameOf(agents, t.agentId);
          return (
            <div
              key={t.id}
              className={`ib-msg th-row no-drag${t.id === openThreadId ? ' sel' : ''}${t.unread > 0 ? ' unread' : ''}`}
              onClick={() => onOpenThread(t.id)}
              role="button"
              tabIndex={0}
            >
              <div className="ib-from">
                <span className="ib-av">{initials(label)}</span>
                {label}
                <span className="ib-tm">{relativeTime(t.lastTs, now)}</span>
              </div>
              <div className="ib-prev">{t.lastBody || '—'}</div>
              {t.unread > 0 && <span className="th-badge">{t.unread}</span>}
            </div>
          );
        })
      )}
    </div>
  );
}

export interface ThreadViewProps {
  /** The persisted thread, or null for a `new:` sentinel (agentName still set). */
  thread: ThreadInfo | null;
  /** Resolved display name of the agent on the other side ('' = nothing open). */
  agentName: string;
  /** The agent was deleted from the roster: history stays readable, composing is refused. */
  agentGone: boolean;
  messages: ThreadMessage[];
  /** Live reply text accumulating from agent.chat.delta ('' = not streaming). */
  streaming: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function ThreadView({ thread, agentName, agentGone, messages, streaming, onSend, onCancel }: ThreadViewProps) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the newest bubble / streamed token (the ChatLog behaviour).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  // Nothing open at all — a sentinel has no `thread` but DOES have a name.
  if (!thread && !agentName) {
    return (
      <div className="ib-read th-read">
        <div className="empty ib-empty">ESCOLHE UMA CONVERSA</div>
      </div>
    );
  }

  const submit = () => {
    const t = text.trim();
    if (!t || agentGone) return;
    onSend(t);
    setText('');
  };
  const busy =
    !!streaming || messages.some((message) => ['queued', 'delivered', 'read', 'executing'].includes(message.status));
  // Enter envia, Shift+Enter nova linha (the composer idiom of the command bar).
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="ib-read th-read">
      <div className="th-head">
        <span className="ib-av big">{initials(agentName)}</span>
        <h3>{agentName}</h3>
        <span className="th-head-meta">{thread ? 'conversa direta' : 'nova conversa'}</span>
      </div>

      <div className="th-msgs">
        {messages.length === 0 && !streaming && (
          <div className="empty th-empty">Ainda sem mensagens — escreve a primeira.</div>
        )}
        {messages.map((m) => {
          const mine = m.author === 'user';
          return (
            <div key={m.id} className={`th-msg ${mine ? 'user' : 'agent'}`}>
              <div className="th-bubble">{m.body}</div>
              {mine && (
                ['queued', 'delivered', 'read', 'executing'].includes(m.status) ? (
                  <ActiveThreadStatus label={statusChipPt(m.status)} since={m.startedTs ?? m.createdTs} />
                ) : (
                  <span className={`th-chip s-${m.status}`} title={m.error ?? ''}>
                    {statusChipPt(m.status)}
                  </span>
                )
              )}
              {m.status === 'error' && m.error && <div className="th-err">⚠ {m.error}</div>}
            </div>
          );
        })}
        {streaming && (
          <div className="th-msg agent">
            <div className="th-bubble">
              {streaming}
              <span className="th-cursor" />
            </div>
            <ActiveThreadStatus
              label="a responder"
              since={
                messages.findLast((message) => ['queued', 'delivered', 'read', 'executing'].includes(message.status))
                  ?.startedTs ?? Date.now()
              }
            />
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="th-composer">
        {agentGone && <div className="th-gone">⚠ agente removido do roster</div>}
        <textarea
          className="no-drag"
          value={text}
          disabled={agentGone}
          placeholder={agentGone ? 'conversa fechada' : 'Enter envia · Shift+Enter nova linha'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="th-send no-drag"
          disabled={busy ? !thread : agentGone || !text.trim()}
          onClick={busy ? onCancel : submit}
          title={busy ? 'Interrompe o turno atual e limpa a fila desta conversa' : 'Envia a mensagem ao agente'}
        >
          {busy ? 'PARAR' : 'ENVIAR'}
        </button>
      </div>
    </div>
  );
}
