import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/lib/demo.js';
import { dimsDesk, quotaExhaustion, quotaScope, QUOTA_STALE_MS } from '../src/shared/quota.js';
import { buildOfficeModel } from '../src/shared/office-model.js';
import type { ProviderQuota, QuotaWindow, Session } from '../src/shared/types.js';

const now = Date.now();
const session = (patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  provider: 'claude',
  model: 'claude-opus-4',
  ...patch,
});
const window = (key: string, usedPercent: number, resetsAt: number | null = now + 3600_000) =>
  ({ key, label: key, usedPercent, resetsAt }) as QuotaWindow;
const read = (
  provider: ProviderQuota['provider'],
  windows: QuotaWindow[],
  patch: Partial<ProviderQuota> = {},
): ProviderQuota => ({
  provider,
  state: 'ok',
  windows,
  checkedAt: now - 60_000,
  source: 'test',
  message: '',
  ...patch,
});

test('limits bind by scope: account-wide or one model family', () => {
  assert.deepEqual(quotaScope('claude', 'five_hour'), { kind: 'account' });
  assert.deepEqual(quotaScope('claude', 'seven_day'), { kind: 'account' });
  assert.deepEqual(quotaScope('claude', 'seven_day_opus'), { kind: 'model', model: 'opus' });
  assert.deepEqual(quotaScope('codex', 'codex:primary'), { kind: 'account' });
  assert.deepEqual(quotaScope('codex', 'gpt-5-codex:secondary'), {
    kind: 'model',
    model: 'gpt-5-codex',
  });
  const opus = session();
  const sonnet = session({ model: 'claude-sonnet-4-5' });
  const unknown = session({ model: null });
  const weekOpus = [read('claude', [window('seven_day_opus', 100)])];
  assert.ok(quotaExhaustion(opus, weekOpus, now), 'its own model family is out');
  assert.equal(quotaExhaustion(sonnet, weekOpus, now), undefined, 'another family still works');
  assert.equal(quotaExhaustion(unknown, weekOpus, now), undefined, 'never claimed without a model');
  const fiveHours = [read('claude', [window('five_hour', 100)])];
  for (const s of [opus, sonnet, unknown]) assert.ok(quotaExhaustion(s, fiveHours, now));
  // Another tool's limit never darkens this one.
  assert.equal(quotaExhaustion(session({ provider: 'codex' }), fiveHours, now), undefined);
  assert.equal(quotaExhaustion(session({ provider: 'openclaw' }), fiveHours, now), undefined);
});

test('only a fresh, successful read of a full limit counts; a reset brings the light back', () => {
  const s = session();
  assert.equal(quotaExhaustion(s, [], now), undefined, 'not read yet');
  assert.equal(quotaExhaustion(s, [read('claude', [window('five_hour', 99.9)])], now), undefined);
  for (const state of ['error', 'unavailable'] as const)
    assert.equal(
      quotaExhaustion(s, [read('claude', [window('five_hour', 100)], { state })], now),
      undefined,
      `${state} is unknown, not used up`,
    );
  const stale = read('claude', [window('five_hour', 100)], {
    checkedAt: now - QUOTA_STALE_MS - 1,
  });
  assert.equal(quotaExhaustion(s, [stale], now), undefined, 'a stale read says nothing now');
  const reset = now + 2 * 3600_000;
  const out = quotaExhaustion(
    s,
    [read('claude', [window('five_hour', 100, now + 3600_000), window('seven_day', 100, reset)])],
    now,
  )!;
  assert.equal(out.windows.length, 2);
  assert.equal(out.backAt, reset, 'back once every binding limit resets');
  assert.equal(
    quotaExhaustion(s, [read('claude', [window('five_hour', 100, now - 1)])], now),
    undefined,
    'past its reset time it is back, before the next read',
  );
  const unknownReset = quotaExhaustion(s, [read('claude', [window('five_hour', 100, null)])], now);
  assert.equal(unknownReset?.backAt, null);
});

test('the lights stay on for a running turn, a call or an error; the model carries the read', () => {
  const s = session();
  assert.equal(dimsDesk(s, false), true);
  assert.equal(dimsDesk(s, true), false);
  assert.equal(dimsDesk({ ...s, status: 'call' }, false), false);
  assert.equal(dimsDesk({ ...s, status: 'error' }, false), false);
  const snapshot = demoSnapshot();
  const quotas = [read('claude', [window('five_hour', 100)])];
  const model = buildOfficeModel(snapshot, now, quotas);
  assert.ok(model.view('demo:0')?.quota, 'a Claude desk');
  assert.equal(model.view('demo:1')?.quota, undefined, 'a Codex desk');
  assert.equal(buildOfficeModel(snapshot, now).view('demo:0')?.quota, undefined, 'no reads');
});
