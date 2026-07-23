/**
 * Memory auto-review (Phase 6 stage 4) — a cheap, idle-time self-improvement pass.
 * After a turn (reusing the curator's idle scheduling in the orchestrator), a
 * CHEAP brain reads a DIGEST of the recent transcript and decides whether there
 * is anything DURABLE to remember (a user fact, a workflow lesson like "be more
 * terse"). It does NOT auto-commit a fact: a positive decision is STAGED as a
 * memory handoff in the inbox — the same propose→curate path an agent uses — so
 * the governed librarian (curator) turns it into a well-formed note rather than a
 * raw injected fact. Cheap by construction: a digest not the whole conversation,
 * skipped entirely when nothing changed since the last review, budget-guarded.
 *
 * Pure decision logic (shouldRecord / parseReviewProposal) lives in
 * auto-review-pure.ts and is unit-tested; this file is the IO shell. It never
 * throws — every failure is logged and returns a skip.
 */

import { generateText } from 'ai';
import { getRecentMessages, getSetting, setSetting } from './db.ts';
import { formatTranscript, writeHandoff } from './memory.ts';
import { resolveProvider, listBrains } from './providers.ts';
import { pickCuratorSpec } from './curator.ts';
import { BudgetTracker, isOverDailyBudget } from './budget.ts';
import { shouldRecord, parseReviewProposal } from './auto-review-pure.ts';
import { scanMemoryText } from './memory-scan-pure.ts';

type DB = import('better-sqlite3').Database;
type Env = Record<string, string | undefined>;

const LAST_TS_KEY = 'auto_review:last_ts';

const AUTO_REVIEW_SYSTEM = `You are Alfred's self-improvement reviewer. You read a short digest of the most recent conversation and decide whether there is ONE durable thing worth remembering long-term: a stable fact about the user (a preference, a constraint, who they are) or a workflow lesson (something to do differently next time, e.g. "the user wants terser replies").

Be strict: most turns contain NOTHING durable — a one-off task is not a durable memory. Never invent. Only record something the conversation clearly supports.

Reply with ONLY a JSON object, no prose, no code fences:
{ "record": true | false, "kind": "semantic" | "episodic", "title": "short title", "text": "the one durable thing, one sentence" }
Set "record": false when nothing is worth keeping.`;

export interface RunAutoReviewDeps {
  db: DB;
  workspace: string;
  sessionId: string;
  dailyTokenBudget: number;
  stepCap: number;
  dailyUsdBudget?: number;
  env?: Env;
  /** Explicit "<brainId>:<model>" spec (reuses the curator/aux cheap brain). */
  curatorSpec?: string;
}

export interface AutoReviewResult {
  staged: boolean;
  usedModel: string | null;
  skipped?: 'nochange' | 'budget' | 'no-brain' | 'no-proposal' | 'dangerous';
}

/** Run one idle auto-review pass. Never throws. */
export async function runAutoReview(deps: RunAutoReviewDeps): Promise<AutoReviewResult> {
  const env = deps.env ?? process.env;
  try {
    const msgs = getRecentMessages(deps.db, 40);
    const lastReviewedTs = Number(getSetting(deps.db, LAST_TS_KEY) ?? 0) || 0;
    const latestTs = msgs.length ? msgs[msgs.length - 1].ts : 0;
    const newUserMessages = msgs.filter((m) => m.role === 'user' && m.ts > lastReviewedTs).length;

    // Gate: nothing new since last review → no cheap-brain call at all.
    if (!shouldRecord({ latestTs, lastReviewedTs, newUserMessages })) {
      return { staged: false, usedModel: null, skipped: 'nochange' };
    }

    const budget = new BudgetTracker(
      deps.db,
      { dailyLimit: deps.dailyTokenBudget, stepCap: deps.stepCap, dailyUsdBudget: deps.dailyUsdBudget },
      deps.sessionId,
    );
    if (isOverDailyBudget(budget.snapshot())) return { staged: false, usedModel: null, skipped: 'budget' };

    const spec = deps.curatorSpec ?? pickCuratorSpec(env, listBrains(env));
    if (!spec) return { staged: false, usedModel: null, skipped: 'no-brain' };
    let provider: ReturnType<typeof resolveProvider>;
    try {
      provider = resolveProvider(spec, env);
    } catch (err) {
      log('resolve review brain', err);
      return { staged: false, usedModel: null, skipped: 'no-brain' };
    }

    // Advance the watermark up front so a repeated sweep over the SAME messages
    // never re-reviews (idempotent even if staging below no-ops).
    setSetting(deps.db, LAST_TS_KEY, String(latestTs));

    const digest = formatTranscript(msgs, 4000);
    const res = await generateText({
      model: provider.languageModel,
      system: AUTO_REVIEW_SYSTEM,
      prompt: `Recent conversation digest:\n${digest}`,
      maxOutputTokens: 300,
    });
    budget.record({ inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 }, provider.model);

    const proposal = parseReviewProposal(res.text);
    if (!proposal) return { staged: false, usedModel: provider.model, skipped: 'no-proposal' };

    // Anti-poisoning (§3): scan the proposal before it enters the vault path.
    const scan = scanMemoryText(`${proposal.title}\n${proposal.text}`);
    if (scan.risk === 'dangerous') {
      log('auto-review proposal blocked', new Error(scan.findings.join('; ')));
      return { staged: false, usedModel: provider.model, skipped: 'dangerous' };
    }

    // STAGE via the propose→curate path (inbox handoff), not a direct fact write.
    const flag = scan.risk === 'suspicious' ? ` [scan: ${scan.findings.join('; ')}]` : '';
    await writeHandoff(deps.workspace, {
      summary:
        `Auto-review proposal (${proposal.kind}): ${proposal.title}\n${proposal.text}${flag}\n\n` +
        '(Proposed by Alfred\'s idle self-review from the recent conversation — file if durable.)',
      tags: ['auto-review', proposal.kind],
    });
    return { staged: true, usedModel: provider.model };
  } catch (err) {
    log('auto-review', err);
    return { staged: false, usedModel: null };
  }
}

function log(where: string, err: unknown): void {
  console.error(`[alfred:auto-review] ${where} failed:`, err instanceof Error ? err.message : err);
}
