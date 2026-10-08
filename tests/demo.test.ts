import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot, deriveDemo } from '../src/lib/demo.js';
import { presentSession } from '../src/shared/presentation.js';
import { buildOfficeModel } from '../src/shared/office-model.js';

test('the demo re-derives statuses on the clock, so labels follow the poses (#16)', () => {
  const held = demoSnapshot();
  const now = Date.now();
  const office = (s: { sessions: { id: string; zone?: string; status: string }[] }) =>
    s.sessions.filter((x) => x.zone === 'office').map((x) => [x.id, x.status]);
  // Just opened: the office shows what was observed.
  assert.deepEqual(office(deriveDemo(held, now)), office(held));
  // Three minutes on, quiet work and thought stand by — label and pose agree.
  const later = now + 3 * 60_000;
  const shown = deriveDemo(held, later);
  const worker = shown.sessions.find((s) => s.id === 'demo:0')!;
  assert.equal(worker.status, 'ready');
  assert.equal(worker.statusEvidence, 'derived');
  assert.equal(presentSession(worker, later).posture, 'standby');
  assert.equal(shown.sessions.find((s) => s.id === 'demo:1')!.status, 'ready');
  // A call stays a call; the held demo keeps what was observed.
  assert.equal(shown.sessions.find((s) => s.id === 'demo:3')!.status, 'call');
  assert.equal(held.sessions[0].status, 'work');
  // Past the standing-by window they rest, like a live office.
  const resting = deriveDemo(held, now + 40 * 60_000).sessions[0];
  assert.equal(resting.status, 'idle');
  // The model built from it counts them where their label says.
  const model = buildOfficeModel(shown, later);
  assert.equal(model.view('demo:0')?.session.status, 'ready');
  assert.equal(model.counts.working, 0);
});
