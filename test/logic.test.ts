/**
 * Pure-logic tests. Run with:
 *   node --experimental-strip-types --test test/logic.test.ts
 *
 * Only imports strip-types-safe modules (no native deps): governance, budget,
 * projects. Inline `import('...')` type refs in those files are erased.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAction, isEgressTool, trifectaImpact, maskSecrets } from '../src/main/core/governance.ts';
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
