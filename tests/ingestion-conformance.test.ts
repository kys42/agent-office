import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { consumeCompleteJsonlLines } from '../vendor/orca/runtime/session-scanner-jsonl-reader.js';
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../vendor/orca/runtime/session-transcript-record-budget.js';
import { parseRecords } from '../server/adapters/normalize.js';
import { readRecords } from '../server/adapters/files.js';
import { mergeSessions } from '../server/adapters/merge.js';
import { claudeSubagentMetadata } from '../server/adapters/claude.js';
import { OfficeStore } from '../server/store.js';
import type { Provider } from '../src/shared/types.js';

const now = Date.now();
const root = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const rec = (type: string, payload: object, at = now) => ({
  type,
  payload,
  timestamp: new Date(at).toISOString(),
});
const opts = {
  provider: 'codex' as const,
  sourcePath: `/tmp/rollout-${other}.jsonl`,
  mtime: now,
  now,
};
async function* chunks(values: Buffer[]) {
  yield* values;
}

test('Vendored Orca sources match pinned commit checksums', async () => {
  const manifest = JSON.parse(await readFile('vendor/orca/manifest.json', 'utf8'));
  for (const file of manifest.files) {
    const bytes = await readFile(path.join('vendor/orca/upstream', path.basename(file.path)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }
});

// Adapted from Orca's reader tests (MIT): offsets must count bytes, never UTF-8 chars.
test('Orca byte reader survives every UTF-8/CRLF split and resumes only complete lines', async () => {
  const content = Buffer.from('{"a":"한글 🦀 é"}\r\n\n{"b":2}\n{"partial":');
  for (let cut = 1; cut < content.length; cut++) {
    const lines: string[] = [];
    const result = await consumeCompleteJsonlLines({
      stream: chunks([content.subarray(0, cut), content.subarray(cut)]),
      start: 41,
      onLine: (line) => lines.push(line),
    });
    assert.deepEqual(lines, ['{"a":"한글 🦀 é"}', '', '{"b":2}']);
    assert.equal(result.consumedThrough, 41 + content.length - Buffer.byteLength('{"partial":'));
    assert.equal(result.trailingPartialLine, '{"partial":');
  }
});

test('Orca reader skips only an oversized record and closes early-stopped streams', async () => {
  const oversized = Buffer.from('x'.repeat(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1));
  const lines: string[] = [];
  const result = await consumeCompleteJsonlLines({
    stream: chunks([
      Buffer.from('{"before":1}\n'),
      oversized.subarray(0, 6000),
      oversized.subarray(6000),
      Buffer.from('\n{"after":2}\n'),
    ]),
    start: 0,
    onLine: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ['{"before":1}', '{"after":2}']);
  assert.equal(result.skippedRecords.length, 1);
  let closed = false;
  async function* source() {
    try {
      yield Buffer.from('a\nb\n');
    } finally {
      closed = true;
    }
  }
  let count = 0;
  const stopped = await consumeCompleteJsonlLines({
    stream: source(),
    start: 0,
    onLine: () => count++,
    shouldStop: () => count > 0,
  });
  assert.equal(stopped.consumedThrough, 2);
  assert.equal(closed, true);
});

test('A large first metadata line keeps the native ID despite a smaller head budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-header-'));
  try {
    const file = path.join(dir, `rollout-${other}.jsonl`);
    await writeFile(
      file,
      [
        rec('session_meta', { id: root, instructions: '한글'.repeat(200_000) }),
        rec('event_msg', { type: 'user_message', message: '이어지는 요청' }),
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    const st = await stat(file);
    const read = await readRecords({ path: file, size: st.size, mtime: st.mtimeMs }, 128 * 1024);
    const session = parseRecords(read.records, {
      ...opts,
      sourcePath: file,
      partial: read.partial,
    });
    assert.equal(session.nativeId, root);
    assert.equal(session.events.at(-1)?.text, '이어지는 요청');
    assert.equal(session.identity?.evidence, 'native-header');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('File UUID cannot override first native header; forks and explicit user origins remain independent', () => {
  const first = parseRecords(
    [rec('session_meta', { id: root }), rec('session_meta', { id: other })],
    opts,
  );
  assert.equal(first.nativeId, root);
  const child = parseRecords(
    [
      rec('session_meta', {
        id: other,
        session_id: root,
        thread_source: 'user',
        forked_from_id: root,
        source: { subagent: 'review' },
      }),
    ],
    opts,
  );
  assert.equal(child.nativeId, other);
  assert.equal(child.relation?.kind, 'fork');
  assert.equal(mergeSessions([first, child]).length, 2);
  const user = parseRecords(
    [
      rec('session_meta', {
        id: root,
        thread_source: 'user',
        source: { subagent: { thread_spawn: { parent_thread_id: other } } },
      }),
    ],
    opts,
  );
  assert.equal(user.parentId, null);
  assert.equal(user.relation?.kind, 'root');
});

test('Claude nested workflow agents are parent-scoped and read adjacent sidecar metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-sidecar-'));
  try {
    const file = path.join(dir, root, 'subagents/workflows/wf_1/agent-reused.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file.replace('.jsonl', '.meta.json'),
      JSON.stringify({ agentType: 'explorer', description: '세션 조사' }),
    );
    const rows = [
      {
        type: 'user',
        sessionId: root,
        agentId: 'reused',
        parentUuid: 'message-not-session',
        message: { role: 'user', content: '조사' },
      },
    ];
    const a = parseRecords(rows, { ...opts, provider: 'claude', sourcePath: file });
    const b = parseRecords(rows, {
      ...opts,
      provider: 'claude',
      sourcePath: file.replace(root, other),
    });
    assert.equal(a.parentId, root);
    assert.equal(a.relation?.kind, 'subagent');
    assert.notEqual(a.nativeId, b.nativeId);
    assert.deepEqual(await claudeSubagentMetadata(file), { title: '세션 조사', role: 'explorer' });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Claude explicit rename outranks AI title, agent name, prompt and later generated titles', () => {
  const rows = [
    { type: 'user', sessionId: root, message: { role: 'user', content: '첫 요청' } },
    { type: 'agent-name', agentName: 'Helper' },
    { type: 'ai-title', aiTitle: '생성 제목' },
  ];
  assert.equal(parseRecords(rows, { ...opts, provider: 'claude' }).title, '생성 제목');
  assert.equal(
    parseRecords(
      [
        ...rows,
        { type: 'custom-title', customTitle: '사용자 이름' },
        { type: 'ai-title', aiTitle: '늦은 생성 제목' },
      ],
      { ...opts, provider: 'claude' },
    ).title,
    '사용자 이름',
  );
});

test('All providers merge exact native conversations, retain sources, and isolate unrelated namespaces', () => {
  for (const provider of ['claude', 'codex', 'openclaw'] as Provider[]) {
    const rows =
      provider === 'codex'
        ? [rec('session_meta', { id: root })]
        : provider === 'claude'
          ? [{ type: 'user', sessionId: root, message: { role: 'user', content: '시작' } }]
          : [{ type: 'session', id: root }];
    const a = parseRecords(rows, {
      ...opts,
      provider,
      sourcePath: '/tmp/a.jsonl',
      agentName: provider === 'openclaw' ? 'one' : undefined,
    });
    const b = parseRecords(rows, {
      ...opts,
      provider,
      sourcePath: '/tmp/b.jsonl',
      agentName: provider === 'openclaw' ? 'one' : undefined,
    });
    const merged = mergeSessions([a, b]);
    assert.equal(merged.length, 1, provider);
    assert.deepEqual(merged[0].sourcePaths, ['/tmp/a.jsonl', '/tmp/b.jsonl']);
    if (provider === 'openclaw') {
      const otherAgent = parseRecords(rows, { ...opts, provider, agentName: 'two' });
      assert.equal(mergeSessions([a, otherAgent]).length, 2);
    }
  }
});

test('Transport ordinals do not overwrite distinct messages; streaming snapshots update a native event', () => {
  const rows = [
    rec('session_meta', { id: root }),
    { ...rec('event_msg', { type: 'user_message', message: '첫 요청' }), ordinal: 7 },
  ];
  const a = parseRecords(rows, opts);
  const b = parseRecords(
    [
      rows[0],
      { ...rec('event_msg', { type: 'user_message', message: '다음 요청' }, now + 1), ordinal: 7 },
    ],
    { ...opts, sourcePath: '/tmp/new-page.jsonl' },
  );
  assert.equal(mergeSessions([a, b])[0].events.length, 2);
  assert.equal(mergeSessions([a, a])[0].events.length, 1);
  const streamed = parseRecords(
    [
      rec('response_item', {
        type: 'message',
        id: 'native',
        role: 'assistant',
        content: [{ type: 'output_text', text: '진행' }],
      }),
      rec(
        'response_item',
        {
          type: 'message',
          id: 'native',
          role: 'assistant',
          content: [{ type: 'output_text', text: '진행하고 있어요' }],
        },
        now + 1,
      ),
    ],
    opts,
  );
  assert.equal(streamed.events.length, 1);
  assert.equal(streamed.events[0].text, '진행하고 있어요');
});

test('Changing ordinal event keys preserves confirmed read/dismiss receipts without a notification replay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-receipt-migrate-'));
  const store = new OfficeStore(dir);
  try {
    const current = parseRecords(
      [
        rec('session_meta', { id: root }),
        { ...rec('event_msg', { type: 'user_message', message: '확인한 요청' }), ordinal: 7 },
      ],
      opts,
    );
    const previous = {
      ...current,
      events: current.events.map((e) => ({ ...e, id: '7', legacyId: undefined })),
      activity: undefined,
    };
    store.upsert([previous], 'codex');
    const before = store.noticeList()[0];
    store.noticeReceipt([before], 'read');
    store.noticeReceipt([before], 'dismiss');
    store.upsert([current], 'codex');
    assert.equal(store.noticeList().length, 1);
    assert.ok(store.noticeList()[0].seenAt);
    assert.ok(store.noticeList()[0].dismissedAt);
    assert.equal(store.noticeList()[0].eventId, current.events[0].id);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});
