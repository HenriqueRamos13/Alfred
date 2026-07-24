/**
 * AgentForm — the agent-creation modal with per-field AI augment (Phase 7 stage 5).
 *
 * `.overlay` idiom (sibling of the canvas, like ProjectModal/ApprovalPrompt). The
 * user fills what they know and flags augmentable fields (role/model/systemPrompt/
 * knowledgeSeed) with a magenta ✨ toggle; "Enviar — Alfred completa" runs a cheap
 * read-only turn (augmentAgentSpec IPC) that fills the flagged/blank fields, then
 * the completed form is shown for REVIEW before "Criar" persists it (createTeamAgent
 * IPC, which passes parentId + canMessageUser + delegationRole + budget + system
 * prompt + knowledge seed). Renderer-safe: only agent-augment-pure + modelCatalog
 * (no node:*). Opens blank via "+ AGENT" or pre-filled via the agent.form event.
 */
import { useMemo, useState } from 'react';
import {
  fillFormSpec,
  augmentPlan,
  validateFormSpec,
  type AgentFormSpec,
  type AugmentField,
  type AugmentFlags,
} from '../../main/core/agent-augment-pure.ts';
import { PROVIDER_IDS, PROVIDER_LABELS, isProviderId, type ProviderId, type CatalogModel } from '../../main/core/modelCatalog.ts';
import type { TeamAgentInfo } from '../../main/core/types.ts';

const ROLE_PRESETS = ['PM', 'CTO', 'Dev-Front', 'Dev-Back', 'QA', 'DevOps', 'Custom'];

const AUG_LABEL: Record<AugmentField, string> = {
  role: '✨ IA escolhe',
  model: '✨ IA escolhe',
  systemPrompt: '✨ IA aumenta',
  knowledgeSeed: '✨ IA pesquisa e semeia',
};

export interface AgentFormProps {
  initial: Partial<AgentFormSpec> | null;
  agents: TeamAgentInfo[];
  catalog: Record<ProviderId, CatalogModel[]> | null;
  onAugment: (spec: AgentFormSpec, flags: AugmentFlags) => Promise<AgentFormSpec | null>;
  onCreate: (spec: AgentFormSpec) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

export function AgentForm({ initial, agents, catalog, onAugment, onCreate, onClose }: AgentFormProps) {
  const [spec, setSpec] = useState<AgentFormSpec>(() => fillFormSpec(initial));
  const [flags, setFlags] = useState<AugmentFlags>({});
  const [busy, setBusy] = useState<null | 'augment' | 'create'>(null);
  const [augmented, setAugmented] = useState(false);
  const [error, setError] = useState('');

  const models: CatalogModel[] = isProviderId(spec.provider) && catalog ? catalog[spec.provider] ?? [] : [];
  const plan = useMemo(() => augmentPlan(spec, flags), [spec, flags]);
  const canAugment = plan.length > 0 && !augmented;

  const set = <K extends keyof AgentFormSpec>(key: K, value: AgentFormSpec[K]): void => {
    setSpec((s) => ({ ...s, [key]: value }));
    setError('');
    setAugmented(false); // an edit invalidates the "reviewed" state
  };

  const toggleAug = (f: AugmentField): void => {
    setFlags((fl) => ({ ...fl, [f]: !fl[f] }));
    setAugmented(false);
  };

  const augMark = (f: AugmentField) => (
    <span
      className={`af-aug${flags[f] ? ' on' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => toggleAug(f)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAug(f); } }}
    >
      <span className="af-star">✨</span> {AUG_LABEL[f].replace('✨ ', '')}
    </span>
  );
  const augd = (f: AugmentField): string => (flags[f] ? ' af-augd' : '');

  const doAugment = async (): Promise<void> => {
    setBusy('augment');
    setError('');
    try {
      const res = await onAugment(spec, flags);
      if (res) {
        setSpec(res);
        setFlags({});
        setAugmented(true);
      } else {
        setError('Não consegui aumentar agora (sem brain barato ou orçamento esgotado). Preenche à mão e cria.');
        setAugmented(true); // let the user proceed to Criar
      }
    } finally {
      setBusy(null);
    }
  };

  const doCreate = async (): Promise<void> => {
    const v = validateFormSpec(spec);
    if (!v.ok) { setError(v.errors.join(' ')); return; }
    setBusy('create');
    setError('');
    try {
      const res = await onCreate(spec);
      if (res.ok) onClose();
      else setError(res.error ?? 'Falha ao criar o agente.');
    } finally {
      setBusy(null);
    }
  };

  const onProviderChange = (p: string): void => {
    // Drop a model that isn't in the new provider's catalog (avoid an invalid spec).
    const list = isProviderId(p) && catalog ? catalog[p] ?? [] : [];
    setSpec((s) => ({ ...s, provider: p, model: list.some((m) => m.id === s.model) ? s.model : '' }));
    setError('');
    setAugmented(false);
  };

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="af-panel no-drag" role="dialog" aria-label="Novo agente">
        <div className="af-head">
          <span className="af-dot" />
          <h2 className="af-name">Novo agente</h2>
          <span className="af-slug">Alfred completa os campos ✨ ao enviar</span>
          <button type="button" className="af-x no-drag" title="Fechar" onClick={onClose}>✕</button>
        </div>

        <div className="af-body">
          <p className="af-intro">
            Preenche o básico. Em qualquer campo com <span className="af-aug on"><span className="af-star">✨</span> IA</span> ligado,
            deixas em branco (ou dás uma dica) e o Alfred escolhe/aumenta ao enviar — depois mostra o formulário completo
            para confirmares antes de criar.
          </p>

          <div className="af-two">
            <div className="af-field">
              <div className="af-lab"><label htmlFor="af-name">Nome</label></div>
              <input id="af-name" value={spec.name} placeholder="ex: Dario" onChange={(e) => set('name', e.target.value)} />
            </div>
            <div className={`af-field${augd('role')}`}>
              <div className="af-lab"><label htmlFor="af-role">Tipo / Papel</label>{augMark('role')}</div>
              <input id="af-role" list="af-role-presets" value={spec.role} placeholder="ex: Dev-Back" onChange={(e) => set('role', e.target.value)} />
              <datalist id="af-role-presets">{ROLE_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
          </div>

          <div className="af-two">
            <div className="af-field">
              <div className="af-lab"><label htmlFor="af-provider">Provider</label></div>
              <select id="af-provider" value={spec.provider} onChange={(e) => onProviderChange(e.target.value)}>
                {PROVIDER_IDS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
              </select>
            </div>
            <div className={`af-field${augd('model')}`}>
              <div className="af-lab"><label htmlFor="af-model">Modelo</label>{augMark('model')}</div>
              <select id="af-model" value={spec.model} onChange={(e) => set('model', e.target.value)}>
                <option value="">(IA escolhe pelo custo/tarefa)</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.id}</option>)}
              </select>
            </div>
          </div>

          <div className="af-two">
            <div className="af-field">
              <div className="af-lab"><label htmlFor="af-parent">Reporta a (manager)</label></div>
              <select id="af-parent" value={spec.parentId ?? ''} onChange={(e) => set('parentId', e.target.value || null)}>
                <option value="">— (topo)</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.id}</option>)}
              </select>
            </div>
            <div className="af-field">
              <div className="af-lab"><label htmlFor="af-drole">Delegation role</label></div>
              <select id="af-drole" value={spec.delegationRole} onChange={(e) => set('delegationRole', e.target.value === 'orchestrator' ? 'orchestrator' : 'leaf')}>
                <option value="leaf">leaf (só executa)</option>
                <option value="orchestrator">orchestrator (pode delegar)</option>
              </select>
            </div>
          </div>

          <div className={`af-field${augd('systemPrompt')}`}>
            <div className="af-lab"><label htmlFor="af-sysprompt">System prompt / especialidade</label>{augMark('systemPrompt')}</div>
            <textarea id="af-sysprompt" value={spec.systemPrompt} placeholder="uma frase basta — a IA expande. ex: 'especialista em billing e Stripe, TDD rigoroso'" onChange={(e) => set('systemPrompt', e.target.value)} />
          </div>

          <div className={`af-field${augd('knowledgeSeed')}`}>
            <div className="af-lab"><label htmlFor="af-seed">Seed de conhecimento (notas iniciais)</label>{augMark('knowledgeSeed')}</div>
            <textarea id="af-seed" value={spec.knowledgeSeed} placeholder="tópicos a semear na pasta do agente" onChange={(e) => set('knowledgeSeed', e.target.value)} />
          </div>

          <div className="af-two">
            <div className="af-field">
              <div className="af-lab"><label htmlFor="af-budget">Budget diário (tokens)</label></div>
              <input
                id="af-budget"
                inputMode="numeric"
                value={spec.dailyTokenBudget ?? ''}
                placeholder="ilimitado"
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^0-9]/g, ''));
                  set('dailyTokenBudget', e.target.value.trim() && n > 0 ? n : undefined);
                }}
              />
            </div>
            <div className="af-field">
              <div className="af-lab"><label>Pode mandar-me inbox?</label></div>
              <label className={`af-toggle${spec.canMessageUser ? ' on' : ''}`}>
                <input type="checkbox" checked={spec.canMessageUser} onChange={(e) => set('canMessageUser', e.target.checked)} />
                <span className="af-sw" />
                <span>{spec.canMessageUser ? 'Sim — pode perguntar-me' : 'Não — só fala com o superior'}</span>
              </label>
            </div>
          </div>

          {error && <div className="af-error">{error}</div>}
        </div>

        <div className="af-foot">
          <span className="af-note">
            {canAugment ? `✨ ${plan.length} campo(s) serão completados pela IA ao enviar` : augmented ? '✓ Revê os campos e cria' : 'pronto a criar'}
          </span>
          <button type="button" className="af-btn" onClick={onClose} disabled={busy !== null}>Cancelar</button>
          {canAugment ? (
            <button type="button" className="af-btn pri" onClick={doAugment} disabled={busy !== null}>
              {busy === 'augment' ? 'A completar…' : '✨ Enviar — Alfred completa'}
            </button>
          ) : (
            <button type="button" className="af-btn pri" onClick={doCreate} disabled={busy !== null}>
              {busy === 'create' ? 'A criar…' : 'Criar agente'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
