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
  maskSecrets,
  approvalKey,
  isAutoApproved,
} from '../src/main/core/governance.ts';
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
import {
  defaultProviderId,
  parseProviderSpec,
  selectBrainId,
  keyEnabled,
  resolveActiveBrainId,
} from '../src/main/core/providers.ts';
import { costOf, isKnownModel } from '../src/main/core/pricing.ts';
import { clampBox, tileLayout } from '../src/main/core/layout.ts';
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
  for (const op of ['volume_set', 'brightness_set', 'app_open', 'notify', 'clipboard_write', 'caffeinate', 'screenshot'])
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
