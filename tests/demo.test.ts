import test from 'node:test';
import assert from 'node:assert/strict';
import { demoDeriver, demoSnapshot, deriveDemo } from '../src/lib/demo.js';
import { presentSession } from '../src/shared/presentation.js';
import { buildOfficeModel } from '../src/shared/office-model.js';

test('the demo re-derives statuses on the clock, so labels follow the poses (#16)', () => {
  const held = demoSnapshot();
  const now = Date.now();
  const office = (s: { sessions: { id: string; zone?: string; status: string }[] }) =>
    s.sessions.filter((x) => x.zone === 'office').map((x) => [x.id, x.status]);
  // Just opened: the office shows what was observed, as the very same objects.
  const opened = deriveDemo(held, now);
  assert.deepEqual(office(opened), office(held));
  assert.equal(opened.sessions[0], held.sessions[0]);
  // Like a live office, the archived sample counts as gone home (it was 'resting').
  const stored = opened.sessions.find((s) => s.id === 'demo:7')!;
  assert.equal(stored.status, 'sleep');
  assert.equal(stored.zone, 'archive');
  // Three minutes on, quiet work and thought stand by — label and pose agree.
  const later = now + 3 * 60_000;
  const shown = deriveDemo(held, later);
  const worker = shown.sessions.find((s) => s.id === 'demo:0')!;
  assert.equal(worker.status, 'ready');
  assert.equal(worker.observedStatus, 'work');
  assert.equal(worker.statusEvidence, 'derived');
  assert.equal(presentSession(worker, later).posture, 'standby');
  assert.equal(shown.sessions.find((s) => s.id === 'demo:1')!.status, 'ready');
  // A call stays a call; the held demo keeps what was observed.
  assert.equal(shown.sessions.find((s) => s.id === 'demo:3')!.status, 'call');
  assert.equal(held.sessions[0].status, 'work');
  // Past the standing-by window they rest, like a live office.
  assert.equal(deriveDemo(held, now + 40 * 60_000).sessions[0].status, 'idle');
  // The model built from it counts them where their label says.
  const model = buildOfficeModel(shown, later);
  assert.equal(model.view('demo:0')?.session.status, 'ready');
  assert.equal(model.counts.working, 0);
  // Hours later they go home and leave the office, as the service would place them.
  const gone = deriveDemo(held, now + 5 * 3600_000).sessions.find((s) => s.id === 'demo:3')!;
  assert.deepEqual([gone.status, gone.zone], ['sleep', 'waiting']);
  // Archiving a sample stores it.
  const archived = deriveDemo(
    { ...held, sessions: held.sessions.map((s) => ({ ...s, archived: true })) },
    now,
  );
  assert.equal(archived.sessions[0].status, 'leave');
});

test('on the clock the derived demo keeps its identity while nothing changes', () => {
  const held = demoSnapshot();
  const now = Date.now();
  const derive = demoDeriver();
  const first = derive(held, now);
  assert.equal(derive(held, now + 15_000), first, 'a quiet tick is the same snapshot');
  const standing = derive(held, now + 3 * 60_000);
  assert.notEqual(standing, first);
  assert.equal(derive(held, now + 3 * 60_000 + 15_000), standing);
  // An edit to the held demo is a new snapshot; unchanged sessions keep their objects.
  const edited = { ...held, sessions: [...held.sessions] };
  const next = derive(edited, now + 3 * 60_000 + 30_000);
  assert.notEqual(next, standing);
  assert.equal(next.sessions[0], standing.sessions[0]);
});
