/**
 * AgentModal — the per-agent DETAILS modal (Phase 8 stage 6).
 *
 * The `.pm-*` tabbed-modal dialect (ProjectModal) applied to one roster agent, with
 * the `.af-*` form dialect (AgentForm) reused verbatim inside the "editar" tab. Four
 * tabs, PT-PT: **visão geral** (stat tiles + kv rows + the role, split back into
 * label/system-prompt via `splitRole`) · **editar** (the AgentForm fields minus ✨
 * augment and the knowledge seed → `updateTeamAgent`) · **conhecimento** (topic chips
 * + the note list, each opening a `.pm-overlay2` markdown viewer via `readAgentNote`)
 * · **atividade** (live state + since, tokens/budget, this agent's pending approvals,
 * recent notes).
 *
 * Self-contained like TeamCard: it fetches its own `getTeamAgentDetail` (+ the
 * approval queue and the job list, to map an approval → the agent whose scheduled
 * STUDY job raised it) and stays live off the SAME stream — `team.changed`,
 * `job.approval` and an `agent.activity` for THIS agent trigger a cheap refetch.
 * A refetch never clobbers a form in progress: the edit spec is re-seeded only when
 * the stored `updatedTs` actually moves.
 *
 * Renderer-safe: only `*-pure` modules + modelCatalog + type-only imports (no node:*).
 * Esc closes the note viewer first, then the modal — and only when this is the
 * topmost `.overlay`, so an AgentForm stacked on top isn't dismissed with us.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { alfred } from '../lib/ipc.ts';
import { Markdown } from './Markdown.tsx';
import {
  fillFormSpec,
  splitRole,
  validateFormSpec,
  type AgentFormSpec,
} from '../../main/core/agent-augment-pure.ts';
import {
  activityLabelPt,
  canMessageUserResolved,
  formatAgentBudget,
  humanizeRole,
} from '../../main/core/team-format-pure.ts';
import { describeApproval, relativeTime } from '../../main/core/jobs-format-pure.ts';
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  isProviderId,
  type CatalogModel,
  type ProviderId,
} from '../../main/core/modelCatalog.ts';
import type { AgentActivity } from '../../main/core/agent-activity-pure.ts';
import type { Job, JobApproval, StreamEvent, TeamAgentDetail, TeamAgentInfo } from '../../main/core/types.ts';

const ROLE_PRESETS = ['PM', 'CTO', 'Dev-Front', 'Dev-Back', 'QA', 'DevOps', 'Custom'];

type Tab = 'overview' | 'edit' | 'knowledge' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'visão geral' },
  { key: 'edit', label: 'editar' },
  { key: 'knowledge', label: 'conhecimento' },
  { key: 'activity', label: 'atividade' },
];

export interface AgentModalProps {
  agentId: string;
  /** The roster (manager names + the "reporta a" select). */
  agents: TeamAgentInfo[];
  catalog: Record<ProviderId, CatalogModel[]> | null;
  onClose: () => void;
}

/** Seed the edit form from a stored agent — the inverse of what "Guardar" sends. */
function seedFrom(d: TeamAgentDetail): AgentFormSpec {
  return fillFormSpec({
    name: d.name,
    provider: d.provider,
    model: d.model,
    parentId: d.parentId,
    canMessageUser: d.canMessageUser,
    delegationRole: d.delegationRole,
    dailyTokenBudget: d.dailyTokenBudget,
    ...splitRole(d.role),
  });
}

function kb(size: number): string {
  return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
}

export function AgentModal({ agentId, agents, catalog, onClose }: AgentModalProps) {
  const [detail, setDetail] = useState<TeamAgentDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [approvals, setApprovals] = useState<JobApproval[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // Edit tab: the working spec + the seeded copy "Cancelar" reverts to.
  const [spec, setSpec] = useState<AgentFormSpec>(() => fillFormSpec(null));
  const seedRef = useRef<AgentFormSpec>(fillFormSpec(null));
  const seedStampRef = useRef<string>('');
  const [busy, setBusy] = useState<null | 'save'>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Knowledge tab: the open note (null = viewer closed; body null = still loading).
  const [noteSlug, setNoteSlug] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const refetch = (): void => {
    alfred.getTeamAgentDetail(agentId).then((d) => { setDetail(d); setLoaded(true); }).catch(() => setLoaded(true));
    alfred.listPendingApprovals().then(setApprovals).catch(() => {});
    alfred.listJobs().then(setJobs).catch(() => {});
    setNow(Date.now());
  };

  useEffect(() => {
    setLoaded(false);
    refetch();
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const off = alfred.onStream((e: StreamEvent) => {
      if (e.kind === 'team.changed' || e.kind === 'job.approval') refetch();
      else if (e.kind === 'agent.activity' && e.agentId === agentId) refetch();
    });
    return () => {
      clearInterval(clock);
      off();
    };
  }, [agentId]);

  // Seed the edit form ONCE per stored revision: a refetch triggered by an activity
  // event (or another agent's change) must never overwrite what the user is typing.
  useEffect(() => {
    if (!detail) return;
    const stamp = `${detail.id}:${detail.updatedTs ?? detail.createdTs}`;
    if (seedStampRef.current === stamp) return;
    seedStampRef.current = stamp;
    const fresh = seedFrom(detail);
    seedRef.current = fresh;
    setSpec(fresh);
  }, [detail]);

  // Esc: the note viewer first, then the modal — but only while this is the topmost
  // overlay (an AgentForm opened over us renders later in the DOM and wins).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const overlays = document.querySelectorAll('.overlay');
      if (overlays.length > 0 && overlays[overlays.length - 1] !== overlayRef.current) return;
      if (noteSlug) setNoteSlug(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [noteSlug, onClose]);

  // id → name, so "reporta a" reads as the manager's display name.
  const nameById: Record<string, string> = {};
  for (const a of agents) nameById[a.id] = a.name;

  // Map an approval → the agent that raised it, via its scheduled STUDY job.
  const agentByJob: Record<string, string> = {};
  for (const j of jobs) if (j.study) agentByJob[j.id] = j.study.agentId;
  const pending = approvals.filter((a) => agentByJob[a.jobId] === agentId);

  const resolve = (id: string, approved: boolean): void => {
    alfred.resolveJobApproval(id, approved).then(() => refetch()).catch(() => {});
  };

  const set = <K extends keyof AgentFormSpec>(key: K, value: AgentFormSpec[K]): void => {
    setSpec((s) => ({ ...s, [key]: value }));
    setError('');
    setSaved(false);
  };

  const onProviderChange = (p: string): void => {
    // Drop a model that isn't in the new provider's catalog (avoid an invalid spec).
    const list = isProviderId(p) && catalog ? catalog[p] ?? [] : [];
    setSpec((s) => ({ ...s, provider: p, model: list.some((m) => m.id === s.model) ? s.model : '' }));
    setError('');
    setSaved(false);
  };

  const doSave = async (): Promise<void> => {
    const v = validateFormSpec(spec);
    if (!v.ok) { setError(v.errors.join(' ')); setSaved(false); return; }
    setBusy('save');
    setError('');
    try {
      const res = await alfred.updateTeamAgent(agentId, spec);
      if (res.ok) setSaved(true); // the team.changed event refetches the detail
      else setError(res.error ?? 'Falha ao guardar o agente.');
    } catch {
      setError('Falha ao guardar o agente.');
    } finally {
      setBusy(null);
    }
  };

  const openNote = (slug: string): void => {
    setNoteSlug(slug);
    setNoteBody(null);
    alfred.readAgentNote(agentId, slug).then((b) => setNoteBody(b ?? '')).catch(() => setNoteBody(''));
  };

  const closeOnBackdrop = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) onClose();
  };

  // Deleted while open (or an unknown id): a compact panel instead of a blank modal.
  if (loaded && !detail) {
    return (
      <div className="overlay" ref={overlayRef} onClick={closeOnBackdrop}>
        <div className="pm-panel pm-cd no-drag" role="dialog" aria-label={`agente ${agentId}`}>
          <div className="pm-head">
            <span className="team-dot" />
            <h2 className="pm-name">Agente removido</h2>
            <span className="pm-slug">{agentId}</span>
            <span className="pm-status">REMOVIDO</span>
            <button type="button" className="pm-x no-drag" title="Fechar" onClick={onClose}>✕</button>
          </div>
          <div className="pm-body">
            <div className="empty">Este agente já não está no roster — foi apagado.</div>
          </div>
          <div className="pm-foot">
            <span className="pm-foot-note" />
            <button type="button" className="pm-btn primary no-drag" onClick={onClose}>FECHAR</button>
          </div>
        </div>
      </div>
    );
  }

  const activity: AgentActivity = detail?.activity ?? { state: 'idle', since: now };
  const models: CatalogModel[] = isProviderId(spec.provider) && catalog ? catalog[spec.provider] ?? [] : [];
  const role = splitRole(detail?.role ?? '');
  const noteMeta = detail?.notes.find((n) => n.slug === noteSlug);

  return (
    <div className="overlay" ref={overlayRef} onClick={closeOnBackdrop}>
      <div className="pm-panel no-drag" role="dialog" aria-label={`agente ${detail?.name ?? agentId}`}>
        <div className="pm-head">
          <span className={`team-dot ${activity.state}`} title={activityLabelPt(activity.state)} />
          <h2 className="pm-name">{detail?.name ?? agentId}</h2>
          <span className="pm-slug">{agentId}{detail ? ` · ${detail.provider}:${detail.model}` : ''}</span>
          <span className="pm-status">{activityLabelPt(activity.state)}</span>
          <button type="button" className="pm-x no-drag" title="Fechar" onClick={onClose}>✕</button>
        </div>

        <div className="pm-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`no-drag${t.key === tab ? ' on' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'knowledge' && (detail?.notes.length ?? 0) > 0 && <span className="pm-n"> {detail?.notes.length}</span>}
              {t.key === 'activity' && pending.length > 0 && <span className="pm-n"> {pending.length}</span>}
            </button>
          ))}
        </div>

        <div className="pm-body">
          {!detail ? (
            <div className="empty">A CARREGAR…</div>
          ) : (
            <>
              {tab === 'overview' && (
                <div className="pm-overview">
                  <div className="pm-stats">
                    <Stat v={formatAgentBudget(detail.tokensToday, detail.dailyTokenBudget)} label="tokens hoje" />
                    <Stat v={detail.topics.length} label="tópicos" />
                    <Stat v={detail.notes.length} label="notas" />
                    <Stat v={detail.grant.length} label="capacidades" />
                  </div>
                  <div className="pm-block">
                    <h3>Identidade</h3>
                    <div className="pm-kv"><span>papel</span><span>{humanizeRole(detail.delegationRole)}</span></div>
                    <div className="pm-kv"><span>✉ mensagens ao utilizador</span><span>{canMessageUserResolved(detail) ? 'sim' : 'não'}</span></div>
                    <div className="pm-kv"><span>reporta a</span><span>{detail.parentId ? (nameById[detail.parentId] ?? detail.parentId) : '—'}</span></div>
                    <div className="pm-kv"><span>modelo</span><span>{detail.provider}:{detail.model}</span></div>
                    <div className="pm-kv"><span>budget diário</span><span>{detail.dailyTokenBudget ? detail.dailyTokenBudget.toLocaleString('pt-PT') : 'sem limite'}</span></div>
                    <div className="pm-kv"><span>capacidades</span><span>{detail.grant.length > 0 ? detail.grant.join(', ') : '—'}</span></div>
                    <div className="pm-kv">
                      <span>criado</span>
                      <span title={new Date(detail.createdTs).toLocaleString('pt-PT')}>{relativeTime(detail.createdTs, now)}</span>
                    </div>
                    <div className="pm-kv">
                      <span>atualizado</span>
                      <span title={detail.updatedTs ? new Date(detail.updatedTs).toLocaleString('pt-PT') : ''}>
                        {detail.updatedTs ? relativeTime(detail.updatedTs, now) : 'nunca editado'}
                      </span>
                    </div>
                  </div>
                  <div className="pm-block">
                    <h3>Papel / system prompt</h3>
                    {role.role && <div className="am-role-label">{role.role}</div>}
                    {role.systemPrompt ? (
                      <Markdown content={role.systemPrompt} />
                    ) : (
                      !role.role && <div className="empty">Sem papel definido.</div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'edit' && (
                <div className="am-edit">
                  <p className="af-intro">
                    O <b>id</b> e a pasta do agente são imutáveis — mudar o nome muda só o nome apresentado.
                    Um turno já a correr usa a configuração com que arrancou; a edição aplica-se ao próximo.
                  </p>

                  <div className="af-two">
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-name">Nome</label></div>
                      <input id="am-name" className="no-drag" value={spec.name} onChange={(e) => set('name', e.target.value)} />
                    </div>
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-role">Tipo / Papel</label></div>
                      <input id="am-role" className="no-drag" list="am-role-presets" value={spec.role} placeholder="ex: Dev-Back" onChange={(e) => set('role', e.target.value)} />
                      <datalist id="am-role-presets">{ROLE_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
                    </div>
                  </div>

                  <div className="af-two">
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-provider">Provider</label></div>
                      <select id="am-provider" className="no-drag" value={spec.provider} onChange={(e) => onProviderChange(e.target.value)}>
                        {PROVIDER_IDS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
                      </select>
                    </div>
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-model">Modelo</label></div>
                      <select id="am-model" className="no-drag" value={spec.model} onChange={(e) => set('model', e.target.value)}>
                        <option value="">— escolhe um modelo</option>
                        {spec.model && !models.some((m) => m.id === spec.model) && (
                          <option value={spec.model}>{spec.model} (fora do catálogo)</option>
                        )}
                        {models.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.id}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="af-two">
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-parent">Reporta a (manager)</label></div>
                      <select id="am-parent" className="no-drag" value={spec.parentId ?? ''} onChange={(e) => set('parentId', e.target.value || null)}>
                        <option value="">— (topo)</option>
                        {agents.filter((a) => a.id !== agentId).map((a) => (
                          <option key={a.id} value={a.id}>{a.name} · {a.id}</option>
                        ))}
                      </select>
                    </div>
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-drole">Delegation role</label></div>
                      <select id="am-drole" className="no-drag" value={spec.delegationRole} onChange={(e) => set('delegationRole', e.target.value === 'orchestrator' ? 'orchestrator' : 'leaf')}>
                        <option value="leaf">leaf (só executa)</option>
                        <option value="orchestrator">orchestrator (pode delegar)</option>
                      </select>
                    </div>
                  </div>

                  <div className="af-field">
                    <div className="af-lab"><label htmlFor="am-sysprompt">System prompt / especialidade</label></div>
                    <textarea id="am-sysprompt" className="no-drag" value={spec.systemPrompt} placeholder="a especialidade, os padrões que tem de manter e como reporta" onChange={(e) => set('systemPrompt', e.target.value)} />
                  </div>

                  <div className="af-two">
                    <div className="af-field">
                      <div className="af-lab"><label htmlFor="am-budget">Budget diário (tokens)</label></div>
                      <input
                        id="am-budget"
                        className="no-drag"
                        inputMode="numeric"
                        value={spec.dailyTokenBudget ?? ''}
                        placeholder="em branco = sem limite"
                        onChange={(e) => {
                          const n = Number(e.target.value.replace(/[^0-9]/g, ''));
                          set('dailyTokenBudget', e.target.value.trim() && n > 0 ? n : undefined);
                        }}
                      />
                    </div>
                    <div className="af-field">
                      <div className="af-lab"><label>Pode mandar-me inbox?</label></div>
                      <label className={`af-toggle no-drag${spec.canMessageUser ? ' on' : ''}`}>
                        <input type="checkbox" checked={spec.canMessageUser} onChange={(e) => set('canMessageUser', e.target.checked)} />
                        <span className="af-sw" />
                        <span>{spec.canMessageUser ? 'Sim — pode perguntar-me' : 'Não — só fala com o superior'}</span>
                      </label>
                    </div>
                  </div>

                  {error && <div className="af-error">{error}</div>}
                </div>
              )}

              {tab === 'knowledge' && (
                <div className="am-know">
                  {detail.topics.length > 0 && (
                    <div className="team-topics">
                      {detail.topics.map((t) => <span key={t} className="team-topic">{t}</span>)}
                    </div>
                  )}
                  {detail.notes.length === 0 ? (
                    <div className="empty">Sem notas ainda — usa o agent_study para ensinar este agente.</div>
                  ) : (
                    detail.notes.map((n) => (
                      <div
                        key={n.slug}
                        className="pm-team-row am-note no-drag"
                        role="button"
                        tabIndex={0}
                        title={n.relativePath}
                        onClick={() => openNote(n.slug)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNote(n.slug); } }}
                      >
                        <div className="am-note-h">
                          <span className="am-note-t">{n.title}</span>
                          <span className="am-note-m">{relativeTime(n.mtime, now)} · {kb(n.size)}</span>
                        </div>
                        {n.excerpt && <div className="am-note-x">{n.excerpt}</div>}
                      </div>
                    ))
                  )}
                </div>
              )}

              {tab === 'activity' && (
                <div className="am-act">
                  <div className="pm-block">
                    <h3>Agora</h3>
                    <div className="am-now">
                      <span className={`team-dot ${activity.state}`} />
                      <span className="am-now-state">{activityLabelPt(activity.state)}</span>
                      {activity.label && <span className="team-activity">{activity.label}</span>}
                      <span className="am-note-m">desde {relativeTime(activity.since, now)}</span>
                    </div>
                    <div className="pm-kv"><span>tokens hoje / budget</span><span>{formatAgentBudget(detail.tokensToday, detail.dailyTokenBudget)}</span></div>
                  </div>

                  <div className="pm-block">
                    <h3>Aprovações pendentes · {pending.length}</h3>
                    {pending.length === 0 ? (
                      <div className="empty">Nada à espera de ti.</div>
                    ) : (
                      pending.map((a) => (
                        <div key={a.id} className="team-ap">
                          <div className="team-ap-desc">{describeApproval(a.toolName, a.args)}</div>
                          <div className="team-ap-time">{relativeTime(a.ts, now)}</div>
                          <div className="team-btns">
                            <button type="button" className="sched-ap-btn ok no-drag" onClick={() => resolve(a.id, true)}>✓ APROVAR</button>
                            <button type="button" className="sched-ap-btn no no-drag" onClick={() => resolve(a.id, false)}>✕ RECUSAR</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="pm-block">
                    <h3>Notas recentes</h3>
                    {detail.notes.length === 0 ? (
                      <div className="empty">Sem notas ainda.</div>
                    ) : (
                      detail.notes.slice(0, 5).map((n) => (
                        <div key={n.slug} className="pm-kv">
                          <span>{n.title}</span>
                          <span>{relativeTime(n.mtime, now)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {tab === 'edit' && detail && (
          <div className="pm-foot">
            <span className={`pm-foot-note${saved ? ' am-ok' : ''}`}>
              {saved ? '✓ Guardado' : 'id imutável · aplica-se ao próximo turno'}
            </span>
            <button
              type="button"
              className="pm-btn no-drag"
              disabled={busy !== null}
              onClick={() => { setSpec(seedRef.current); setError(''); setSaved(false); }}
            >
              Cancelar
            </button>
            <button type="button" className="pm-btn primary no-drag" disabled={busy !== null} onClick={doSave}>
              {busy === 'save' ? 'A guardar…' : 'Guardar'}
            </button>
          </div>
        )}
      </div>

      {noteSlug && (
        <div className="pm-overlay2" onClick={(e) => { if (e.target === e.currentTarget) setNoteSlug(null); }}>
          <div className="pm-panel pm-cd no-drag" role="dialog" aria-label={`nota ${noteSlug}`}>
            <div className="pm-head">
              <span className="team-dot studying" />
              <h2 className="pm-name">{noteMeta?.title ?? noteSlug}</h2>
              <span className="pm-slug">{noteMeta?.relativePath ?? `${noteSlug}.md`}</span>
              <span className="pm-status">{noteMeta ? relativeTime(noteMeta.mtime, now) : 'nota'}</span>
              <button type="button" className="pm-x no-drag" title="Fechar" onClick={() => setNoteSlug(null)}>✕</button>
            </div>
            <div className="pm-body">
              {noteBody === null ? (
                <div className="empty">A CARREGAR…</div>
              ) : noteBody.trim() === '' ? (
                <div className="empty">Nota vazia ou indisponível.</div>
              ) : (
                <Markdown content={noteBody} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ v, label }: { v: string | number; label: string }) {
  return (
    <div className="pm-stat">
      <b className="am-stat-v">{v}</b>
      <small>{label}</small>
    </div>
  );
}
