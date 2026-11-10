import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRecords } from '../server/adapters/normalize.js';
import { mergeOutputs } from '../server/adapters/outputs.js';
import { OfficeStore } from '../server/store.js';
import { CHIPS_AT_END, placeOutputChips } from '../src/shared/outputs.js';
import type { OfficeEvent, OutputCandidate, Session } from '../src/shared/types.js';

// #358: outputs know the conversation event that produced them, and the chat places their chips
// under the visible message nearest to it.

const now = Date.parse('2026-11-10T00:00:00Z');
const at = (offset: number) => new Date(now + offset).toISOString();
const cwd = '/work/app';
let uuid = 0;
function claude(role: 'assistant' | 'user', content: unknown[], offset: number, extra = {}) {
  return {
    type: role,
    uuid: `u${++uuid}`,
    timestamp: at(offset),
    sessionId: 'claude-one',
    cwd,
    message: { role, content },
    ...extra,
  };
}
const claudeOpts = {
  provider: 'claude' as const,
  sourcePath: '/claude/projects/app/claude-one.jsonl',
  mtime: now,
  now: now + 60_000,
};
const codex = (type: string, payload: any, offset: number) => ({
  type,
  payload,
  timestamp: at(offset),
});

test('Each output keeps the id of the event that produced it', () => {
  const s = parseRecords(
    [
      claude('user', [{ type: 'text', text: '보고서 써 줘' }], 0),
      claude(
        'assistant',
        [
          {
            type: 'tool_use',
            id: 'w1',
            name: 'Write',
            input: { file_path: '/work/app/docs/report.md', content: '# r' },
          },
        ],
        1,
      ),
      claude(
        'user',
        [
          {
            type: 'tool_result',
            tool_use_id: 'w1',
            content: 'File created successfully at: /work/app/docs/report.md',
          },
        ],
        2,
      ),
      claude(
        'assistant',
        [
          {
            type: 'text',
            text: '[시안](https://claude.ai/code/artifact/0f6c1e2a-1111-4222-8333-944455556666) 만들었어요',
          },
        ],
        3,
        {},
      ),
    ],
    claudeOpts,
  );
  const byKey = new Map((s.outputs ?? []).map((o) => [o.key, o]));
  const report = byKey.get('/work/app/docs/report.md')!;
  const result = s.events.find((e) => e.kind === 'result')!;
  assert.equal(report.eventId, result.id);
  assert.equal(report.at, result.at);
  const link = byKey.get('https://claude.ai/code/artifact/0f6c1e2a-1111-4222-8333-944455556666')!;
  const reply = s.events.filter((e) => e.kind === 'assistant').at(-1)!;
  assert.equal(link.eventId, reply.id);
});

test('Codex: a patch reported before its result still points at the call result', () => {
  const s = parseRecords(
    [
      codex('session_meta', { id: 'codex-one', cwd }, 0),
      codex(
        'response_item',
        {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'p1',
          input: '*** Begin Patch\n*** Add File: docs/plan.md\n+# Plan\n*** End Patch',
        },
        1,
      ),
      // The event arrives first and names no conversation event.
      codex(
        'event_msg',
        {
          type: 'patch_apply_end',
          call_id: 'p1',
          success: true,
          changes: { '/work/app/docs/plan.md': { type: 'add', content: '# Plan' } },
        },
        2,
      ),
      codex(
        'response_item',
        {
          type: 'custom_tool_call_output',
          call_id: 'p1',
          output: 'Success. Updated the following files:\nA docs/plan.md\n',
        },
        3,
      ),
    ],
    { provider: 'codex' as const, sourcePath: '/codex/rollout.jsonl', mtime: now, now },
  );
  const [plan] = s.outputs ?? [];
  assert.equal(plan.key, '/work/app/docs/plan.md');
  const result = s.events.find((e) => e.kind === 'result')!;
  assert.equal(plan.eventId, result.id);
});

test('Merged fragments fill in the event a first telling lacked', () => {
  const bare: OutputCandidate = { key: '/a.md', kind: 'file', at: now, via: 'write' };
  const placed: OutputCandidate = { ...bare, at: now + 5, eventId: 'e1' };
  assert.equal(mergeOutputs([[bare], [placed]])[0].eventId, 'e1');
  assert.equal(mergeOutputs([[placed], [bare]])[0].eventId, 'e1');
});

async function withStore(fn: (s: OfficeStore) => void) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-chips-'));
  const store = new OfficeStore(path.join(dir, 'data'));
  try {
    fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function made(outputs: OutputCandidate[], tag: string): Session {
  const s = parseRecords(
    [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'one', cwd: '/work/app' } },
      codex(
        'response_item',
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make it' }] },
        1,
      ),
    ],
    { provider: 'codex' as const, sourcePath: '/codex/one.jsonl', mtime: now, now },
  );
  return { ...s, startedAt: now, outputs, revision: `${s.revision}:${tag}` };
}

test('The store keeps where each output came from and fills it in for older rows', () =>
  withStore((s) => {
    // A row from before #358: no event.
    s.upsert(
      [made([{ key: '/work/app/old.md', kind: 'file', at: now + 10, via: 'write' }], 'a')],
      'codex',
    );
    let [old] = s.outputs().outputs;
    assert.equal(old.eventId, undefined);
    assert.equal(old.eventAt, now + 10);
    const stamp = s.outputStamp();
    s.upsert(
      [
        made(
          [
            { key: '/work/app/old.md', kind: 'file', at: now + 10, via: 'write', eventId: 'r1' },
            { key: '/work/app/new.md', kind: 'file', at: now + 20, via: 'write', eventId: 'r2' },
          ],
          'b',
        ),
      ],
      'codex',
    );
    const shown = new Map(s.outputs().outputs.map((o) => [o.name, o]));
    assert.equal(shown.get('old.md')!.eventId, 'r1');
    assert.equal(shown.get('new.md')!.eventId, 'r2');
    assert.equal(shown.get('new.md')!.eventAt, now + 20);
    assert.notEqual(s.outputStamp(), stamp);
    // Told again, nothing changes.
    const again = s.outputStamp();
    s.upsert(
      [
        made(
          [{ key: '/work/app/old.md', kind: 'file', at: now + 10, via: 'write', eventId: 'x' }],
          'c',
        ),
      ],
      'codex',
    );
    [old] = s.outputs().outputs.filter((o) => o.name === 'old.md');
    assert.equal(old.eventId, 'r1');
    assert.equal(s.outputStamp(), again);
  }));

// --- Placement -------------------------------------------------------------------------------

type Ev = Pick<OfficeEvent, 'id' | 'kind' | 'at'> & { phase?: OfficeEvent['phase'] };
const ev = (
  id: string,
  kind: OfficeEvent['kind'],
  t: number,
  phase?: OfficeEvent['phase'],
): Ev => ({
  id,
  kind,
  at: t,
  ...(phase ? { phase } : {}),
});
/** A turn: request, a progress note, a tool call and its result, then the final reply. */
const turn = (n: number, base: number): Ev[] => [
  ev(`u${n}`, 'user', base),
  ev(`p${n}`, 'assistant', base + 1, 'commentary'),
  ev(`t${n}`, 'tool', base + 2),
  ev(`r${n}`, 'result', base + 3),
  ev(`f${n}`, 'assistant', base + 4, 'final'),
];
/** What the chat shows: work only with tools on, progress unless left out. */
const shownOf = (events: Ev[], { tools = false, progress = true } = {}) =>
  events
    .filter((e) =>
      e.kind === 'tool' || e.kind === 'result'
        ? tools
        : e.kind === 'assistant' && e.phase === 'commentary'
          ? progress
          : true,
    )
    .map((e) => ({ id: e.id, events: [{ id: e.id }] }));
const out = (id: string, eventId: string | undefined, t: number) => ({
  id,
  createdAt: t,
  eventAt: t,
  ...(eventId ? { eventId } : {}),
});
const ids = (m: Map<string, { id: string }[]>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.map((o) => o.id)]));

test('A chip sits under the event that made it when that event is shown', () => {
  const events = [...turn(1, 0)];
  const placed = placeOutputChips(events, shownOf(events, { tools: true }), [out('a', 'r1', 3)]);
  assert.deepEqual(ids(placed), { r1: ['a'] });
});

test('A hidden tool result puts its chips under the next visible reply of the turn', () => {
  const events = [...turn(1, 0), ...turn(2, 100)];
  // Work folded away: under the progress note? No, the next reply after the result.
  assert.deepEqual(
    ids(placeOutputChips(events, shownOf(events), [out('a', 'r1', 3), out('b', 'r2', 103)])),
    { f1: ['a'], f2: ['b'] },
  );
  // Progress left out too: still the final reply.
  assert.deepEqual(
    ids(placeOutputChips(events, shownOf(events, { progress: false }), [out('a', 'r1', 3)])),
    { f1: ['a'] },
  );
  // A mention in a hidden progress note: the turn's final reply.
  assert.deepEqual(
    ids(placeOutputChips(events, shownOf(events, { progress: false }), [out('m', 'p2', 101)])),
    { f2: ['m'] },
  );
});

test('Several outputs of one turn share one row, in the order they came', () => {
  const events = [...turn(1, 0)];
  events.splice(4, 0, ev('t1b', 'tool', 3.5), ev('r1b', 'result', 3.6));
  const placed = placeOutputChips(events, shownOf(events), [
    out('second', 'r1b', 3.6),
    out('first', 'r1', 3),
    out('said', 'f1', 4),
    out('first', 'r1', 3),
  ]);
  assert.deepEqual(ids(placed), { f1: ['first', 'second', 'said'] });
});

test('An output whose event is not loaded is placed by its time', () => {
  const events = [...turn(1, 0), ...turn(2, 100)];
  const placed = placeOutputChips(events, shownOf(events), [
    // Unknown event (an older row, or a result with no text): by time, after the tool ran.
    out('legacy', undefined, 3.2),
    out('gone', 'not-here', 102.5),
  ]);
  assert.deepEqual(ids(placed), { f1: ['legacy'], f2: ['gone'] });
});

test('Times on pages not read yet wait for them; within the range they are placed', () => {
  const events = [...turn(2, 100)];
  const shown = shownOf(events);
  const list = [out('before', undefined, 50), out('after', undefined, 500)];
  assert.deepEqual(ids(placeOutputChips(events, shown, list, { older: true, newer: true })), {});
  // Nothing older to read: the first message shown carries it; the newest turn's reply the other.
  assert.deepEqual(ids(placeOutputChips(events, shown, list)), {
    u2: ['before'],
    f2: ['after'],
  });
});

test('The running turn with no visible reply yet keeps its chips at the end', () => {
  const events = [
    ...turn(1, 0),
    ev('u2', 'user', 100),
    ev('t2', 'tool', 101),
    ev('r2', 'result', 102),
  ];
  const placed = placeOutputChips(events, shownOf(events), [out('a', 'r2', 102)]);
  assert.deepEqual(ids(placed), { [CHIPS_AT_END]: ['a'] });
  // Its reply on a newer page not read: under the nearest message shown before it.
  assert.deepEqual(
    ids(placeOutputChips(events, shownOf(events), [out('a', 'r2', 102)], { newer: true })),
    {
      u2: ['a'],
    },
  );
});

test('A turn that ended without a visible reply keeps its chips under the message before', () => {
  const events = [
    ev('u1', 'user', 0),
    ev('t1', 'tool', 1),
    ev('r1', 'result', 2),
    ev('x1', 'lifecycle', 3),
    ...turn(2, 100),
  ];
  assert.deepEqual(ids(placeOutputChips(events, shownOf(events), [out('a', 'r1', 2)])), {
    u1: ['a'],
  });
});

test('A work group shown with the tools carries its chips; legacy ids are found', () => {
  const events: (Ev & { legacyId?: string })[] = [...turn(1, 0)];
  events[3] = { ...events[3], legacyId: 'old-r1' };
  // One group for the tool and its result.
  const groups = [
    { id: 'u1', events: [{ id: 'u1' }] },
    { id: 'p1', events: [{ id: 'p1' }] },
    { id: 't1', events: [{ id: 't1' }, { id: 'r1' }] },
    { id: 'f1', events: [{ id: 'f1' }] },
  ];
  assert.deepEqual(ids(placeOutputChips(events, groups, [out('a', 'old-r1', 3)])), { t1: ['a'] });
  assert.equal(placeOutputChips([], groups, [out('a', 'r1', 3)]).size, 0);
});
