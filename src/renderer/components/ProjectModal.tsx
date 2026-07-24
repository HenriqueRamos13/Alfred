/**
 * ProjectModal — the per-project floating modal (Phase 7, stage 1). Follows the
 * `.overlay` idiom (sibling of .canvas, like ApprovalPrompt / ReferenceChat): a
 * backdrop that closes on outside-click + ✕, a header, and a tab bar. Only
 * Overview + Board are functional this stage; Org/Team/Activity are placeholders.
 *
 * The Board is the deliverable: 7 lanes read from listCards, HTML5 drag between
 * lanes (→ kanban move_card), a WIP count per lane header, and a card-detail
 * sub-overlay that edits a card (→ update_card) or deletes it (→ delete_card) and
 * shows the Done-gate. Renderer-safe: it imports only kanban-pure (no node/electron)
 * — the SAME column graph + Done-gate the main process enforces.
 */
import { useState, type DragEvent, type ReactNode } from 'react';
import {
  CARD_COLUMNS,
  PRIORITIES,
  canMoveColumn,
  doneGateDecision,
  type CardColumn,
  type ChecklistItem,
  type KanbanCard,
  type Priority,
} from '../../main/core/kanban-pure.ts';
import type { ProjectDetail } from '../../main/core/projects.ts';

/** Result shape of alfred.kanban(op, args). */
type KanbanResult = { ok: boolean; error?: string; reasons?: string[] };

export interface ProjectModalProps {
  detail: ProjectDetail | null;
  cards: KanbanCard[];
  onKanban: (op: string, args: Record<string, unknown>) => Promise<KanbanResult>;
  onClose: () => void;
}

type Tab = 'overview' | 'board' | 'org' | 'team' | 'activity';

const LANES: { key: CardColumn; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'To-Do' },
  { key: 'doing', label: 'Doing' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'failed', label: 'Failed' },
];

function initials(id: string | null): string {
  if (!id) return '·';
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '·';
}

export function ProjectModal({ detail, cards, onKanban, onClose }: ProjectModalProps) {
  const [tab, setTab] = useState<Tab>('board');
  const [selected, setSelected] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string>('');

  const m = detail?.manifest;
  const selectedCard = selected ? cards.find((c) => c.id === selected) ?? null : null;

  const run = async (op: string, args: Record<string, unknown>) => {
    setError('');
    const res = await onKanban(op, args);
    if (!res.ok) setError((res.error ?? 'kanban error') + (res.reasons?.length ? `: ${res.reasons.join('; ')}` : ''));
    return res;
  };

  const onDrop = async (to: CardColumn, e: DragEvent) => {
    e.preventDefault();
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const card = cards.find((c) => c.id === id);
    if (!card || card.column === to) return;
    await run('move_card', { id, column: to });
  };

  const doneCount = cards.filter((c) => c.column === 'done').length;

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pm-panel no-drag" role="dialog" aria-label={`Project ${m?.name ?? ''}`}>
        <div className="pm-head">
          <span className="pm-dot" />
          <h2 className="pm-name">{m?.name ?? detail?.manifest.slug ?? 'Project'}</h2>
          <span className="pm-slug">
            {m?.slug}
            {m?.stack ? ` · ${m.stack}` : ''}
          </span>
          <span className="pm-status">{(m?.status ?? 'unknown').toUpperCase()}</span>
          <button type="button" className="pm-x no-drag" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="pm-tabs">
          {(['overview', 'board', 'org', 'team', 'activity'] as Tab[]).map((t) => (
            <button key={t} type="button" className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
              {t === 'board' && <span className="pm-n"> {cards.length}</span>}
            </button>
          ))}
        </div>

        {error && <div className="pm-error">⚠ {error}</div>}

        <div className="pm-body">
          {tab === 'overview' && (
            <div className="pm-overview">
              <div className="pm-stats">
                <Stat n={cards.length} label="Cards" />
                <Stat n={cards.filter((c) => c.column === 'doing').length} label="In Doing" />
                <Stat n={cards.filter((c) => c.column === 'blocked' || c.column === 'failed').length} label="Blocked" />
                <Stat n={doneCount} label="Done" />
              </div>
              <div className="pm-block">
                <h3>Summary</h3>
                <p className="pm-summary">{m?.summary || '_no summary_'}</p>
                <div className="pm-kv"><span>Stack</span><span>{m?.stack || '—'}</span></div>
                <div className="pm-kv"><span>Status</span><span>{m?.status || '—'}</span></div>
                <div className="pm-kv"><span>Path</span><span>{m?.path || '—'}</span></div>
              </div>
              <div className="pm-block">
                <h3>Key files</h3>
                <div className="pm-files">
                  {(m?.keyFiles?.length ? m.keyFiles : detail?.files ?? []).slice(0, 12).map((f) => (
                    <div key={f}>{f}</div>
                  ))}
                  {!m?.keyFiles?.length && !(detail?.files?.length) && <div className="empty">NO FILES</div>}
                </div>
              </div>
            </div>
          )}

          {tab === 'board' && (
            <div className="pm-board">
              {LANES.map((lane) => {
                const laneCards = cards.filter((c) => c.column === lane.key).sort((a, b) => a.orderIdx - b.orderIdx);
                return (
                  <div
                    key={lane.key}
                    className={`pm-col pm-col-${lane.key}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDrop(lane.key, e)}
                  >
                    <h4>
                      <span>{lane.label}</span>
                      <span className="pm-cnt">{laneCards.length}</span>
                    </h4>
                    <div className="pm-stack">
                      {laneCards.map((c) => (
                        <div
                          key={c.id}
                          className={`pm-kcard pm-pri-${c.priority}`}
                          draggable
                          onDragStart={() => setDragId(c.id)}
                          onDragEnd={() => setDragId(null)}
                          onClick={() => { setError(''); setSelected(c.id); }}
                          title="Open / edit"
                        >
                          <div className="pm-kid">{c.id}</div>
                          <div className="pm-kt">{c.title}</div>
                          <div className="pm-kmeta">
                            {c.assigneeId && (
                              <span className="pm-who"><span className="pm-av">{initials(c.assigneeId)}</span>{c.assigneeId}</span>
                            )}
                            {c.reviewerId && <span className="pm-rev">rev: {c.reviewerId}</span>}
                          </div>
                          {c.dependsOn.length > 0 && <span className="pm-dep">⛓ {c.dependsOn.join(', ')}</span>}
                          {(c.createdBy || c.forWhom) && (
                            <div className="pm-flow">
                              {c.createdBy ? `by: ${c.createdBy}` : ''}{c.forWhom ? ` · for: ${c.forWhom}` : ''}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(tab === 'org' || tab === 'team' || tab === 'activity') && (
            <div className="empty pm-soon">{tab.toUpperCase()} — em breve</div>
          )}
        </div>
      </div>

      {selectedCard && (
        <CardDetail
          card={selectedCard}
          onClose={() => setSelected(null)}
          run={run}
          onDeleted={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="pm-stat">
      <b>{n}</b>
      <small>{label}</small>
    </div>
  );
}

// ── card detail sub-overlay ────────────────────────────────────────────────────

interface CardDetailProps {
  card: KanbanCard;
  run: (op: string, args: Record<string, unknown>) => Promise<KanbanResult>;
  onClose: () => void;
  onDeleted: () => void;
}

function CardDetail({ card, run, onClose, onDeleted }: CardDetailProps) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [assigneeId, setAssignee] = useState(card.assigneeId ?? '');
  const [reviewerId, setReviewer] = useState(card.reviewerId ?? '');
  const [forWhom, setForWhom] = useState(card.forWhom ?? '');
  const [column, setColumn] = useState<CardColumn>(card.column);
  const [priority, setPriority] = useState<Priority>(card.priority);
  const [artifact, setArtifact] = useState(card.artifact);
  // The editable checklist is the Definition-of-Done — that is what the Done-gate
  // checks, so ticking it here is what lets a card legally reach Done.
  const [dod, setDod] = useState<ChecklistItem[]>(card.dod);
  const [dependsOn, setDependsOn] = useState(card.dependsOn.join(', '));
  const [busy, setBusy] = useState(false);

  const gate = doneGateDecision({ artifact, dod });
  const artifactOk = artifact.trim().length > 0;
  const dodDone = dod.filter((d) => d.done).length;

  const save = async () => {
    setBusy(true);
    const res = await run('update_card', {
      id: card.id,
      title,
      body,
      assigneeId,
      reviewerId,
      forWhom,
      column,
      priority,
      artifact,
      dod,
      dependsOn: dependsOn.split(',').map((s) => s.trim()).filter(Boolean),
    });
    setBusy(false);
    if (res.ok) onClose();
  };

  const del = async () => {
    setBusy(true);
    const res = await run('delete_card', { id: card.id });
    setBusy(false);
    if (res.ok) onDeleted();
  };

  const setItem = (i: number, patch: Partial<ChecklistItem>) =>
    setDod((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  return (
    <div className="pm-overlay2" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pm-panel pm-cd no-drag" role="dialog" aria-label={`Card ${card.id}`}>
        <div className="pm-head">
          <span className="pm-dot" />
          <div style={{ flex: 1 }}>
            <div className="pm-cid">{card.id}</div>
            <input className="pm-title-input no-drag" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <span className="pm-status">{column.toUpperCase()}</span>
          <button type="button" className="pm-x no-drag" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="pm-body">
          <div className="pm-two">
            <Field label="Assignee"><input className="no-drag" value={assigneeId} onChange={(e) => setAssignee(e.target.value)} placeholder="agentId / user" /></Field>
            <Field label="Reviewer"><input className="no-drag" value={reviewerId} onChange={(e) => setReviewer(e.target.value)} placeholder="(optional)" /></Field>
          </div>
          <div className="pm-two">
            <Field label="Column">
              <select className="no-drag" value={column} onChange={(e) => setColumn(e.target.value as CardColumn)}>
                {CARD_COLUMNS.map((c) => (
                  <option key={c} value={c} disabled={c !== card.column && !canMoveColumn(card.column, c)}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select className="no-drag" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </div>
          <div className="pm-two">
            <Field label="Created by"><input className="no-drag" value={card.createdBy} readOnly style={{ color: 'var(--dim)' }} /></Field>
            <Field label="For whom"><input className="no-drag" value={forWhom} onChange={(e) => setForWhom(e.target.value)} placeholder="agentId / user" /></Field>
          </div>
          <Field label="Description">
            <textarea className="no-drag" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
          </Field>
          <div className="pm-two">
            <Field label="Artifact (expected deliverable)"><input className="no-drag" value={artifact} onChange={(e) => setArtifact(e.target.value)} placeholder="e.g. src/x.ts + x.test.ts" /></Field>
            <Field label="Depends on (card ids, comma-sep)"><input className="no-drag" value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} placeholder="NB-27, NB-30" /></Field>
          </div>

          <Field label="Definition of Done (acceptance criteria)">
            <div className="pm-checklist">
              {dod.map((it, i) => (
                <div key={i} className={`pm-chk ${it.done ? 'on' : 'off'}`}>
                  <button type="button" className="pm-box no-drag" onClick={() => setItem(i, { done: !it.done })} title="toggle">
                    {it.done ? '✓' : ''}
                  </button>
                  <input className="no-drag" value={it.text} onChange={(e) => setItem(i, { text: e.target.value })} />
                  <button type="button" className="pm-rm no-drag" onClick={() => setDod((p) => p.filter((_, idx) => idx !== i))} title="remove">✕</button>
                </div>
              ))}
              <button type="button" className="pm-add no-drag" onClick={() => setDod((p) => [...p, { text: '', done: false }])}>+ criterion</button>
            </div>
          </Field>

          <div className="pm-gate">
            <h5>⚑ Done-gate (runtime-enforced — not the agent's say-so)</h5>
            <div className={`pm-chk ${artifactOk ? 'on' : 'off'}`}><span className={`pm-box ${artifactOk ? '' : 'no'}`}>{artifactOk ? '✓' : '✕'}</span>Artifact declared</div>
            <div className={`pm-chk ${dod.length && dodDone === dod.length ? 'on' : 'off'}`}>
              <span className={`pm-box ${dod.length && dodDone === dod.length ? '' : 'no'}`}>{dod.length && dodDone === dod.length ? '✓' : '✕'}</span>
              Definition of Done ({dodDone}/{dod.length} ticked)
            </div>
            <div className="pm-gate-verdict" style={{ color: gate.allowed ? 'var(--grn)' : 'var(--amb)' }}>
              {gate.allowed ? 'gate open — can reach Done' : `blocked: ${gate.reasons.join('; ')}`}
            </div>
          </div>
        </div>

        <div className="pm-foot">
          <span className="pm-foot-note">claimed by: {card.claimedBy ?? '—'} · attempts {card.attempts}/{card.maxAttempts}</span>
          <button type="button" className="pm-btn ghost no-drag" disabled={busy} onClick={del} title="Delete (T2)">Delete</button>
          <button type="button" className="pm-btn primary no-drag" disabled={busy} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pm-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
