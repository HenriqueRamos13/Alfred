/**
 * Scheduled-jobs display formatters (Phase 4, stage 3). Renderer-safe & PURE:
 * NO `node:*` / better-sqlite3 import — shared with the "Scheduled Tasks" card
 * and unit-tested via `node --experimental-strip-types` (see jobs-pure.ts).
 *
 * These turn raw job fields into the short human strings the management card
 * shows: a legible schedule, a relative timestamp, the token budget, and a
 * one-line description of a pending sensitive action the user must approve.
 * All deterministic — `now` is passed in, never read here.
 */

import type { Capability, JobSchedule } from './types.ts';
import { toolCapability } from './jobs-pure.ts';

/** Compact token count: 500 → "500", 12000 → "12k", 12500 → "12.5k". */
function kfmt(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const k = v / 1000;
  return k >= 100 || Number.isInteger(k) ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

/** A schedule as a short PT phrase: "cada 5 min" / "cada 2 h" / "às 09:00". */
export function humanizeSchedule(s: JobSchedule): string {
  if (s.type === 'daily') return `às ${s.at}`;
  const sec = Math.round(s.everyMs / 1000);
  if (sec < 60) return `cada ${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `cada ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `cada ${h} h`;
  return `cada ${Math.round(h / 24)} d`;
}

/** Relative timestamp: "agora" / "há 2 min" / "em 3 min". Missing ts → "—". */
export function relativeTime(ts: number | undefined, now: number): string {
  if (ts == null) return '—';
  const diff = ts - now; // future = positive
  const a = Math.abs(diff);
  if (a < 45_000) return 'agora';
  const past = diff < 0;
  const mk = (n: number, u: string): string => (past ? `há ${n} ${u}` : `em ${n} ${u}`);
  const min = Math.round(a / 60_000);
  if (min < 60) return mk(min, 'min');
  const h = Math.round(min / 60);
  if (h < 24) return mk(h, 'h');
  return mk(Math.round(h / 24), 'd');
}

/** Token budget as "used / limit", "12k / 100k"; no limit → "12k / ∞". */
export function formatBudget(tokensToday: number | undefined, limit: number | undefined): string {
  const used = kfmt(tokensToday ?? 0);
  return limit == null ? `${used} / ∞` : `${used} / ${kfmt(limit)}`;
}

/** PT phrase per capability, so the user reads WHAT a queued action would do. */
const CAP_PHRASE: Record<Capability, string> = {
  send: 'Enviar mensagem',
  money: 'Pagamento / compra',
  delete: 'Apagar ou sobrescrever dados',
  secrets: 'Aceder a credenciais',
  shell: 'Executar comando de shell',
  write: 'Escrever / modificar ficheiros',
  browse: 'Interagir no browser',
  read: 'Ler dados',
  notify: 'Notificar',
};

/**
 * Free-text CONTENT fields (email/message body, generated HTML, note text). Their
 * VALUE is never shown in the approvals UI — only its length — so a private
 * message body or egress payload can't leak on screen even though the verbatim
 * content is preserved in the row for re-execution. Identifying fields (to,
 * subject, url, path, command…) stay visible so consent is still informed.
 * Secret-KEYED fields are already `***` upstream (maskSecrets in createApproval).
 */
const BODY_KEY = /(^|_)(body|html|content|message|text|markdown|payload)($|_)/i;

/** One-line summary of tool args: up to 3 `key: value` pairs, values truncated. */
function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args.length > 60 ? `${args.slice(0, 60)}…` : args;
  if (typeof args !== 'object') return String(args);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v == null || v === '') continue;
    if (BODY_KEY.test(k)) {
      const len = typeof v === 'string' ? v.length : JSON.stringify(v).length;
      parts.push(`${k}: [${len} car.]`);
    } else {
      const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      parts.push(`${k}: ${s.length > 40 ? `${s.slice(0, 40)}…` : s}`);
    }
    if (parts.length === 3) break;
  }
  return parts.join(', ');
}

/**
 * A human sentence for a pending approval: the sensitive category (from the same
 * classifier the governor uses) + the tool + a short, masked arg summary — so the
 * user knows exactly what they are approving. Args are already secret-masked
 * upstream (createApproval); this only shortens them.
 */
export function describeApproval(toolName: string, argsMasked: unknown): string {
  const phrase = CAP_PHRASE[toolCapability(toolName, argsMasked)] ?? 'Ação';
  const summary = summarizeArgs(argsMasked);
  return summary ? `${phrase} · ${toolName} (${summary})` : `${phrase} · ${toolName}`;
}
