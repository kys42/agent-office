import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetProbes } from '../server/federation/target-probes.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { TerminalTarget } from '../src/shared/types.js';
const session = demoSnapshot().sessions[0];
const ready: TerminalTarget = {
  kind: 'codex',
  status: 'desktop',
  label: '',
  canSend: true,
  canFocus: false,
};
const forbiddenSend = async () => {
  assert.fail('A probe never sends');
};

test('stalled, failed and healthy targets are isolated; late completion permits fresh recovery', async () => {
  let release!: (value: TerminalTarget | null) => void;
  let calls = 0;
  const pending = new Promise<TerminalTarget | null>((resolve) => {
    release = resolve;
  });
  const probes = new TargetProbes(
    {
      target: (s) => {
        calls++;
        if (s.id === 'broken') throw Error('private');
        return s.id === session.id ? pending : Promise.resolve(ready);
      },
      send: forbiddenSend,
    },
    25,
  );
  try {
    const first = probes.target(session);
    assert.strictEqual(probes.target(session), first, 'concurrent lookup shares work');
    const values = await Promise.all([
      first,
      probes.target({ ...session, id: 'healthy' }),
      probes.target({ ...session, id: 'broken' }),
    ]);
    assert.deepEqual(values, [null, ready, null]);
    for (let i = 0; i < 100; i++)
      assert.strictEqual(
        probes.target(session),
        first,
        'timeout does not launch another native lookup',
      );
    assert.equal(calls, 3);
    release(ready);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await probes.target(session), ready);
    assert.equal(calls, 4);
  } finally {
    release(null);
    probes.close();
  }
});

test('pending work is bounded and close settles queries without dispatching queued calls', async () => {
  let calls = 0;
  const probes = new TargetProbes(
    {
      target: async () => {
        calls++;
        return new Promise(() => {});
      },
      send: forbiddenSend,
    },
    10000,
    1,
  );
  const first = probes.target(session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await probes.target({ ...session, id: 'overflow' }), null);
  probes.close();
  assert.equal(await first, null);
  assert.equal(await probes.target(session), null);
  assert.equal(calls, 1);
});

test('closing before native work starts does not launch the queued probe', async () => {
  let calls = 0;
  const probes = new TargetProbes({
    target: async () => {
      calls++;
      return ready;
    },
    send: forbiddenSend,
  });
  const result = probes.target(session);
  probes.close();
  assert.equal(await result, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});
