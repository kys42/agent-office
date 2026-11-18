import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSignal, type SignalStatics } from '../src/shared/request-signal';

// iOS Safari < 17.4: no AbortSignal.any. Older still: no AbortSignal.timeout either.
const legacyBrowsers: [string, SignalStatics][] = [
  ['without AbortSignal.any', { timeout: AbortSignal.timeout.bind(AbortSignal) }],
  ['without AbortSignal.any or AbortSignal.timeout', {}],
];
const aborted = (signal: AbortSignal) =>
  new Promise<unknown>((resolve) =>
    signal.aborted
      ? resolve(signal.reason)
      : signal.addEventListener('abort', () => resolve(signal.reason), { once: true }),
  );

test('with AbortSignal.any the native combination follows both the caller and the timeout', async () => {
  let combined: AbortSignal[] = [];
  const statics: SignalStatics = {
    any: (signals) => {
      combined = signals;
      return AbortSignal.any(signals);
    },
    timeout: AbortSignal.timeout.bind(AbortSignal),
  };
  const caller = new AbortController();
  const signal = requestSignal(60000, caller.signal, statics);
  assert.equal(combined.length, 2);
  assert.equal(combined[0], caller.signal);
  caller.abort(new Error('newer refresh'));
  assert.equal(((await aborted(signal)) as Error).message, 'newer refresh');

  const timed = requestSignal(5, new AbortController().signal, statics);
  assert.equal(((await aborted(timed)) as DOMException).name, 'TimeoutError');
  // No caller signal: only a timeout, and no combination needed.
  combined = [];
  assert.equal(
    ((await aborted(requestSignal(5, undefined, statics))) as DOMException).name,
    'TimeoutError',
  );
  assert.deepEqual(combined, []);
});

for (const [name, statics] of legacyBrowsers) {
  test(`${name} the caller's abort still cancels the request`, async () => {
    const caller = new AbortController();
    const signal = requestSignal(60000, caller.signal, statics);
    assert.equal(signal.aborted, false);
    caller.abort(new Error('screen closed'));
    assert.equal(signal.aborted, true);
    assert.equal(((await aborted(signal)) as Error).message, 'screen closed');
  });

  test(`${name} the timeout still fires as a TimeoutError`, async () => {
    const caller = new AbortController();
    const signal = requestSignal(5, caller.signal, statics);
    assert.equal(((await aborted(signal)) as DOMException).name, 'TimeoutError');
    // A later caller abort is ignored: the request already ended by timeout.
    caller.abort(new Error('too late'));
    assert.equal((signal.reason as DOMException).name, 'TimeoutError');
    assert.equal(
      ((await aborted(requestSignal(5, undefined, statics))) as DOMException).name,
      'TimeoutError',
    );
  });

  test(`${name} an already-aborted caller signal aborts at once`, () => {
    const caller = new AbortController();
    caller.abort(new Error('already gone'));
    const signal = requestSignal(60000, caller.signal, statics);
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).message, 'already gone');
  });
}
