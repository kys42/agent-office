import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../server/store.js';
import { parseRecords } from '../server/adapters/normalize.js';
async function fixture(fn: (s: OfficeStore) => void | Promise<void>) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'office-store-'));
  const s = new OfficeStore(d);
  try {
    await fn(s);
  } finally {
    s.close();
    await rm(d, { recursive: true });
  }
}
function session(id = 'one', project = 'project') {
  return parseRecords(
    [
      { type: 'session_meta', payload: { id, cwd: '/test/' + project } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '로그인 재시도 결정: 캐시를 5분으로 설정합니다.' }],
        },
      },
    ],
    { provider: 'codex', sourcePath: '/test/' + id + '.jsonl', mtime: Date.now() },
  );
}
test('Imports are idempotent; personal metadata survives source updates', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    s.patch(a.id, { alias: '네모', notes: '후속 테스트', pinned: true });
    s.upsert([a], 'codex');
    assert.equal(s.list().length, 1);
    assert.equal(s.get(a.id).alias, '네모');
    assert.equal(s.get(a.id).notes, '후속 테스트');
    assert.equal(s.get(a.id).pinned, true);
  }));
test('Search supports Korean substrings, punctuation, user notes and provider scope', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    assert.equal(s.search('재시도').length, 1);
    assert.equal(s.search('재시도', 'claude').length, 0);
    s.patch(a.id, { notes: '다음에는 모서리 확인' });
    assert.equal(s.search('모서리').length, 1);
    assert.deepEqual(s.search('" OR *'), []);
  }));
test('Excluded projects disappear from list, search, detail and handoff', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    s.preferences({ excludedProjects: ['project'] });
    assert.equal(s.list().length, 0);
    assert.equal(s.search('로그인').length, 0);
    assert.throws(() => s.get(a.id));
    assert.throws(() => s.handoff(a.id, a.revision));
  }));
test('Disabled providers are excluded in every query surface', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    s.preferences({ enabledProviders: ['claude'] });
    assert.equal(s.list().length, 0);
    assert.throws(() => s.get(a.id));
  }));
test('Stale handoff revisions are rejected and output states evidence limitations', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    assert.throws(() => s.handoff(a.id, 'old'), /변경/);
    const packet = s.handoff(a.id, a.revision);
    assert.ok(packet.markdown.includes('자동 검증 또는 AI 요약이 아닙니다'));
    assert.ok(packet.markdown.includes('로그인'));
  }));
test('Source disappearance removes search content without changing other providers', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    s.upsert([], 'codex');
    assert.equal(s.list().length, 0);
    assert.equal(s.search('로그인').length, 0);
  }));
test('Archiving preserves history; explicit completion is independent from mood', () =>
  fixture((s) => {
    const a = session();
    s.upsert([a], 'codex');
    s.patch(a.id, { archived: true, completed: true });
    const b = s.get(a.id);
    assert.equal(b.status, 'leave');
    assert.equal(b.completed, true);
    assert.equal(s.search('로그인').length, 1);
    s.patch(a.id, { archived: false });
    assert.equal(s.get(a.id).archived, false);
  }));
test('Hiding is stamped by the service, kept with personal metadata and all-or-nothing', () =>
  fixture((s) => {
    const a = session('a');
    const b = session('b');
    s.upsert([a, b], 'codex');
    s.patch(a.id, { alias: '네모' });
    s.veil([a.id, b.id], true, 1234);
    assert.equal(s.get(a.id).hiddenAt, 1234);
    assert.equal(s.get(a.id).alias, '네모', 'other personal fields survive');
    s.upsert([a, b], 'codex');
    assert.equal(s.get(a.id).hiddenAt, 1234, 'survives source updates');
    assert.throws(() => s.veil([b.id, 'codex:missing'], false));
    assert.equal(s.get(b.id).hiddenAt, 1234, 'a failed batch changes nothing');
    s.veil([a.id, b.id], false);
    assert.equal(s.get(a.id).hiddenAt, null);
    assert.equal(s.get(b.id).hiddenAt, null);
  }));
