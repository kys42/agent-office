import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moveDesk } from '../src/shared/desk-order.js';
import { reorderSeatMap, seatKey } from '../src/shared/office.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { OfficeStore } from '../server/store.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { Session } from '../src/shared/types.js';

test('reorderSeatMap reuses the keys’ own tokens in the new order and leaves the rest alone', () => {
  const seats = { a: 3, b: 7, c: 1, d: 9, other: 4 };
  assert.deepEqual(reorderSeatMap(seats, ['d', 'a', 'b']), { a: 7, b: 9, c: 1, d: 3, other: 4 });
  // Unknown keys are skipped and repeats count once; the input is not changed.
  assert.deepEqual(reorderSeatMap(seats, ['b', 'ghost', 'a', 'b']), { ...seats, a: 7, b: 3 });
  assert.deepEqual(seats, { a: 3, b: 7, c: 1, d: 9, other: 4 });
  assert.deepEqual(reorderSeatMap(seats, []), seats);
});

const zone = [
  { id: 'a', bench: 'x' },
  { id: 'b', bench: 'y' },
  { id: 'c', bench: 'y' },
  { id: 'd', bench: 'z' },
];
test('moveDesk puts a desk before or after another', () => {
  assert.deepEqual(moveDesk(zone, 'd', 'a', 'before'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveDesk(zone, 'a', 'd', 'after'), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveDesk(zone, 'a', 'd', 'before'), ['b', 'c', 'a', 'd']);
});
test('moveDesk moves a shared bench as one block and lands beside a whole bench', () => {
  assert.deepEqual(moveDesk(zone, 'c', 'a', 'before'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveDesk(zone, 'b', 'd', 'after'), ['a', 'd', 'b', 'c']);
  // Dropping on the first half of a bench member still goes after the whole bench.
  assert.deepEqual(moveDesk(zone, 'a', 'b', 'after'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveDesk(zone, 'd', 'c', 'before'), ['a', 'd', 'b', 'c']);
});
test('moveDesk keeps the order for a drop on itself, its own bench or an unknown desk', () => {
  const ids = zone.map((s) => s.id);
  assert.deepEqual(moveDesk(zone, 'a', 'a', 'after'), ids);
  assert.deepEqual(moveDesk(zone, 'b', 'c', 'after'), ids);
  assert.deepEqual(moveDesk(zone, 'a', 'ghost', 'before'), ids);
  assert.deepEqual(moveDesk(zone, 'ghost', 'a', 'before'), ids);
});

const now = Date.now();
function codex(id: string, project: string, meta: Record<string, unknown> = {}) {
  return parseRecords(
    [
      {
        type: 'session_meta',
        timestamp: new Date(now).toISOString(),
        payload: { id, cwd: '/tmp/' + project, git: { branch: id }, ...meta },
      },
      {
        type: 'event_msg',
        timestamp: new Date(now).toISOString(),
        payload: { type: 'task_complete' },
      },
    ],
    { provider: 'codex', sourcePath: `/tmp/${id}.jsonl`, mtime: now, now },
  );
}
const persona = (id: string): Session => ({
  ...demoSnapshot().sessions[0],
  id,
  nativeId: id,
  provider: 'openclaw',
  agentName: 'aki',
  actor: { id: 'openclaw:aki', name: 'aki', source: 'fixture' },
  status: 'idle',
  updatedAt: now,
  startedAt: now - 5000,
  events: [],
  archived: false,
  pinned: false,
  relation: { kind: 'root', parentNativeId: null, source: 'fixture' },
});

test('reorderSeats keeps the dragged order for every view, other zones and helpers untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-reorder-'));
  const store = new OfficeStore(dir);
  try {
    const a = codex('a', 'one'),
      b = codex('b', 'one'),
      c = codex('c', 'two'),
      helper = codex('h', 'one', { thread_source: 'subagent', parent_thread_id: 'a' });
    store.upsert([a, b, c, helper], 'codex');
    const runs = [persona('run-1'), persona('run-2')];
    store.upsert(runs, 'openclaw');
    store.assignSeats();
    const seat = () => new Map(store.list().map((s) => [seatKey(s), s.officeSeat]));
    const before = seat();
    assert.equal(
      store.list().find((s) => s.id === helper.id)?.attachedTo,
      a.id,
      'the helper sits at its colleague’s desk',
    );
    const resident = store.officeView().sessions.find((s) => s.actor)!;
    const zone = [a.id, b.id];
    const ordered = (ids: string[]) => ids.map((id) => before.get(id)!).sort((x, y) => x - y);
    // The resident speaks through one of its runs; a helper and unknown ids carry no desk.
    store.reorderSeats([b.id, helper.id, 'codex:ghost', a.id]);
    let after = seat();
    assert.deepEqual([after.get(b.id), after.get(a.id)], ordered(zone));
    assert.equal(after.get(c.id), before.get(c.id), 'another zone keeps its token');
    assert.equal(after.get('actor:openclaw:aki'), before.get('actor:openclaw:aki'));
    assert.equal(
      store.list().find((s) => s.id === helper.id)?.officeSeat,
      after.get(a.id),
      'the helper still follows its colleague',
    );
    // A resident's desk moves by whichever run speaks for it.
    const tokens = [after.get(a.id)!, after.get('actor:openclaw:aki')!].sort((x, y) => x - y);
    store.reorderSeats([resident.id, a.id]);
    after = seat();
    assert.deepEqual([after.get('actor:openclaw:aki'), after.get(a.id)], tokens);
    // The next pass keeps the order.
    store.assignSeats();
    assert.deepEqual(seat(), after);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
