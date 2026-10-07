import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveState } from '../src/shared/runtime.js';
import { isStandingBy, presentSession } from '../src/shared/presentation.js';
import { triageGroup } from '../src/shared/triage.js';
import { officeSchedule, validOfficeSchedule } from '../src/shared/lifecycle.js';
import { MOODS, type Session } from '../src/shared/types.js';
import { demoSnapshot } from '../src/lib/demo.js';
import { OfficeService } from '../server/service.js';
import { OfficeStore } from '../server/store.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { setLocale } from '../src/shared/i18n/index.js';
// These tests assert the original Korean copy: pin the language so results never depend on the
// machine (services resolve `auto` through AGENT_OFFICE_LOCALE first).
process.env.AGENT_OFFICE_LOCALE = 'ko';
setLocale('ko');
const now = Date.now();
const min = 60_000;
const hour = 3600_000;
const make = (patch: Partial<Session> = {}): Session => ({
  ...demoSnapshot().sessions[0],
  id: 'x',
  status: 'idle',
  updatedAt: now,
  archived: false,
  resident: undefined,
  runtime: undefined,
  ...patch,
});

test('the status ladder: live → standing by (30 min) → resting → gone home', () => {
  const at = (status: Session['status'], age: number, ...rest: [boolean?, number?, number?]) =>
    deriveState(status, now - age, now, ...rest).status;
  assert.equal(at('work', 1 * min), 'work');
  assert.equal(at('think', 1 * min), 'think');
  assert.equal(at('done', 1 * min), 'done');
  for (const s of ['work', 'think', 'done'] as const) {
    assert.equal(at(s, 5 * min), 'ready', `${s} just finished stands by`);
    assert.equal(at(s, 29 * min), 'ready');
    assert.equal(at(s, 31 * min), 'idle', `${s} rests after the standing-by window`);
  }
  assert.equal(at('work', 4 * hour), 'sleep', 'gone home after the standby hours');
  assert.equal(at('work', 2 * hour, false, 1), 'sleep', 'custom standby hours');
  assert.equal(at('work', 10 * min, false, 4, 5), 'idle', 'a 5-minute window');
  assert.equal(at('work', 45 * min, false, 4, 60), 'ready', 'a 60-minute window');
  // Calls and errors never fall to standing by or resting…
  assert.equal(at('call', 1 * hour), 'call');
  assert.equal(at('error', 1 * hour), 'error');
  // …but, like everyone, they go home once the standby hours pass (existing behaviour).
  assert.equal(at('call', 5 * hour), 'sleep');
  assert.equal(at('work', 5 * min, true), 'leave', 'archived wins');
  assert.equal(MOODS.ready.label, '대기 중');
  assert.equal(MOODS.sleep.label, '퇴근');
});

test('standing by is upright at the desk and its own to-do group', () => {
  const ready = make({ status: 'ready', updatedAt: now - 10 * min });
  const pose = presentSession(ready, now);
  assert.equal(pose.posture, 'standby');
  assert.equal(pose.mood, 'ready');
  assert.equal(pose.working, false);
  assert.equal(triageGroup(ready, [], now), 'standby');
  // Before the service re-derives a raw status: a fresh answer, or quiet work in the window.
  assert.equal(triageGroup(make({ status: 'done', updatedAt: now - 30_000 }), [], now), 'standby');
  assert.equal(triageGroup(make({ status: 'work', updatedAt: now - 5 * min }), [], now), 'standby');
  assert.equal(
    presentSession(make({ status: 'work', updatedAt: now - 5 * min }), now).posture,
    'standby',
  );
  const old = make({ status: 'work', updatedAt: now - 40 * min });
  assert.equal(triageGroup(old, [], now), 'resting');
  // …and it looks like it: no typing once the standing-by window has passed.
  assert.ok(['resting', 'strolling', 'dozing'].includes(presentSession(old, now).posture));
  assert.notEqual(presentSession(old, now).mood, 'work');
  assert.equal(triageGroup(make({ status: 'work', updatedAt: now - 10_000 }), [], now), 'working');
  assert.equal(isStandingBy(make({ status: 'ready', archived: true }), now), false);
  // A fresh answer keeps its "result" pose for the first two minutes.
  assert.equal(
    presentSession(make({ status: 'done', updatedAt: now - 30_000 }), now).posture,
    'result',
  );
});

test('the schedule reads in order and standing by must end before going home', () => {
  assert.equal(officeSchedule({}), '30분 대기 · 4시간 후 퇴근 · 7일 후 보관');
  assert.equal(
    officeSchedule({ readyMinutes: 10, standbyHours: 24 }),
    '10분 대기 · 1일 후 퇴근 · 7일 후 보관',
  );
  assert.ok(validOfficeSchedule({ readyMinutes: 30, standbyHours: 1 }));
  assert.ok(!validOfficeSchedule({ readyMinutes: 60, standbyHours: 1 }));
});

test('the service keeps the standing-by window with the other schedule preferences', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-status-'));
  const service = new OfficeService(dir, dir);
  const store = new OfficeStore(path.join(dir, 'store'));
  try {
    assert.equal(service.store.preferences().readyMinutes, 30);
    await service.call('preferences', [{ readyMinutes: 10 }]);
    assert.equal(service.store.preferences().readyMinutes, 10);
    await assert.rejects(service.call('preferences', [{ readyMinutes: 2 }]));
    await assert.rejects(service.call('preferences', [{ readyMinutes: 300 }]));
    await assert.rejects(service.call('preferences', [{ standbyHours: 1, readyMinutes: 60 }]));
    assert.equal(service.store.preferences().readyMinutes, 10, 'a rejected change is not saved');
    // Saved preferences from before this setting existed still save other changes.
    service.store.db
      .prepare("INSERT OR REPLACE INTO settings VALUES ('preferences',?)")
      .run(JSON.stringify({ standbyHours: 1, archiveDays: 7 }));
    await service.call('preferences', [{ bubbleHours: 6 }]);
    assert.equal(service.store.preferences().bubbleHours, 6);
    assert.equal(service.store.preferences().readyMinutes, 30, 'the default fills in');
    // The stored status follows the window: a 12-minute-old finished turn.
    const s = parseRecords(
      [
        {
          type: 'session_meta',
          timestamp: new Date(now - 12 * min).toISOString(),
          payload: { id: 'one', cwd: '/tmp/status', git: { branch: 'main' } },
        },
        {
          type: 'event_msg',
          timestamp: new Date(now - 12 * min).toISOString(),
          payload: { type: 'task_complete' },
        },
      ],
      { provider: 'codex', sourcePath: '/tmp/one.jsonl', mtime: now - 12 * min, now },
    );
    store.upsert([s], 'codex');
    assert.equal(store.get('codex:one').status, 'ready');
    store.preferences({ readyMinutes: 10 });
    assert.equal(store.get('codex:one').status, 'idle');
  } finally {
    store.close();
    service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
