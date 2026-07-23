/**
 * Pure-logic tests. Run with:
 *   node --experimental-strip-types --test test/logic.test.ts
 *
 * Only imports strip-types-safe modules (no native deps): governance, budget,
 * projects. Inline `import('...')` type refs in those files are erased.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAction,
  isEgressTool,
  trifectaImpact,
  fullTrifecta,
  maskSecrets,
  approvalKey,
  isAutoApproved,
  denialError,
} from '../src/main/core/governance.ts';
import { readJsonLines } from '../src/main/core/stt.ts';
import { classifyWakeExit, WAKE_MAX_FAST_FAILS, wakeStreamEvent, parseVoiceIntent, suppressWhileSpeaking } from '../src/main/core/wakeword.ts';
import { initialDictation, dictationReduce } from '../src/main/core/dictation.ts';
import { shell } from '../src/main/tools/shell.ts';
import { filesystem } from '../src/main/tools/filesystem.ts';
import { browser } from '../src/main/tools/browser.ts';
import { delegate } from '../src/main/tools/delegate.ts';
import { dangerousArgs, DANGEROUS_SYSTEM_PROMPT } from '../src/main/core/claudeSpawn.ts';
import { gmailConfigured } from '../src/main/tools/gmail-config.ts';
import {
  dayKey,
  makeBudget,
  addTokens,
  isOverDailyBudget,
  isOverStepCap,
  callSignature,
  isLoop,
} from '../src/main/core/budget.ts';
import { slugify } from '../src/main/core/projects.ts';
import { confirmMatches, factoryResetPaths } from '../src/main/core/reset.ts';
import { grillMeEnabled } from '../src/main/core/settings-pure.ts';
import {
  defaultProviderId,
  parseProviderSpec,
  selectBrainId,
  keyEnabled,
  resolveActiveBrainId,
} from '../src/main/core/providers.ts';
import { costOf, isKnownModel } from '../src/main/core/pricing.ts';
import {
  clampBox,
  tileLayout,
  cardOnDisplay,
  resolveCardDisplay,
  nextDisplayId,
  displayForCard,
  resolveMoveTarget,
  DISPLAY_MAIN,
  DISPLAY_ALL,
} from '../src/main/core/layout.ts';
import type { DisplayGeom } from '../src/main/core/types.ts';
import {
  claudeMdNeedsWrite,
  buildClaudeMd,
  journalDay,
  isWithinDays,
  matchesQuery,
  filterLines,
  truncateHead,
  formatTranscript,
  parseHashtags,
  extractWikilinks,
  parseObservations,
  parseRelations,
  parseFrontmatter,
  parseNote,
  serializeNote,
  mergeNotes,
  buildBacklinks,
  buildIndex,
  buildMap,
  mapNameForType,
} from '../src/main/core/memory.ts';
import type { Note } from '../src/main/core/memory.ts';
import { pickCuratorSpec } from '../src/main/core/curator.ts';
import {
  clip,
  toNoteSlug,
  selectNeighbors,
  buildReferenceContext,
  buildReferencePrompt,
} from '../src/main/core/reference.ts';
import {
  parseBattery,
  parseVolume,
  parseBrightness,
  parseWifiSsid,
  parseWifiPower,
  parseAppsRunning,
  parseProcessList,
  parseDisplays,
  system,
} from '../src/main/tools/system.ts';
import {
  mcpToolName,
  toMcpTools,
  buildMcpConfig,
  buildAllowedTools,
  bridgeEnabled,
  mcpCliArgs,
} from '../src/main/core/mcpConfig.ts';

test('classifyAction — read/list/search are T0 autopilot', () => {
  assert.equal(classifyAction('fs_read', { path: '/a' }), 'T0');
  assert.equal(classifyAction('project_list', {}), 'T0');
  assert.equal(classifyAction('gmail_search', { q: 'hi' }), 'T0');
  assert.equal(classifyAction('browser_read_text', {}), 'T0');
  assert.equal(classifyAction('render_ui', { tree: {} }), 'T0');
});

test('classifyAction — reversible writes are T1', () => {
  assert.equal(classifyAction('fs_write', { path: '/a' }), 'T1');
  assert.equal(classifyAction('project_create', { name: 'x' }), 'T1');
  assert.equal(classifyAction('memory_append', { note: 'x' }), 'T1');
  assert.equal(classifyAction('browser_click', {}), 'T1');
});

test('classifyAction — destructive/egress are T2', () => {
  assert.equal(classifyAction('fs_delete', { path: '/a' }), 'T2');
  assert.equal(classifyAction('gmail_send', {}), 'T2');
  assert.equal(classifyAction('pkg_install', {}), 'T2');
  assert.equal(classifyAction('fs_write', { path: '/a', overwrite: true }), 'T2');
});

test('classifyAction — money/credentials are T3', () => {
  assert.equal(classifyAction('stripe_payment', {}), 'T3');
  assert.equal(classifyAction('vault_credential_read', {}), 'T3');
});

test('classifyAction — shell classified by command contents', () => {
  assert.equal(classifyAction('shell_exec', { command: 'ls -la' }), 'T1');
  assert.equal(classifyAction('shell_exec', { command: 'rm -rf /tmp/x' }), 'T2');
  assert.equal(classifyAction('shell_exec', { command: 'npm install foo' }), 'T2');
  assert.equal(classifyAction('shell_exec', { command: 'echo hi > out.txt' }), 'T2');
});

test('classifyAction — unknown defaults to reversible T1', () => {
  assert.equal(classifyAction('mystery_tool', {}), 'T1');
});

test('trifecta helpers', () => {
  assert.deepEqual(trifectaImpact('gmail_read'), { readUntrusted: true, hasPrivate: true });
  assert.deepEqual(trifectaImpact('browser_goto'), { readUntrusted: true });
  assert.deepEqual(trifectaImpact('fs_read'), {});
  assert.equal(isEgressTool('gmail_send'), true);
  assert.equal(isEgressTool('shell_exec'), true);
  assert.equal(isEgressTool('fs_read'), false);
});

test('maskSecrets redacts secret-looking keys', () => {
  const masked = maskSecrets({ token: 'sk-abc', nested: { password: 'p' }, path: '/ok' }) as Record<string, unknown>;
  assert.equal(masked.token, '***');
  assert.equal((masked.nested as Record<string, unknown>).password, '***');
  assert.equal(masked.path, '/ok');
});

test('approvalKey — tool:op when args carry an op, else the bare tool name', () => {
  assert.equal(approvalKey('filesystem', { op: 'delete', path: '/a' }), 'filesystem:delete');
  assert.equal(approvalKey('gmail', { op: 'send' }), 'gmail:send');
  assert.equal(approvalKey('gmail_send', {}), 'gmail_send'); // no op field
  assert.equal(approvalKey('shell', { command: 'rm -rf x' }), 'shell'); // op absent → whole tool
  assert.equal(approvalKey('filesystem', { op: '  ' }), 'filesystem'); // blank op ignored
  assert.equal(approvalKey('t', null), 't');
});

test('isAutoApproved — a stored rule scopes to exactly its tool:op', () => {
  const rules = ['filesystem:delete', 'gmail_send'];
  assert.equal(isAutoApproved(rules, 'filesystem', { op: 'delete', path: '/x' }), true);
  assert.equal(isAutoApproved(rules, 'filesystem', { op: 'write', path: '/x' }), false); // different op
  assert.equal(isAutoApproved(rules, 'gmail_send', {}), true);
  assert.equal(isAutoApproved(rules, 'shell', { command: 'rm' }), false);
  assert.equal(isAutoApproved([], 'filesystem', { op: 'delete' }), false); // no rules → ask
});

test('dayKey formats local YYYY-MM-DD', () => {
  assert.equal(dayKey(new Date(2026, 6, 21)), '2026-07-21');
  assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('budget token math accumulates daily + session', () => {
  let s = makeBudget('2026-07-21', 100, 40);
  s = addTokens(s, { inputTokens: 30, outputTokens: 10 });
  assert.equal(s.dailyTokens, 40);
  assert.equal(s.sessionTokens, 40);
  s = addTokens(s, { inputTokens: 20, outputTokens: 0 });
  assert.equal(s.dailyTokens, 60);
});

test('daily budget kill-switch triggers at/above limit', () => {
  assert.equal(isOverDailyBudget(makeBudget('d', 100, 40, 99)), false);
  assert.equal(isOverDailyBudget(makeBudget('d', 100, 40, 100)), true);
  assert.equal(isOverDailyBudget(makeBudget('d', 100, 40, 150)), true);
});

test('step cap triggers at/above cap', () => {
  assert.equal(isOverStepCap(makeBudget('d', 100, 3, 0, 0, 2)), false);
  assert.equal(isOverStepCap(makeBudget('d', 100, 3, 0, 0, 3)), true);
});

test('callSignature is order-stable for object args', () => {
  assert.equal(callSignature('t', { a: 1, b: 2 }), callSignature('t', { b: 2, a: 1 }));
  assert.notEqual(callSignature('t', { a: 1 }), callSignature('t', { a: 2 }));
});

test('isLoop trips on the 4th identical call (>3x)', () => {
  const sig = callSignature('fs_read', { path: '/a' });
  const other = callSignature('fs_read', { path: '/b' });
  assert.equal(isLoop([], sig), false);
  assert.equal(isLoop([sig, sig], sig), false); // 2 prior → this is 3rd
  assert.equal(isLoop([sig, sig, sig], sig), true); // 3 prior → this is 4th
  assert.equal(isLoop([sig, other, sig], sig), false);
});

test('slugify produces filesystem-safe slugs', () => {
  assert.equal(slugify('Todo App in Next.js'), 'todo-app-in-next-js');
  assert.equal(slugify('  Weird__Name!! '), 'weird-name');
  assert.equal(slugify('Café Crème'), 'cafe-creme');
  assert.equal(slugify('already-good'), 'already-good');
});

// ── factory reset: confirmation gate + path confinement ─────────────────────

test('confirmMatches — accepts "confirmar" case/accent/whitespace-insensitive, nothing else', () => {
  for (const ok of ['confirmar', 'Confirmar', 'CONFIRMAR', '  confirmar  ', 'confirmár', 'CONFIRMÁR'])
    assert.equal(confirmMatches(ok), true, ok);
  for (const no of ['', 'confirm', 'confirma', 'sim', 'confirmar!', 'delete', 'confirmarr'])
    assert.equal(confirmMatches(no), false, no);
});

test('factoryResetPaths — only workspace/memory, workspace/projects, dataDir/browser-profile', () => {
  const paths = factoryResetPaths('/ws', '/data');
  assert.deepEqual(paths, ['/ws/memory', '/ws/projects', '/data/browser-profile']);
  // every path is confined to the workspace or the data dir — never anything else
  assert.ok(paths.every((p) => p.startsWith('/ws/') || p.startsWith('/data/')));
});

// ── grill-me toggle: default ON, only explicit "0" disables ──────────────────

test('grillMeEnabled — default ON, only explicit "0" disables', () => {
  assert.equal(grillMeEnabled(undefined), true); // fresh DB → ON
  assert.equal(grillMeEnabled('1'), true);
  assert.equal(grillMeEnabled(''), true); // anything not "0" → ON
  assert.equal(grillMeEnabled('0'), false);
});

// ── providers / brain selection ────────────────────────────────────────────────

test('defaultProviderId — ALFRED_PROVIDER wins, else anthropic', () => {
  assert.equal(defaultProviderId({}), 'anthropic');
  assert.equal(defaultProviderId({ ALFRED_PROVIDER: '' }), 'anthropic');
  assert.equal(defaultProviderId({ ALFRED_PROVIDER: '  ' }), 'anthropic');
  assert.equal(defaultProviderId({ ALFRED_PROVIDER: 'openai' }), 'openai');
  assert.equal(defaultProviderId({ ALFRED_PROVIDER: ' deepseek ' }), 'deepseek');
});

test('parseProviderSpec — bare id vs provider:model', () => {
  assert.deepEqual(parseProviderSpec('anthropic'), { id: 'anthropic' });
  assert.deepEqual(parseProviderSpec('openai:gpt-4o'), { id: 'openai', model: 'gpt-4o' });
  assert.deepEqual(parseProviderSpec(' deepseek : deepseek-reasoner '), {
    id: 'deepseek',
    model: 'deepseek-reasoner',
  });
  assert.deepEqual(parseProviderSpec('anthropic:'), { id: 'anthropic', model: undefined });
});

test('keyEnabled — empty or xxxx-placeholder keys are disabled', () => {
  assert.equal(keyEnabled(undefined), false);
  assert.equal(keyEnabled(''), false);
  assert.equal(keyEnabled('   '), false);
  assert.equal(keyEnabled('sk-ant-xxxxxxxxxxxx'), false); // .env.example placeholder
  assert.equal(keyEnabled('sk-XXXX'), false); // case-insensitive
  assert.equal(keyEnabled('sk-ant-real0123456789'), true);
});

// ── pricing / cost estimation ────────────────────────────────────────────────

test('costOf — known models priced per 1M tokens', () => {
  // claude-sonnet-5: $2/M in, $10/M out
  assert.equal(costOf('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0 }), 2);
  assert.equal(costOf('claude-sonnet-5', { inputTokens: 0, outputTokens: 1_000_000 }), 10);
  assert.equal(costOf('claude-sonnet-5', { inputTokens: 500_000, outputTokens: 100_000 }), 2);
  // deepseek-v4-flash: $0.14/M in, $0.28/M out
  assert.ok(Math.abs(costOf('deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }) - 0.42) < 1e-9);
});

test('costOf — unknown model falls back to 0, flagged by isKnownModel', () => {
  assert.equal(costOf('mystery-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
  assert.equal(isKnownModel('mystery-model'), false);
  assert.equal(isKnownModel('gpt-4o'), true);
  assert.equal(isKnownModel('deepseek-v4-pro'), true);
});

test('selectBrainId — requested when enabled, else first enabled with fellBack', () => {
  const brains = [
    { id: 'anthropic', label: 'A', enabled: false, model: 'm' },
    { id: 'openai', label: 'O', enabled: true, model: 'm' },
    { id: 'deepseek', label: 'D', enabled: true, model: 'm' },
  ];
  assert.deepEqual(selectBrainId('openai', brains), { id: 'openai', fellBack: false });
  // requested disabled → fall back to first enabled
  assert.deepEqual(selectBrainId('anthropic', brains), { id: 'openai', fellBack: true });
  // unknown id → fall back
  assert.deepEqual(selectBrainId('mystery', brains), { id: 'openai', fellBack: true });
  // nothing enabled → null, no fallback
  const none = brains.map((b) => ({ ...b, enabled: false }));
  assert.deepEqual(selectBrainId('openai', none), { id: null, fellBack: false });
});

// ── card layout: clamp + responsive tiling ──────────────────────────────────

test('clampBox keeps a card on-screen and never larger than the canvas', () => {
  const b = { w: 1000, h: 800 };
  // negative origin pulled back to 0
  assert.deepEqual(clampBox({ x: -50, y: -80, w: 300, h: 200 }, b), { x: 0, y: 0, w: 300, h: 200 });
  // far off bottom-right → at least a sliver (MIN_VISIBLE) + header stay inside
  const c = clampBox({ x: 9999, y: 9999, w: 300, h: 200 }, b);
  assert.ok(c.x >= 0 && c.x <= b.w, 'x within canvas');
  assert.ok(c.x < b.w, 'some of the card is visible horizontally');
  assert.ok(c.y >= 0 && c.y < b.h, 'header stays reachable');
  // oversized card capped to the canvas
  const big = clampBox({ x: 0, y: 0, w: 5000, h: 5000 }, b);
  assert.equal(big.w, 1000);
  assert.equal(big.h, 800);
  // sub-minimum size floored to the minimum card size
  assert.equal(clampBox({ x: 0, y: 0, w: 10, h: 10 }, b).w, 220);
  assert.equal(clampBox({ x: 0, y: 0, w: 10, h: 10 }, b).h, 120);
});

test('tileLayout fits every card inside the bounds, in order', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const tiles = tileLayout(ids, { w: 1200, h: 800 });
  assert.equal(tiles.length, ids.length);
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.y >= 0, 'non-negative origin');
    assert.ok(t.x + t.w <= 1200 + 1, 'within width');
    assert.ok(t.y + t.h <= 800 + 1, 'within height');
    assert.ok(t.w >= 220 && t.h >= 120, 'respects minimum size');
  }
  assert.equal(tileLayout([], { w: 100, h: 100 }).length, 0);
  // narrow window → single column, cards stacked vertically
  const narrow = tileLayout(['a', 'b'], { w: 300, h: 800 });
  assert.equal(narrow[0].x, narrow[1].x);
  assert.ok(narrow[1].y > narrow[0].y);
});

// ── multi-monitor: card ↔ display assignment ─────────────────────────────────

test('cardOnDisplay — concrete id matches its window; sentinels resolve', () => {
  // concrete display pinning
  assert.equal(cardOnDisplay('101', '101', false), true);
  assert.equal(cardOnDisplay('101', '202', false), false);
  // 'main' shows only on the primary window
  assert.equal(cardOnDisplay(DISPLAY_MAIN, '101', true), true);
  assert.equal(cardOnDisplay(DISPLAY_MAIN, '101', false), false);
  // 'all' mirrors everywhere
  assert.equal(cardOnDisplay(DISPLAY_ALL, '101', false), true);
  assert.equal(cardOnDisplay(DISPLAY_ALL, '202', true), true);
  // empty myDisplayId (windowed / single-window fallback) → everything shows
  assert.equal(cardOnDisplay('202', '', false), true);
  assert.equal(cardOnDisplay(DISPLAY_MAIN, '', false), true);
});

test('resolveCardDisplay — a card on a vanished display falls back to primary', () => {
  const present = ['101', '202'];
  assert.equal(resolveCardDisplay('101', present), '101'); // still here
  assert.equal(resolveCardDisplay('303', present), DISPLAY_MAIN); // unplugged → primary
  assert.equal(resolveCardDisplay(DISPLAY_MAIN, present), DISPLAY_MAIN); // sentinel untouched
  assert.equal(resolveCardDisplay(DISPLAY_ALL, present), DISPLAY_ALL);
  assert.equal(resolveCardDisplay('101', []), DISPLAY_MAIN); // no displays known → primary
});

test('nextDisplayId — cycles to the next monitor, wraps, resolves main/unknown', () => {
  const displays = [
    { id: '100', primary: true },
    { id: '200', primary: false },
    { id: '300', primary: false },
  ];
  // concrete id → next, wrapping past the end back to the primary
  assert.equal(nextDisplayId('100', displays), '200');
  assert.equal(nextDisplayId('200', displays), '300');
  assert.equal(nextDisplayId('300', displays), '100');
  // 'main' sentinel resolves to the primary, then steps to the next
  assert.equal(nextDisplayId(DISPLAY_MAIN, displays), '200');
  // unknown id (e.g. a stale pin) starts at the first display
  assert.equal(nextDisplayId('999', displays), '200');
  // nowhere to move with fewer than two displays
  assert.equal(nextDisplayId('100', [{ id: '100', primary: true }]), undefined);
  assert.equal(nextDisplayId('100', []), undefined);
});

// ── multi-monitor: ui_layout display resolution (move cards between monitors) ─

const DISPLAYS: DisplayGeom[] = [
  { id: '100', label: 'Built-in', primary: true, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
  { id: '200', label: 'DELL', primary: false, bounds: { x: 1440, y: 0, width: 3840, height: 2160 }, workArea: { x: 1440, y: 0, width: 3840, height: 2160 } },
];

test('displayForCard — concrete id, sentinels + stale ids fall back to primary', () => {
  assert.equal(displayForCard('200', DISPLAYS)?.id, '200');
  assert.equal(displayForCard('100', DISPLAYS)?.id, '100');
  assert.equal(displayForCard(DISPLAY_MAIN, DISPLAYS)?.id, '100'); // sentinel → primary
  assert.equal(displayForCard(DISPLAY_ALL, DISPLAYS)?.id, '100');
  assert.equal(displayForCard('999', DISPLAYS)?.id, '100'); // stale → primary
  assert.equal(displayForCard('200', []), undefined); // no displays known
});

test('resolveMoveTarget — omitted keeps current display; explicit id moves + clamps there', () => {
  // omitted → stay on the card's current display, its geometry returned for clamping
  assert.deepEqual(resolveMoveTarget(undefined, '100', DISPLAYS), { displayId: '100', display: DISPLAYS[0] });
  // explicit concrete id → reassign + target that monitor
  assert.deepEqual(resolveMoveTarget('200', '100', DISPLAYS), { displayId: '200', display: DISPLAYS[1] });
  // sentinels are accepted verbatim, clamped to the primary
  assert.deepEqual(resolveMoveTarget(DISPLAY_MAIN, '200', DISPLAYS), { displayId: DISPLAY_MAIN, display: DISPLAYS[0] });
  assert.deepEqual(resolveMoveTarget(DISPLAY_ALL, '200', DISPLAYS), { displayId: DISPLAY_ALL, display: DISPLAYS[0] });
});

test('resolveMoveTarget — unknown requested id errors; stale current id silently falls back', () => {
  const bad = resolveMoveTarget('999', '100', DISPLAYS);
  assert.ok('error' in bad && /Unknown displayId/.test(bad.error));
  // a card pinned to a now-gone display, no explicit request → keep id, clamp on primary (no error)
  assert.deepEqual(resolveMoveTarget(undefined, '999', DISPLAYS), { displayId: '999', display: DISPLAYS[0] });
  // no displays known (single-window fallback) → pass the id through, no display to clamp to
  assert.deepEqual(resolveMoveTarget('200', '100', []), { displayId: '200' });
  assert.deepEqual(resolveMoveTarget(undefined, '100', []), { displayId: '100' });
});

test('resolveMoveTarget + clampBox — a move to the big monitor clamps to ITS bounds, not the primary', () => {
  const t = resolveMoveTarget('200', '100', DISPLAYS);
  assert.ok(!('error' in t) && t.display);
  const box = t.display!.bounds;
  // a position valid only on the 3840×2160 monitor stays put (would be clamped off the 1440-wide primary)
  const c = clampBox({ x: 3000, y: 1500, w: 300, h: 200 }, { w: box.width, h: box.height });
  assert.equal(c.x, 3000);
  assert.equal(c.y, 1500);
});

// ── workspace CLAUDE.md (claude -p identity) ─────────────────────────────────

test('claudeMdNeedsWrite — (re)write only when the Alfred marker is absent', () => {
  assert.equal(claudeMdNeedsWrite(''), true); // missing/empty
  assert.equal(claudeMdNeedsWrite('# My own notes\nkeep this'), true); // unmanaged
  const managed = buildClaudeMd('IDENTITY-BODY');
  assert.equal(claudeMdNeedsWrite(managed), false); // managed → respect user edits
  assert.match(managed, /managed by Alfred/);
  assert.match(managed, /Alfred/);
  assert.match(managed, /IDENTITY-BODY/); // single-source identity is embedded
});

// ── long-term memory: date filtering, grep, truncation, transcript ───────────

test('journalDay formats local YYYY-MM-DD', () => {
  assert.equal(journalDay(new Date(2026, 6, 21)), '2026-07-21');
  assert.equal(journalDay(new Date(2026, 0, 3)), '2026-01-03');
});

test('isWithinDays — inclusive window back from today, future excluded', () => {
  const today = '2026-07-21';
  assert.equal(isWithinDays('2026-07-21', today, 7), true); // today
  assert.equal(isWithinDays('2026-07-15', today, 7), true); // 6 days back
  assert.equal(isWithinDays('2026-07-14', today, 7), false); // 7 days back → out
  assert.equal(isWithinDays('2026-07-22', today, 7), false); // future
  assert.equal(isWithinDays('garbage', today, 7), false);
});

test('matchesQuery — case-insensitive substring, blank matches all', () => {
  assert.equal(matchesQuery('Bought milk', 'milk'), true);
  assert.equal(matchesQuery('Bought MILK', 'milk'), true);
  assert.equal(matchesQuery('Bought milk', 'eggs'), false);
  assert.equal(matchesQuery('anything', ''), true);
  assert.equal(matchesQuery('anything', undefined), true);
});

test('filterLines — keeps non-blank matching lines only', () => {
  const content = '- [t1] apple\n\n- [t2] banana\n- [t3] apple pie';
  assert.deepEqual(filterLines(content), ['- [t1] apple', '- [t2] banana', '- [t3] apple pie']);
  assert.deepEqual(filterLines(content, 'apple'), ['- [t1] apple', '- [t3] apple pie']);
  assert.deepEqual(filterLines('   \n\n', 'x'), []);
});

test('truncateHead — keeps the recent tail, drops oldest whole lines', () => {
  assert.equal(truncateHead('short', 100), 'short'); // under cap → unchanged
  const text = 'line1\nline2\nline3\nline4';
  const out = truncateHead(text, 12);
  assert.ok(out.startsWith('…(truncated)\n'));
  assert.ok(out.includes('line4')); // newest survives
  assert.ok(!out.includes('line1')); // oldest dropped
  assert.ok(out.length <= '…(truncated)\n'.length + 12);
});

test('formatTranscript — role: content lines, blanks skipped, tail-capped', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '  ' },
    { role: 'user', content: 'again' },
  ];
  assert.equal(formatTranscript(msgs, 1000), 'user: hi\nuser: again');
  assert.equal(formatTranscript([], 1000), '');
});

test('resolveActiveBrainId — persisted → env → first enabled (claude-code last)', () => {
  const brains = [
    { id: 'anthropic', label: 'A', enabled: true, model: 'm' },
    { id: 'openai', label: 'O', enabled: true, model: 'm' },
    { id: 'deepseek', label: 'D', enabled: false, model: 'm' },
    { id: 'claude-code', label: 'CC', enabled: true, model: 'claude -p' },
  ];
  // persisted wins when enabled
  assert.equal(resolveActiveBrainId('openai', {}, brains), 'openai');
  assert.equal(resolveActiveBrainId('claude-code', {}, brains), 'claude-code');
  // persisted disabled → env (ALFRED_PROVIDER)
  assert.equal(resolveActiveBrainId('deepseek', { ALFRED_PROVIDER: 'openai' }, brains), 'openai');
  // no persisted, no env → default anthropic (enabled)
  assert.equal(resolveActiveBrainId(undefined, {}, brains), 'anthropic');
  // env set but disabled → first enabled chat brain, never claude-code while a chat brain is up
  const noAnthropic = brains.map((b) => (b.id === 'anthropic' ? { ...b, enabled: false } : b));
  assert.equal(resolveActiveBrainId(undefined, { ALFRED_PROVIDER: 'anthropic' }, noAnthropic), 'openai');
  // only claude-code enabled → it becomes active
  const onlyCc = brains.map((b) => ({ ...b, enabled: b.id === 'claude-code' }));
  assert.equal(resolveActiveBrainId(undefined, {}, onlyCc), 'claude-code');
  // nothing enabled → null
  assert.equal(resolveActiveBrainId('openai', {}, brains.map((b) => ({ ...b, enabled: false }))), null);
});

// ── vault notes: parse / serialize / merge / MOC + backlinks ─────────────────

test('parseHashtags + extractWikilinks — deduped, order-preserving', () => {
  assert.deepEqual(parseHashtags('fix #bug in #Auth, again #bug'), ['bug', 'Auth']);
  assert.deepEqual(parseHashtags('nothing here'), []);
  assert.deepEqual(extractWikilinks('see [[Foo Bar]] and [[Baz]] and [[Foo Bar]]'), ['Foo Bar', 'Baz']);
});

test('parseObservations — typed one-liners with tags', () => {
  const body = '## Observations\n- [decision] chose X over Y #arch\n- [gotcha] Z breaks on empty #bug\n\n## Relations\n- uses [[T]]';
  assert.deepEqual(parseObservations(body), [
    { category: 'decision', text: 'chose X over Y #arch', tags: ['arch'] },
    { category: 'gotcha', text: 'Z breaks on empty #bug', tags: ['bug'] },
  ]);
  // relation lines are not observations
  assert.equal(parseObservations('- uses [[T]]').length, 0);
});

test('parseRelations — typed wikilinks only', () => {
  const body = '- part_of [[Projects — X]]\n- uses [[Tool — Y]]\n- [fact] not a relation';
  assert.deepEqual(parseRelations(body), [
    { type: 'part_of', target: 'Projects — X' },
    { type: 'uses', target: 'Tool — Y' },
  ]);
});

test('parseFrontmatter — scalars + tags array + body', () => {
  const md = '---\ntitle: Foo\ntype: tool\ntags: [a, b, c]\n---\n\nbody line';
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.title, 'Foo');
  assert.equal(data.type, 'tool');
  assert.deepEqual(data.tags, ['a', 'b', 'c']);
  assert.equal(body.trim(), 'body line');
  // no frontmatter → whole string is the body
  assert.deepEqual(parseFrontmatter('just text'), { data: {}, body: 'just text' });
});

test('serializeNote → parseNote roundtrips', () => {
  const note: Note = {
    title: 'Alfred Memory',
    type: 'note',
    created: '2026-07-21',
    updated: '2026-07-22',
    tags: ['memory', 'icm'],
    observations: [{ category: 'decision', text: 'file-first, no vector DB', tags: [] }],
    relations: [{ type: 'part_of', target: 'Projects — Alfred' }],
  };
  const round = parseNote(serializeNote(note));
  assert.equal(round.title, 'Alfred Memory');
  assert.equal(round.type, 'note');
  assert.deepEqual(round.tags, ['memory', 'icm']);
  assert.equal(round.observations[0].category, 'decision');
  assert.equal(round.observations[0].text, 'file-first, no vector DB');
  assert.deepEqual(round.relations, [{ type: 'part_of', target: 'Projects — Alfred' }]);
});

test('mergeNotes — union observations/relations/tags, keep created, bump updated', () => {
  const base: Note = {
    title: 'X', type: 'note', created: '2026-07-01', updated: '2026-07-01', tags: ['a'],
    observations: [{ category: 'fact', text: 'one', tags: [] }],
    relations: [{ type: 'uses', target: 'T' }],
  };
  const incoming: Note = {
    title: 'X', type: 'note', created: '2026-07-22', updated: '2026-07-22', tags: ['a', 'b'],
    observations: [{ category: 'fact', text: 'one', tags: [] }, { category: 'tip', text: 'two', tags: [] }],
    relations: [{ type: 'uses', target: 'T' }, { type: 'part_of', target: 'P' }],
  };
  const m = mergeNotes(base, incoming);
  assert.equal(m.created, '2026-07-01'); // original preserved
  assert.equal(m.updated, '2026-07-22'); // bumped
  assert.deepEqual(m.tags, ['a', 'b']); // union, deduped
  assert.equal(m.observations.length, 2); // 'one' not duplicated
  assert.equal(m.relations.length, 2);
});

test('mapNameForType — pluralise, people is irregular', () => {
  assert.equal(mapNameForType('project'), 'projects');
  assert.equal(mapNameForType('tool'), 'tools');
  assert.equal(mapNameForType('person'), 'people');
  assert.equal(mapNameForType('decision'), 'decisions');
});

test('buildBacklinks — target title → source slugs (relations + observation links)', () => {
  const notes = [
    { slug: 'a', note: { title: 'A', type: 'note', tags: [], observations: [{ category: 'fact', text: 'see [[C]]', tags: [] }], relations: [{ type: 'uses', target: 'B' }] } as Note },
    { slug: 'b', note: { title: 'B', type: 'note', tags: [], observations: [], relations: [{ type: 'uses', target: 'C' }] } as Note },
  ];
  const bl = buildBacklinks(notes);
  assert.deepEqual(bl['C'].sort(), ['a', 'b']);
  assert.deepEqual(bl['B'], ['a']);
});

test('buildIndex / buildMap — group by type, wikilink every note', () => {
  const notes = [
    { slug: 'x', note: { title: 'X', type: 'tool', tags: [], observations: [], relations: [] } as Note },
    { slug: 'y', note: { title: 'Y', type: 'project', tags: [], observations: [], relations: [] } as Note },
  ];
  const idx = buildIndex(notes);
  assert.match(idx, /\[\[X\]\]/);
  assert.match(idx, /\[\[Y\]\]/);
  assert.match(buildIndex([]), /No notes yet/);
  const map = buildMap('tool', notes);
  assert.match(map, /Tools — MOC/);
  assert.match(map, /\[\[X\]\]/);
  assert.ok(!map.includes('[[Y]]')); // only the tool type
});

test('pickCuratorSpec — explicit env wins, else cheapest enabled API brain', () => {
  const brains = [
    { id: 'anthropic', label: 'A', enabled: true, model: 'claude-sonnet-5' },
    { id: 'openai', label: 'O', enabled: true, model: 'gpt-4o' },
    { id: 'deepseek', label: 'D', enabled: true, model: 'deepseek-v4-flash' },
    { id: 'claude-code', label: 'CC', enabled: true, model: 'claude -p' },
  ];
  assert.equal(pickCuratorSpec({ ALFRED_CURATOR_MODEL: 'openai:gpt-4o' }, brains), 'openai:gpt-4o');
  // cheapest = deepseek-v4-flash ($0.14/$0.28)
  assert.equal(pickCuratorSpec({}, brains), 'deepseek');
  // deepseek disabled → next cheapest enabled (gpt-4o < claude-sonnet-5 on output? gpt 2.5/10 vs 2/10 → anthropic cheaper input; ranked by 1:1 sum: anthropic 12, gpt 12.5) → anthropic
  const noDeep = brains.map((b) => (b.id === 'deepseek' ? { ...b, enabled: false } : b));
  assert.equal(pickCuratorSpec({}, noDeep), 'anthropic');
  // nothing enabled (except claude-code, excluded) → null
  const none = brains.map((b) => ({ ...b, enabled: b.id === 'claude-code' }));
  assert.equal(pickCuratorSpec({}, none), null);
});

// ── system tool: pure parsers ────────────────────────────────────────────────

test('parseBattery — discharging with time estimate', () => {
  const out =
    "Now drawing from 'Battery Power'\n" +
    ' -InternalBattery-0 (id=4325091)\t87%; discharging; 3:42 remaining present: true';
  assert.deepEqual(parseBattery(out), { percent: 87, charging: false, timeRemaining: '3:42' });
});

test('parseBattery — charging / charged / no-estimate', () => {
  const charging =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4325091)\t54%; charging; 1:05 remaining present: true";
  assert.deepEqual(parseBattery(charging), { percent: 54, charging: true, timeRemaining: '1:05' });

  const charged =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4325091)\t100%; charged; 0:00 remaining present: true";
  assert.deepEqual(parseBattery(charged), { percent: 100, charging: true, timeRemaining: null });

  const noEst =
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4325091)\t45%; finishing charge; (no estimate) present: true";
  assert.deepEqual(parseBattery(noEst), { percent: 45, charging: true, timeRemaining: null });
});

test('parseVolume — reads level + muted from "get volume settings"', () => {
  assert.deepEqual(parseVolume('output volume:42, input volume:75, alert volume:100, output muted:false'), {
    volume: 42,
    muted: false,
  });
  assert.deepEqual(parseVolume('output volume:0, input volume:75, alert volume:100, output muted:true'), {
    volume: 0,
    muted: true,
  });
});

test('parseBrightness — first float from `brightness -l`', () => {
  const out =
    'display 0: main, active, awake, online, built-in, ID 0x4280a40\ndisplay 0: brightness 0.849998\n';
  assert.equal(parseBrightness(out), 0.849998);
  assert.equal(parseBrightness('no brightness here'), null);
});

test('parseWifi — ssid + power', () => {
  assert.equal(parseWifiSsid('Current Wi-Fi Network: HomeNet-5G'), 'HomeNet-5G');
  assert.equal(parseWifiSsid('You are not associated with an AirPort network.'), null);
  assert.equal(parseWifiPower('Wi-Fi Power (en0): On'), true);
  assert.equal(parseWifiPower('Wi-Fi Power (en0): Off'), false);
});

test('parseAppsRunning — names from `lsappinfo list`, de-duped', () => {
  const out =
    '    1) "Finder" ASN:0x0-0x3003:\n' +
    '        bringForward: denied\n' +
    '    2) "Safari" ASN:0x0-0x1e01e:\n' +
    '    3) "Finder" ASN:0x0-0x3003:\n';
  assert.deepEqual(parseAppsRunning(out), ['Finder', 'Safari']);
});

test('parseProcessList — comma-separated osascript output', () => {
  assert.deepEqual(parseProcessList('Finder, Safari, Terminal, Electron'), [
    'Finder',
    'Safari',
    'Terminal',
    'Electron',
  ]);
  assert.deepEqual(parseProcessList(''), []);
});

test('system.risk — reads T0, reversible controls T1, destructive T2', () => {
  const risk = (op: string) => system.risk!({ op } as never);
  // reads → T0
  for (const op of ['battery', 'volume_get', 'brightness_get', 'displays', 'wifi', 'apps_running', 'app_frontmost', 'clipboard_read'])
    assert.equal(risk(op), 'T0', `${op} should be T0`);
  // reversible controls → T1
  for (const op of ['volume_set', 'brightness_set', 'app_open', 'notify', 'clipboard_write', 'caffeinate', 'screenshot', 'grill_me_on', 'grill_me_off', 'grill_me_toggle'])
    assert.equal(risk(op), 'T1', `${op} should be T1`);
  // destructive / disruptive → T2
  for (const op of ['app_quit', 'lock', 'sleep']) assert.equal(risk(op), 'T2', `${op} should be T2`);
});

test('parseDisplays — resolution + main flag, never throws on garbage', () => {
  const json = JSON.stringify({
    SPDisplaysDataType: [
      {
        _name: 'Intel Iris',
        spdisplays_ndrvs: [
          { _name: 'Color LCD', _spdisplays_resolution: '2880 x 1800', spdisplays_main: 'spdisplays_yes' },
          { _name: 'DELL U2720Q', _spdisplays_resolution: '3840 x 2160' },
        ],
      },
    ],
  });
  assert.deepEqual(parseDisplays(json), [
    { name: 'Color LCD', resolution: '2880 x 1800', main: true },
    { name: 'DELL U2720Q', resolution: '3840 x 2160', main: false },
  ]);
  assert.deepEqual(parseDisplays('not json'), []);
  assert.deepEqual(parseDisplays('{}'), []);
});

// ── tool risk() gates — the authoritative per-tool classifier (overrides classifyAction) ──

test('shell.risk — destructive commands escalate to T2, ordinary ones stay T1', () => {
  const risk = (command: string) => shell.risk!({ command } as never);
  // reversible / read-only work
  for (const c of ['ls -la', 'git status --porcelain', 'echo hi > out.txt', 'cat file', 'node build.js'])
    assert.equal(risk(c), 'T1', `${c} should be T1`);
  // destructive / irreversible
  for (const c of ['rm -rf /tmp/x', 'sudo reboot', 'dd if=/dev/zero of=/dev/sda', 'git reset --hard HEAD~3', 'git push origin main --force', 'chmod -R 777 /'])
    assert.equal(risk(c), 'T2', `${c} should be T2`);
});

test('shell.risk — package-manager installs/removals are T2 (supply-chain egress, per AGENTS.md)', () => {
  const risk = (command: string) => shell.risk!({ command } as never);
  for (const c of ['npm install left-pad', 'pnpm add react', 'yarn add -D vitest', 'pip install requests', 'pip3 install numpy', 'brew install jq', 'apt-get install curl', 'gem install rails', 'cargo add serde', 'go install ./...', 'npm uninstall foo', 'brew remove wget'])
    assert.equal(risk(c), 'T2', `${c} should be T2`);
  // non-mutating package-manager reads stay T1
  for (const c of ['npm run build', 'npm test', 'brew list', 'pip list', 'cargo build'])
    assert.equal(risk(c), 'T1', `${c} should be T1`);
});

test('filesystem.risk — read/list T0, mkdir/write T1, delete T2', () => {
  const risk = (op: string) => filesystem.risk!({ op } as never);
  assert.equal(risk('read'), 'T0');
  assert.equal(risk('list'), 'T0');
  assert.equal(risk('write'), 'T1');
  assert.equal(risk('mkdir'), 'T1');
  assert.equal(risk('delete'), 'T2');
});

test('browser.risk — navigation/reading T0, interaction T1', () => {
  const risk = (op: string) => browser.risk!({ op } as never);
  for (const op of ['goto', 'readText', 'screenshot']) assert.equal(risk(op), 'T0', `${op} should be T0`);
  for (const op of ['click', 'type']) assert.equal(risk(op), 'T1', `${op} should be T1`);
});

test('delegate.risk — always T2 (delegates autonomous execution)', () => {
  assert.equal(delegate.risk!({ task: 'anything' } as never), 'T2');
  assert.equal(delegate.risk!({ task: 'read a file' } as never), 'T2');
});

// ── claude -p permission args by DANGEROUS mode ──────────────────────────────

test('dangerousArgs — OFF keeps acceptEdits; ON skips permissions + injects preamble (never both)', () => {
  // OFF → safe default, Claude Code still gates its own tools
  assert.deepEqual(dangerousArgs(false), ['--permission-mode', 'acceptEdits']);
  // ON → skip-permissions supersedes acceptEdits (they must not both appear) +
  // the system-prompt preamble so the brain never asks verbally
  const on = dangerousArgs(true);
  assert.deepEqual(on, ['--dangerously-skip-permissions', '--append-system-prompt', DANGEROUS_SYSTEM_PROMPT]);
  assert.ok(!on.includes('--permission-mode'), 'no conflicting acceptEdits when skipping permissions');
  assert.ok(!on.includes('acceptEdits'));
  assert.match(DANGEROUS_SYSTEM_PROMPT, /never ask for permission/i);
});

// ── governance edge cases ────────────────────────────────────────────────────

test('fullTrifecta — true only when all three flags are set', () => {
  assert.equal(fullTrifecta({ readUntrusted: true, hasPrivate: true, canEgress: true }), true);
  assert.equal(fullTrifecta({ readUntrusted: true, hasPrivate: true, canEgress: false }), false);
  assert.equal(fullTrifecta({ readUntrusted: false, hasPrivate: true, canEgress: true }), false);
  assert.equal(fullTrifecta({ readUntrusted: false, hasPrivate: false, canEgress: false }), false);
});

test('denialError — distinguishes timeout from an explicit deny', () => {
  assert.match(denialError({ timedOut: true }), /timed out/i);
  assert.match(denialError({ timedOut: false }), /denied/i);
  assert.match(denialError({}), /denied/i);
});

test('maskSecrets — redacts nested arrays + more key shapes, leaves plain data', () => {
  const masked = maskSecrets({
    authorization: 'Bearer x',
    Cookie: 'sid=1',
    apiKey: 'k',
    api_key: 'k2',
    bearer: 'b',
    items: [{ password: 'p' }, { name: 'ok' }],
    count: 3,
    nested: { refreshToken: 't', label: 'keep' },
  }) as Record<string, unknown>;
  assert.equal(masked.authorization, '***');
  assert.equal(masked.Cookie, '***');
  assert.equal(masked.apiKey, '***');
  assert.equal(masked.api_key, '***');
  assert.equal(masked.bearer, '***');
  assert.equal((masked.items as Record<string, unknown>[])[0].password, '***');
  assert.equal((masked.items as Record<string, unknown>[])[1].name, 'ok');
  assert.equal(masked.count, 3);
  assert.equal((masked.nested as Record<string, unknown>).refreshToken, '***');
  assert.equal((masked.nested as Record<string, unknown>).label, 'keep');
  // primitives pass through untouched
  assert.equal(maskSecrets('plain'), 'plain');
  assert.equal(maskSecrets(42), 42);
});

// ── stt/wakeword shared protocol reader (line-delimited JSON) ─────────────────

/** Minimal stand-in for a ReadableStream: readJsonLines only ever calls .on('data', …). */
function fakeStream() {
  let handler: (c: Buffer) => void = () => {};
  return {
    on(_e: string, h: (c: Buffer) => void) {
      handler = h;
      return this as unknown as NodeJS.ReadableStream;
    },
    push(s: string) {
      handler(Buffer.from(s));
    },
  };
}

test('readJsonLines — one object per newline, multiple in a single chunk', () => {
  const s = fakeStream();
  const got: Record<string, unknown>[] = [];
  readJsonLines(s as unknown as NodeJS.ReadableStream, (m) => got.push(m));
  s.push('{"partial":"he"}\n{"partial":"hello"}\n');
  assert.deepEqual(got, [{ partial: 'he' }, { partial: 'hello' }]);
});

test('readJsonLines — buffers a partial line across chunks until its newline', () => {
  const s = fakeStream();
  const got: Record<string, unknown>[] = [];
  readJsonLines(s as unknown as NodeJS.ReadableStream, (m) => got.push(m));
  s.push('{"fin');
  assert.equal(got.length, 0, 'no complete line yet');
  s.push('al":"done"}\n');
  assert.deepEqual(got, [{ final: 'done' }]);
});

test('readJsonLines — skips blank and non-JSON lines, keeps the good ones', () => {
  const s = fakeStream();
  const got: Record<string, unknown>[] = [];
  readJsonLines(s as unknown as NodeJS.ReadableStream, (m) => got.push(m));
  s.push('\n  \nnot json\n{"wake":true}\n');
  assert.deepEqual(got, [{ wake: true }]);
});

// ── wakeword: helper-message → StreamEvent routing (wake→command) ────────────

test('wakeStreamEvent — wake enters listening, command reuses the mic path', () => {
  assert.deepEqual(wakeStreamEvent({ wake: true }, 's'), { kind: 'wake.detected', sessionId: 's' });
  // partial = live command-forming feedback
  assert.deepEqual(wakeStreamEvent({ partial: 'abre o' }, 's'), {
    kind: 'stt.partial',
    sessionId: 's',
    text: 'abre o',
  });
  // final = settled command, routed like the mic button (fills the input)
  assert.deepEqual(wakeStreamEvent({ final: 'abre o safari' }, 's'), {
    kind: 'stt.final',
    sessionId: 's',
    text: 'abre o safari',
  });
  // an EMPTY final (wake heard, no command) still routes → UI leaves "listening"
  assert.deepEqual(wakeStreamEvent({ final: '' }, 's'), { kind: 'stt.final', sessionId: 's', text: '' });
  assert.deepEqual(wakeStreamEvent({ error: 'boom' }, 's'), {
    kind: 'error',
    sessionId: 's',
    message: 'wake word: boom',
  });
  // wake must be the boolean true, not a string; unknown/blank lines are ignored
  assert.equal(wakeStreamEvent({ wake: 'true' }, 's'), null);
  assert.equal(wakeStreamEvent({}, 's'), null);
});

// ── wakeword: half-duplex mute while Alfred speaks ───────────────────────────

test('suppressWhileSpeaking — drops wake-path audio events only while speaking', () => {
  const s = 's';
  const wake = { kind: 'wake.detected', sessionId: s } as const;
  const partial = { kind: 'stt.partial', sessionId: s, text: 'alfred' } as const;
  const final = { kind: 'stt.final', sessionId: s, text: 'esconder' } as const;
  const err = { kind: 'error', sessionId: s, message: 'boom' } as const;

  // speaking → wake / partial / final are dropped (self-voice never self-activates)
  assert.equal(suppressWhileSpeaking(wake, true), true);
  assert.equal(suppressWhileSpeaking(partial, true), true);
  assert.equal(suppressWhileSpeaking(final, true), true);
  // errors always pass through, even while speaking
  assert.equal(suppressWhileSpeaking(err, true), false);
  // not speaking → nothing is suppressed
  assert.equal(suppressWhileSpeaking(wake, false), false);
  assert.equal(suppressWhileSpeaking(partial, false), false);
  assert.equal(suppressWhileSpeaking(final, false), false);
});

// ── wakeword: voice-command intent parser ────────────────────────────────────

test('parseVoiceIntent — hide keyword (pt + en), first word, accent/case-insensitive', () => {
  for (const cmd of ['esconder', 'esconde', 'Esconde', 'ESCONDER', 'ocultar', 'oculta', 'hide', 'Hide']) {
    assert.deepEqual(parseVoiceIntent(cmd), { kind: 'hide' }, cmd);
  }
  // trailing text after a hide keyword is discarded (hide takes no text)
  assert.deepEqual(parseVoiceIntent('esconde isto agora'), { kind: 'hide' });
  // trailing punctuation on the keyword still matches
  assert.deepEqual(parseVoiceIntent('Esconde!'), { kind: 'hide' });
});

test('parseVoiceIntent — show keyword (pt + en)', () => {
  for (const cmd of ['aparecer', 'aparece', 'mostrar', 'mostra', 'voltar', 'volta', 'show', 'MOSTRA']) {
    assert.deepEqual(parseVoiceIntent(cmd), { kind: 'show' }, cmd);
  }
  assert.deepEqual(parseVoiceIntent('mostra de novo'), { kind: 'show' });
});

test('parseVoiceIntent — send carries the trailing text; bare send has empty text', () => {
  assert.deepEqual(parseVoiceIntent('enviar olá joão'), { kind: 'send', text: 'olá joão' });
  assert.deepEqual(parseVoiceIntent('envia mensagem para o time'), {
    kind: 'send',
    text: 'mensagem para o time',
  });
  assert.deepEqual(parseVoiceIntent('send the report'), { kind: 'send', text: 'the report' });
  assert.deepEqual(parseVoiceIntent('submit'), { kind: 'send', text: '' });
  // bare "enviar" → submit the current input (empty text)
  assert.deepEqual(parseVoiceIntent('enviar'), { kind: 'send', text: '' });
  assert.deepEqual(parseVoiceIntent('Envia,'), { kind: 'send', text: '' });
  // accented keyword ("envía") normalises to a send too
  assert.deepEqual(parseVoiceIntent('envía isto'), { kind: 'send', text: 'isto' });
});

test('parseVoiceIntent — anything else is dictation, preserving the full text', () => {
  assert.deepEqual(parseVoiceIntent('abre o safari'), { kind: 'dictate', text: 'abre o safari' });
  assert.deepEqual(parseVoiceIntent('qual é a bateria'), { kind: 'dictate', text: 'qual é a bateria' });
  // a keyword mid-sentence does NOT trigger (must be the FIRST word)
  assert.deepEqual(parseVoiceIntent('por favor esconde'), { kind: 'dictate', text: 'por favor esconde' });
  // hyphenated word is not the bare keyword
  assert.deepEqual(parseVoiceIntent('mostra-me as notas'), { kind: 'dictate', text: 'mostra-me as notas' });
  // empty / whitespace → dictation with empty text (wake with no command)
  assert.deepEqual(parseVoiceIntent(''), { kind: 'dictate', text: '' });
  assert.deepEqual(parseVoiceIntent('   '), { kind: 'dictate', text: '' });
});

// ── dictation: voice→input state machine (preview vs commit, user control) ────

test('dictationReduce — partial is preview-only while armed; commit only on final', () => {
  let s = dictationReduce(initialDictation(), { kind: 'activate' });
  assert.equal(s.armed, true);
  s = dictationReduce(s, { kind: 'partial', text: 'abre o' });
  assert.equal(s.preview, 'abre o');
  assert.equal(s.commit.seq, 0); // partials NEVER write to the input
  s = dictationReduce(s, { kind: 'final', text: 'abre o safari' });
  assert.deepEqual(s, { armed: false, preview: '', commit: { text: 'abre o safari', seq: 1 } });
});

test('dictationReduce — after commit, a late/duplicate final is ignored (no re-fill)', () => {
  let s = dictationReduce(initialDictation(), { kind: 'activate' });
  s = dictationReduce(s, { kind: 'final', text: 'olá' });
  const committed = s.commit;
  // A trailing/duplicate final arrives while DISARMED → must not touch the input.
  s = dictationReduce(s, { kind: 'final', text: 'olá' });
  assert.deepEqual(s.commit, committed); // seq unchanged → CommandBar won't re-append
  // A stray partial while disarmed doesn't flicker the (cleared) preview either.
  s = dictationReduce(s, { kind: 'partial', text: 'ruído' });
  assert.equal(s.preview, '');
});

test('dictationReduce — empty final disarms + clears preview, writes nothing', () => {
  let s = dictationReduce(initialDictation(), { kind: 'activate' });
  s = dictationReduce(s, { kind: 'partial', text: 'meio…' });
  s = dictationReduce(s, { kind: 'final', text: '   ' });
  assert.equal(s.armed, false);
  assert.equal(s.preview, '');
  assert.equal(s.commit.seq, 0); // no write
});

test('dictationReduce — each fresh activation commits again (independent utterances)', () => {
  let s = dictationReduce(initialDictation(), { kind: 'activate' });
  s = dictationReduce(s, { kind: 'final', text: 'um' });
  assert.equal(s.commit.seq, 1);
  s = dictationReduce(s, { kind: 'activate' });
  s = dictationReduce(s, { kind: 'final', text: 'dois' });
  assert.equal(s.commit.seq, 2); // new activation → new commit
});

// ── wakeword: fatal-exit / respawn-backoff classifier ────────────────────────

test('classifyWakeExit — a single exit is recoverable, never fatal on its own (code ignored)', () => {
  // Non-zero exit, first fast crash → counted but NOT fatal yet.
  assert.deepEqual(classifyWakeExit(2, 10, 0), { failed: false, fastFailCount: 1 });
  // Non-zero but long-lived → not a crash loop: reset, stay armed.
  assert.deepEqual(classifyWakeExit(2, 999_999, 0), { failed: false, fastFailCount: 0 });
  // Signal death (code null) is treated the same — cadence, not code, decides.
  assert.deepEqual(classifyWakeExit(null, 50, 0), { failed: false, fastFailCount: 1 });
});

test('classifyWakeExit — only a repeated fast-crash loop trips failed (any code)', () => {
  let count = 0;
  let failed = false;
  for (let i = 0; i < WAKE_MAX_FAST_FAILS; i++) {
    const r = classifyWakeExit(2, 100, count);
    count = r.fastFailCount;
    failed = r.failed;
  }
  assert.equal(count, WAKE_MAX_FAST_FAILS);
  assert.equal(failed, true, 'stops respawning only after a genuine fast-crash loop');
});

test('classifyWakeExit — a long-lived exit resets the fast-fail counter, no fail', () => {
  assert.deepEqual(classifyWakeExit(0, 60_000, 2), { failed: false, fastFailCount: 0 });
});

// ── memory: parse/serialize round-trip + merge fallbacks (edge cases) ─────────

test('serializeNote → parseNote round-trips with empty observations & relations', () => {
  const note: Note = {
    title: 'Empty Note', type: 'note', created: '2026-07-21', updated: '2026-07-21',
    tags: [], observations: [], relations: [],
  };
  const round = parseNote(serializeNote(note));
  assert.equal(round.title, 'Empty Note');
  assert.deepEqual(round.tags, []);
  assert.deepEqual(round.observations, []);
  assert.deepEqual(round.relations, []);
});

test('parseFrontmatter — an empty tags array parses to []', () => {
  const { data } = parseFrontmatter('---\ntitle: X\ntags: []\n---\nbody');
  assert.deepEqual(data.tags, []);
});

test('mergeNotes — keeps base.created, inherits missing fields from base', () => {
  const base: Note = {
    title: 'Base', type: 'project', created: '2026-07-01', updated: '2026-07-01',
    tags: ['a'], observations: [], relations: [],
  };
  // incoming lacks created & has blank title/type → base values survive.
  const incoming: Note = {
    title: '', type: '', updated: '2026-07-22',
    tags: [], observations: [], relations: [],
  } as Note;
  const m = mergeNotes(base, incoming);
  assert.equal(m.created, '2026-07-01'); // base creation preserved
  assert.equal(m.updated, '2026-07-22'); // incoming bump wins
  assert.equal(m.title, 'Base'); // blank incoming title → keep base
  assert.equal(m.type, 'project'); // blank incoming type → keep base
});

// ── budget: signature stability + custom loop limit ──────────────────────────

test('callSignature — stable across nested key reordering and array order-sensitive', () => {
  assert.equal(
    callSignature('t', { a: { x: 1, y: 2 }, list: [1, 2] }),
    callSignature('t', { list: [1, 2], a: { y: 2, x: 1 } }),
  );
  // arrays are order-significant (not sorted)
  assert.notEqual(callSignature('t', { list: [1, 2] }), callSignature('t', { list: [2, 1] }));
});

test('isLoop — honours a custom limit', () => {
  const sig = callSignature('x', {});
  assert.equal(isLoop([sig], sig, 1), true); // 1 prior meets limit 1
  assert.equal(isLoop([], sig, 1), false);
  assert.equal(isLoop([sig, sig], sig, 5), false); // well under
});

test('costOf — zero usage costs nothing even for a known model', () => {
  assert.equal(costOf('claude-sonnet-5', { inputTokens: 0, outputTokens: 0 }), 0);
});

// ── MCP bridge: pure config/mapping (mcpConfig.ts) ───────────────────────────

test('mcpToolName — Claude Code namespacing mcp__<server>__<tool>', () => {
  assert.equal(mcpToolName('ui_layout'), 'mcp__alfred__ui_layout');
  assert.equal(mcpToolName('system', 'other'), 'mcp__other__system');
});

test('toMcpTools — maps registry tools to name/description/inputSchema only', () => {
  const tools = [
    { name: 'a', description: 'da', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) },
    { name: 'b', description: 'db', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) },
  ] as any;
  const mapped = toMcpTools(tools);
  assert.deepEqual(mapped, [
    { name: 'a', description: 'da', inputSchema: { type: 'object', properties: {} } },
    { name: 'b', description: 'db', inputSchema: { type: 'object' } },
  ]);
});

test('buildMcpConfig — Streamable HTTP server with bearer header', () => {
  const cfg = buildMcpConfig({ url: 'http://127.0.0.1:5051/mcp', token: 'tok123' });
  assert.deepEqual(cfg, {
    mcpServers: {
      alfred: {
        type: 'http',
        url: 'http://127.0.0.1:5051/mcp',
        headers: { Authorization: 'Bearer tok123' },
      },
    },
  });
});

test('buildAllowedTools — one mcp__alfred__ entry per tool', () => {
  assert.deepEqual(buildAllowedTools(['ui_layout', 'system']), [
    'mcp__alfred__ui_layout',
    'mcp__alfred__system',
  ]);
});

test('bridgeEnabled — default on, explicit off values disable', () => {
  assert.equal(bridgeEnabled({}), true);
  assert.equal(bridgeEnabled({ ALFRED_MCP_BRIDGE: '' }), true);
  assert.equal(bridgeEnabled({ ALFRED_MCP_BRIDGE: '1' }), true);
  assert.equal(bridgeEnabled({ ALFRED_MCP_BRIDGE: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(bridgeEnabled({ ALFRED_MCP_BRIDGE: v }), false, v);
  }
});

test('mcpCliArgs — attaches --mcp-config + --allowedTools when a bridge is live', () => {
  const bridge = { url: 'http://127.0.0.1:9/mcp', token: 't', tools: ['ui_layout', 'system'] };
  const args = mcpCliArgs({}, bridge);
  assert.equal(args[0], '--mcp-config');
  assert.deepEqual(JSON.parse(args[1]), buildMcpConfig(bridge));
  // strict: the child ignores the user's own MCP servers, sees only Alfred's.
  assert.equal(args[2], '--strict-mcp-config');
  assert.equal(args[3], '--allowedTools');
  assert.equal(args[4], 'mcp__alfred__ui_layout,mcp__alfred__system');
});

test('mcpCliArgs — empty (fallback) when no bridge or disabled by env', () => {
  assert.deepEqual(mcpCliArgs({}, null), []);
  const bridge = { url: 'http://127.0.0.1:9/mcp', token: 't', tools: ['system'] };
  assert.deepEqual(mcpCliArgs({ ALFRED_MCP_BRIDGE: 'off' }, bridge), []);
});

test('gmailConfigured — accepts a real Desktop-app client', () => {
  assert.equal(
    gmailConfigured({
      GOOGLE_OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-realsecretvalue',
    }),
    true,
  );
  // surrounding whitespace is tolerated
  assert.equal(
    gmailConfigured({
      GOOGLE_OAUTH_CLIENT_ID: '  123-abc.apps.googleusercontent.com  ',
      GOOGLE_OAUTH_CLIENT_SECRET: '  GOCSPX-x  ',
    }),
    true,
  );
});

test('gmailConfigured — rejects missing / placeholder / malformed values', () => {
  assert.equal(gmailConfigured({}), false, 'both missing');
  assert.equal(gmailConfigured({ GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' }), false, 'empty');
  assert.equal(
    gmailConfigured({ GOOGLE_OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com' }),
    false,
    'secret missing',
  );
  assert.equal(
    gmailConfigured({
      GOOGLE_OAUTH_CLIENT_ID: 'your-client-id.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'your-client-secret',
    }),
    false,
    'your-client-id placeholder',
  );
  assert.equal(
    gmailConfigured({
      GOOGLE_OAUTH_CLIENT_ID: 'xxxx.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-real',
    }),
    false,
    'xxxx placeholder',
  );
  assert.equal(
    gmailConfigured({
      GOOGLE_OAUTH_CLIENT_ID: '123-abc',
      GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-real',
    }),
    false,
    'wrong id shape',
  );
});

// ── model catalog + per-agent config ─────────────────────────────────────────

import {
  listModels,
  findModel,
  priceOf,
  catalogPrices,
  DEFAULT_MODEL,
  MODEL_CATALOG,
  PROVIDER_IDS,
  brainToProvider,
  providerToBrain,
  coerceAgent,
  parseAgentConfig,
  hasPersistedAgent,
  agentToSpec,
  agentClaudeModel,
  type AgentConfig,
} from '../src/main/core/modelCatalog.ts';

test('catalog — listModels/findModel/priceOf, Anthropic shared by both Claude providers', () => {
  assert.ok(listModels('deepseek').length === 2);
  assert.equal(findModel('claude-api', 'claude-sonnet-5')?.name, 'Sonnet 5');
  assert.equal(findModel('openai', 'nope'), undefined);
  assert.deepEqual(priceOf('deepseek', 'deepseek-v4-flash'), { inputPerM: 0.14, outputPerM: 0.28 });
  assert.equal(priceOf('claude-cli', 'ghost'), undefined);
  // claude-api and claude-cli intentionally expose the SAME Anthropic list
  assert.equal(MODEL_CATALOG['claude-api'], MODEL_CATALOG['claude-cli']);
  assert.deepEqual(listModels('claude-api').map((m) => m.id), listModels('claude-cli').map((m) => m.id));
  // sonnet-5 carries the intro-pricing note
  assert.match(findModel('claude-api', 'claude-sonnet-5')!.notes!, /2026-09-01/);
});

test('catalog — every provider default is a real model in its own list', () => {
  for (const p of PROVIDER_IDS) assert.ok(findModel(p, DEFAULT_MODEL[p]), `${p} default missing`);
});

test('catalogPrices — flat table prices any catalog model (feeds the cost estimator)', () => {
  const prices = catalogPrices();
  assert.deepEqual(prices['claude-sonnet-5'], { inputPerM: 2, outputPerM: 10 });
  assert.deepEqual(prices['gpt-5.6-luna'], { inputPerM: 1, outputPerM: 6 });
  assert.deepEqual(prices['deepseek-v4-pro'], { inputPerM: 0.435, outputPerM: 0.87 });
});

test('pricing.ts merges the catalog so any selected model is known', () => {
  assert.equal(isKnownModel('claude-opus-4-8'), true);
  assert.equal(isKnownModel('gpt-5.6-terra'), true);
  assert.equal(costOf('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 }), 5);
});

test('brain-id ⇄ provider-id — the two vocabularies map both ways', () => {
  assert.equal(brainToProvider('anthropic'), 'claude-api');
  assert.equal(brainToProvider('claude-code'), 'claude-cli');
  assert.equal(brainToProvider('openai'), 'openai');
  assert.equal(brainToProvider('deepseek'), 'deepseek');
  assert.equal(brainToProvider('mystery'), 'claude-api'); // unknown → claude-api
  assert.equal(providerToBrain('claude-api'), 'anthropic');
  assert.equal(providerToBrain('claude-cli'), 'claude-code');
});

test('coerceAgent — invalid provider/model snap to the fallback / provider default', () => {
  const fb: AgentConfig = { name: 'Main', provider: 'claude-api', model: 'claude-sonnet-5' };
  // wholesale garbage → fallback
  assert.deepEqual(coerceAgent(null, fb), fb);
  // bad provider → fallback provider kept
  assert.deepEqual(coerceAgent({ provider: 'nope', model: 'x' }, fb), fb);
  // valid provider, invalid model → snap to that provider's default
  assert.deepEqual(coerceAgent({ provider: 'deepseek', model: 'x' }, fb), {
    name: 'Main',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
  // blank name ignored (fallback kept), whitespace trimmed
  assert.equal(coerceAgent({ name: '   ' }, fb).name, 'Main');
  assert.equal(coerceAgent({ name: '  Boss  ' }, fb).name, 'Boss');
});

test('parseAgentConfig — defaults when empty; persisted merged over defaults', () => {
  const mainDefault: AgentConfig = { name: 'Main', provider: 'claude-api', model: 'claude-sonnet-5' };
  const empty = parseAgentConfig(undefined, mainDefault);
  assert.deepEqual(empty.main, mainDefault);
  assert.deepEqual(empty.reference, { name: 'Reference', provider: 'deepseek', model: 'deepseek-v4-flash' });
  assert.deepEqual(empty.curator, { name: 'Curator', provider: 'deepseek', model: 'deepseek-v4-flash' });
  // persisted main overrides; secondaries stay default
  const merged = parseAgentConfig(JSON.stringify({ main: { provider: 'openai', model: 'gpt-5.6-luna', name: 'Jarvis' } }), mainDefault);
  assert.deepEqual(merged.main, { name: 'Jarvis', provider: 'openai', model: 'gpt-5.6-luna' });
  assert.equal(merged.reference.provider, 'deepseek');
  // malformed JSON → all defaults, never throws
  assert.deepEqual(parseAgentConfig('{not json', mainDefault).main, mainDefault);
});

test('hasPersistedAgent — true only when the key is present in the JSON', () => {
  assert.equal(hasPersistedAgent(undefined, 'curator'), false);
  assert.equal(hasPersistedAgent(JSON.stringify({ main: {} }), 'curator'), false);
  assert.equal(hasPersistedAgent(JSON.stringify({ curator: { provider: 'deepseek' } }), 'curator'), true);
  assert.equal(hasPersistedAgent('garbage', 'curator'), false);
});

test('agentToSpec — brainId:model, claude-cli routes through the anthropic SDK brain', () => {
  assert.equal(agentToSpec({ name: 'M', provider: 'claude-api', model: 'claude-opus-4-8' }), 'anthropic:claude-opus-4-8');
  assert.equal(agentToSpec({ name: 'M', provider: 'claude-cli', model: 'claude-sonnet-5' }), 'anthropic:claude-sonnet-5');
  assert.equal(agentToSpec({ name: 'R', provider: 'deepseek', model: 'deepseek-v4-pro' }), 'deepseek:deepseek-v4-pro');
});

test('agentClaudeModel — main Claude model for delegation, else the default', () => {
  assert.equal(agentClaudeModel(JSON.stringify({ main: { provider: 'claude-cli', model: 'claude-opus-4-8' } })), 'claude-opus-4-8');
  assert.equal(agentClaudeModel(JSON.stringify({ main: { provider: 'claude-api', model: 'claude-haiku-4-5' } })), 'claude-haiku-4-5');
  // non-Claude main → fall back to the default Claude model
  assert.equal(agentClaudeModel(JSON.stringify({ main: { provider: 'deepseek', model: 'deepseek-v4-flash' } })), 'claude-sonnet-5');
  assert.equal(agentClaudeModel(undefined), 'claude-sonnet-5');
});

// ── reference agent (Phase 2): focused-context helpers ────────────────────────

test('toNoteSlug — accepts title, slug, or path; strips .md', () => {
  assert.equal(toNoteSlug('My Note'), 'my-note');
  assert.equal(toNoteSlug('my-note'), 'my-note');
  assert.equal(toNoteSlug('memory/notes/my-note.md'), 'my-note');
  assert.equal(toNoteSlug('My-Note.MD'), 'my-note');
});

test('clip — keeps the head and marks the cut only when over the cap', () => {
  assert.equal(clip('short', 100), 'short');
  const out = clip('x'.repeat(50), 10);
  assert.ok(out.startsWith('x'.repeat(10)));
  assert.ok(out.includes('truncated'));
});

test('selectNeighbors — outgoing wikilinks + incoming backlinks, self excluded, capped', () => {
  const alpha = { title: 'Alpha', relations: [{ target: 'Beta' }], observations: [{ text: 'see [[Gamma]] now' }] };
  const beta = { title: 'Beta', relations: [], observations: [] };
  const gamma = { title: 'Gamma', relations: [], observations: [] };
  const delta = { title: 'Delta', relations: [{ target: 'Alpha' }], observations: [] }; // backlink → Alpha
  const other = { title: 'Other', relations: [], observations: [] };
  const all = [
    { slug: 'alpha', note: alpha },
    { slug: 'beta', note: beta },
    { slug: 'gamma', note: gamma },
    { slug: 'delta', note: delta },
    { slug: 'other', note: other },
  ];
  const slugs = selectNeighbors('Alpha', alpha, all).map((n) => n.slug).sort();
  assert.deepEqual(slugs, ['beta', 'delta', 'gamma']); // outgoing beta/gamma + incoming delta
  assert.ok(!slugs.includes('alpha')); // self excluded
  assert.ok(!slugs.includes('other')); // unrelated excluded
  assert.equal(selectNeighbors('Alpha', alpha, all, 1).length, 1); // cap honoured
});

test('buildReferenceContext — labels the target and is size-capped', () => {
  const ctx = buildReferenceContext(
    { title: 'T', body: 'x'.repeat(100) },
    [{ title: 'N', body: 'y'.repeat(100) }],
    { maxChars: 50, perNeighborChars: 10 },
  );
  assert.ok(ctx.includes('Target note: T'));
  assert.ok(ctx.length <= 50 + '\n…(truncated)'.length);
});

test('buildReferencePrompt — folds context + history + question; drops empty history', () => {
  const p = buildReferencePrompt('CTX', 'Q?', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ]);
  assert.ok(p.includes('# Reference context'));
  assert.ok(p.includes('CTX'));
  assert.ok(p.includes('user: hi'));
  assert.ok(p.includes('assistant: yo'));
  assert.ok(p.includes('# Question'));
  assert.ok(p.includes('Q?'));
  assert.ok(!buildReferencePrompt('CTX', 'Q?').includes('Conversation so far'));
});
