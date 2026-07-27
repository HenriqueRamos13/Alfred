/**
 * Inbox UI (Phase 7, stage 3) — the human side of async HITL. Renderer-safe: the
 * only domain imports are the *-pure modules (no node/electron). Two exports share
 * ONE view:
 *   - InboxView    — list + reader + ▶TTS + mic + typed actions. Reused by the
 *                    global overlay AND the ProjectModal Inbox tab (filtered).
 *   - InboxOverlay — the global overlay wrapper (the `.overlay` idiom).
 *
 * Typed actions (never a free-text yes/no guess): Aceitar / Editar & aceitar /
 * Responder / Rejeitar. Reject REQUIRES a reason (answerTransition enforces it in
 * code; the UI surfaces the refusal). Answering persists + emits inbox.changed;
 * the agent's automatic resume is Stage 4.
 *
 * Phase 8 stage 9 adds a second TAB — PEDIDOS (the asks above) | CONVERSAS (the
 * user's own direct threads with roster agents, rendered by AgentThreads in the SAME
 * .ib-list / .ib-read split). The conversation props are ALL optional: without them
 * (the ProjectModal's Inbox tab) the strip is hidden and the view behaves exactly as
 * it did before.
 */
import { useEffect, useRef, useState } from 'react';
import {
  unreadCount,
  type InboxAction,
  type InboxMessage,
} from '../../main/core/inbox-pure.ts';
import { buildBatchAnswer } from '../../main/core/inbox-multi-pure.ts';
import { openThreadAgentId, type ThreadInfo, type ThreadMessage } from '../../main/core/thread-pure.ts';
import type { TeamAgentInfo } from '../../main/core/types.ts';
import { ThreadsPane, ThreadView } from './AgentThreads.tsx';

/** Result shape of alfred.answerInbox. */
type AnswerResult = { ok: boolean; error?: string };

export interface InboxViewProps {
  messages: InboxMessage[];
  onAnswer: (id: string, action: InboxAction, text?: string) => Promise<AnswerResult>;
  onSpeak: (text: string) => void;
  onMarkRead: (id: string) => void;
  /** Open the origin card's project board (the card link). Optional. */
  onOpenCard?: (projectSlug: string) => void;
  // ── Direct conversations (Phase 8 stage 9). All optional, all supplied together:
  // the CONVERSAS tab appears only when the three handlers are wired. ──
  threads?: ThreadInfo[];
  agents?: TeamAgentInfo[];
  /** Transcript of the OPEN thread (App fetches it on open / on thread.changed). */
  threadMessages?: ThreadMessage[];
  /** Live agent reply for the open thread ('' = idle). */
  threadStreaming?: string;
  /** A real thread id, a `new:<agentId>` sentinel, or null. */
  openThreadId?: string | null;
  onOpenThread?: (threadId: string) => void;
  onNewThread?: (agentId: string) => void;
  onSendToAgent?: (text: string) => void;
}

/** Total unread agent replies across every thread — the CONVERSAS tab counter. */
export function threadsUnread(threads: readonly ThreadInfo[] | undefined): number {
  return (threads ?? []).reduce((n, t) => n + (t.unread || 0), 0);
}

function initials(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '·';
}

/** "há 4 min" / "há 2 h" / "agora" — coarse age of an ask. */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'agora';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function InboxView({
  messages,
  onAnswer,
  onSpeak,
  onMarkRead,
  onOpenCard,
  threads,
  agents,
  threadMessages,
  threadStreaming,
  openThreadId,
  onOpenThread,
  onNewThread,
  onSendToAgent,
}: InboxViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  // P5 multi-question drafts, keyed by question id (only used when selected.questions).
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'pedidos' | 'conversas'>('pedidos');
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const now = Date.now();

  // The conversation surface only exists when App wired it (the ProjectModal reuse
  // passes none of it) — fail-closed: no handlers, no tab strip, no behaviour change.
  // Bundled into one object so the branch below narrows without non-null assertions.
  const chat =
    onOpenThread && onNewThread && onSendToAgent ? { onOpenThread, onNewThread, onSendToAgent } : null;
  const openThread = (threads ?? []).find((t) => t.id === openThreadId) ?? null;
  const openAgentId = openThreadAgentId(openThreadId, threads ?? []);
  const openAgent = (agents ?? []).find((a) => a.id === openAgentId);

  // Default-select the first message; keep a valid selection as the list changes.
  const selected = messages.find((m) => m.id === selectedId) ?? messages[0] ?? null;

  // Opening a message marks it read (drops the unread dot / badge). Idempotent.
  useEffect(() => {
    if (selected && selected.readTs == null) onMarkRead(selected.id);
    // Reset the draft when switching messages.
    setReply('');
    setAnswers({});
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const answer = async (action: InboxAction) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    const res = await onAnswer(selected.id, action, reply);
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'inbox error');
    else setReply('');
  };

  // P5: serialise every per-question draft into one JSON answer and submit once.
  const answerAll = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    const res = await onAnswer(selected.id, 'respond', buildBatchAnswer(answers));
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'inbox error');
    else setAnswers({});
  };

  // PEDIDOS | CONVERSAS. Rendered only with the conversation props wired, and reused
  // by both branches below (one strip, one place to change a label).
  const tabsUnread = threadsUnread(threads);
  const tabs = chat && (
    <div className="pm-tabs ib-tabs">
      <button
        type="button"
        className={`no-drag${tab === 'pedidos' ? ' on' : ''}`}
        onClick={() => setTab('pedidos')}
        title="Perguntas que os agentes te fizeram (HITL assíncrono)"
      >
        Pedidos
      </button>
      <button
        type="button"
        className={`no-drag${tab === 'conversas' ? ' on' : ''}`}
        onClick={() => setTab('conversas')}
        title="As tuas conversas diretas com os agentes do roster"
      >
        Conversas{tabsUnread > 0 ? ` ${tabsUnread}` : ''}
      </button>
    </div>
  );

  if (chat && tab === 'conversas') {
    return (
      <div className="ib-wrap">
        {tabs}
        <div className="ib-view">
          <ThreadsPane
            threads={threads ?? []}
            agents={agents ?? []}
            openThreadId={openThreadId ?? null}
            onOpenThread={chat.onOpenThread}
            onNewThread={chat.onNewThread}
          />
          <ThreadView
            thread={openThread}
            agentName={openAgent?.name?.trim() || openAgentId}
            // Resolved, never guessed: an id with no roster row = the agent was deleted.
            agentGone={!!openAgentId && !openAgent}
            messages={threadMessages ?? []}
            streaming={threadStreaming ?? ''}
            onSend={chat.onSendToAgent}
          />
        </div>
      </div>
    );
  }

  const asks = (
    <div className="ib-view">
      <div className="ib-list">
        {messages.length === 0 ? (
          <div className="empty ib-empty">INBOX EMPTY</div>
        ) : (
          messages.map((m) => {
            const unread = m.readTs == null && m.status !== 'superseded';
            return (
              <div
                key={m.id}
                className={`ib-msg${m.id === selected?.id ? ' sel' : ''}${unread ? ' unread' : ''}`}
                onClick={() => setSelectedId(m.id)}
                role="button"
                tabIndex={0}
              >
                {unread && <span className="ib-un" />}
                <div className="ib-from">
                  <span className="ib-av">{initials(m.fromAgentId)}</span>
                  {m.fromAgentId}
                  <span className="ib-tm">{ago(m.createdTs, now)}</span>
                </div>
                <div className="ib-subj">{m.subject}</div>
                <div className="ib-prev">{m.status !== 'pending' ? `[${m.status}] ` : ''}{m.body || '—'}</div>
              </div>
            );
          })
        )}
      </div>

      <div className="ib-read">
        {!selected ? (
          <div className="empty ib-empty">SELECT A MESSAGE</div>
        ) : (
          <>
            <div className="ib-rh">
              <span className="ib-av big">{initials(selected.fromAgentId)}</span>
              <h3>{selected.subject}</h3>
            </div>
            <div className="ib-prov">
              de <b>{selected.fromAgentId}</b>
              {selected.projectSlug && (
                <>
                  {' · '}
                  {onOpenCard && selected.cardId ? (
                    <button type="button" className="ib-cardlink no-drag" onClick={() => onOpenCard(selected.projectSlug!)} title="Abre o board de origem">
                      {selected.cardId} ↗
                    </button>
                  ) : (
                    <span className="ib-cardlink">{selected.cardId ?? selected.projectSlug}</span>
                  )}
                </>
              )}
              <span className="ib-kind">{selected.kind}</span>
              {selected.status === 'pending' && <span className="ib-waiting">⏳ à espera {ago(selected.createdTs, now)}</span>}
              {selected.status !== 'pending' && <span className={`ib-state ${selected.status}`}>{selected.status}</span>}
            </div>

            <div className="ib-tools">
              <button type="button" className="ib-play no-drag" onClick={() => onSpeak(`${selected.subject}. ${selected.body}`)} title="Ouvir (TTS)">
                ▶ Ouvir
              </button>
              <button
                type="button"
                className="ib-mic no-drag"
                onClick={() => replyRef.current?.focus()}
                title="Responder por voz — foca a caixa para ditares a resposta"
              >
                🎙 Voz
              </button>
            </div>

            <div className="ib-body">{selected.body || '—'}</div>

            {selected.status === 'pending' && selected.questions && selected.questions.length > 0 ? (
              <div className="ib-reply ib-multi">
                <div className="ib-reply-note">{selected.questions.length} perguntas — responde todas e envia de uma vez ↩</div>
                {selected.questions.map((q) => (
                  <div key={q.id} className="ib-qcard">
                    <div className="ib-qprompt">{q.prompt}</div>
                    <textarea
                      className="no-drag"
                      value={answers[q.id] ?? ''}
                      onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                      placeholder="A tua resposta…"
                    />
                  </div>
                ))}
                {error && <div className="ib-error">⚠ {error}</div>}
                <div className="ib-actions">
                  <button type="button" className="ib-act acc no-drag" disabled={busy} onClick={answerAll} title="Envia todas as respostas de uma vez; o agente retoma numa só operação">↩ Responder tudo</button>
                </div>
              </div>
            ) : selected.status === 'pending' ? (
              <div className="ib-reply">
                <div className="ib-reply-note">Interação tipada — a resposta re-acorda o agente ↩ (rejeitar exige motivo)</div>
                <textarea
                  ref={replyRef}
                  className="no-drag"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Resposta / motivo (ex: usa test keys em staging; abre card T2 para live)"
                />
                {error && <div className="ib-error">⚠ {error}</div>}
                <div className="ib-actions">
                  <button type="button" className="ib-act acc no-drag" disabled={busy} onClick={() => answer('accept')} title="Aceita a proposta como está">✓ Aceitar</button>
                  <button type="button" className="ib-act edt no-drag" disabled={busy} onClick={() => answer('edit')} title="Corrige os args propostos antes de aprovar">✎ Editar &amp; aceitar</button>
                  <button type="button" className="ib-act no-drag" disabled={busy} onClick={() => answer('respond')} title="Responde em texto; o agente continua com o contexto">↩ Responder</button>
                  <button type="button" className="ib-act rej no-drag" disabled={busy} onClick={() => answer('reject')} title="Rejeita — motivo obrigatório, volta como contexto ao agente">✕ Rejeitar</button>
                </div>
              </div>
            ) : (
              <div className="ib-answered">
                <div className="ib-answered-h">{selected.action ? `${selected.action} ·` : ''} {selected.status}</div>
                {selected.answer && <div className="ib-answered-b">{selected.answer}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return chat ? (
    <div className="ib-wrap">
      {tabs}
      {asks}
    </div>
  ) : (
    asks
  );
}

export interface InboxOverlayProps extends InboxViewProps {
  onClose: () => void;
}

/** The global Inbox as a full overlay (opened from the header INBOX button). */
export function InboxOverlay({ onClose, messages, ...rest }: InboxOverlayProps) {
  // Both surfaces behind the button, so the header count matches the header badge.
  const unread = unreadCount(messages) + threadsUnread(rest.threads);
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pm-panel ib-panel no-drag" role="dialog" aria-label="Inbox">
        <div className="pm-head">
          <span className="pm-dot" />
          <h2 className="pm-name">Inbox</h2>
          <span className="pm-status">{unread} NÃO LIDAS</span>
          <button type="button" className="pm-x no-drag" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="pm-body ib-panel-body">
          <InboxView messages={messages} {...rest} />
        </div>
      </div>
    </div>
  );
}
