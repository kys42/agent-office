import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';
import { RecordWindowCache } from '../server/adapters/record-window.js';
import { codexMetadata, resetCodexMetadataCache } from '../server/adapters/codex.js';
import {
  claudeMetadata,
  claudeSubagentMetadata,
  resetClaudeMetadataCache,
} from '../server/adapters/claude.js';
import type { Snapshot } from '../src/shared/types.js';

const reply = (id: string, msg: string, at: number, text: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: id,
    timestamp: new Date(at).toISOString(),
    message: {
      id: msg,
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  }) + '\n';

test('A Claude transcript that grows is collected by reading only its appended lines', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-incremental-'));
  const project = path.join(temp, 'claude', 'projects', 'demo');
  await mkdir(project, { recursive: true });
  const id = 'cccc3333-0000-0000-0000-000000000003';
  const file = path.join(project, `${id}.jsonl`);
  const other = path.join(project, 'dddd4444-0000-0000-0000-000000000004.jsonl');
  const at = Date.now() - 120_000;
  await writeFile(
    file,
    JSON.stringify({
      type: 'user',
      sessionId: id,
      timestamp: new Date(at).toISOString(),
      cwd: '/tmp/demo',
      message: { role: 'user', content: '작업해 줘' },
    }) +
      '\n' +
      reply(id, 'm-1', at + 1000, '첫 번째 답장'),
  );
  await writeFile(other, reply('dddd4444-0000-0000-0000-000000000004', 'm-x', at, '다른 대화'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  const modes: string[] = [];
  const read = service.windows.read.bind(service.windows);
  service.windows.read = async (f) => {
    const r = await read(f);
    modes.push(r.mode);
    return r;
  };
  const session = (s: Snapshot) => s.sessions.find((x) => x.nativeId === id)!;
  try {
    const first = session(await service.refresh());
    assert.ok(JSON.stringify(first).includes('첫 번째 답장'));
    assert.deepEqual(modes, ['full', 'full']);

    await appendFile(file, reply(id, 'm-2', at + 60_000, '새로 덧붙인 답장'));
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    const second = session(await service.refresh());
    assert.ok(JSON.stringify(second).includes('새로 덧붙인 답장'));
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(modes, ['full', 'full', 'append']);

    // Nothing changed on disk: the parse cache answers and the revision stays put.
    const third = session(await service.refresh());
    assert.equal(third.revision, second.revision);
    assert.equal(modes.length, 3);

    // A transcript that disappears from discovery leaves both read caches.
    await unlink(other);
    await service.refresh();
    assert.equal(service.cache.has(other), false);
    assert.equal(service.windows.has(other), false);
    assert.equal(service.cache.has(file), true);
    assert.equal(service.windows.has(file), true);

    // Turning the provider off releases its cached windows.
    service.store.preferences({ enabledProviders: ['codex'] });
    await service.refresh();
    assert.equal(service.cache.size, 0);
    assert.equal(service.windows.size, 0);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('A quiet transcript rewritten in place after appends is re-verified on schedule', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-reverify-'));
  const project = path.join(temp, 'claude', 'projects', 'demo');
  await mkdir(project, { recursive: true });
  const id = 'ffff6666-0000-0000-0000-000000000006';
  const file = path.join(project, `${id}.jsonl`);
  const at = Date.now() - 120_000;
  await writeFile(file, reply(id, 'm-1', at, '처음 답장입니다'));
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.claude = path.join(temp, 'claude', 'projects');
  service.store.preferences({ enabledProviders: ['claude'] });
  let now = Date.now();
  service.windows = new RecordWindowCache({ now: () => now });
  const session = (s: Snapshot) => s.sessions.find((x) => x.nativeId === id)!;
  try {
    await service.refresh();
    await appendFile(file, reply(id, 'm-2', at + 1000, '덧붙인 답장'));
    const mtime = new Date(Date.now() + 1000);
    await utimes(file, mtime, mtime);
    const appended = session(await service.refresh());
    assert.ok(JSON.stringify(appended).includes('덧붙인 답장'));

    // Same-size rewrite of the first line, mtime put back: the stamp still matches.
    const text = await readFile(file, 'utf8');
    const fh = await open(file, 'r+');
    await fh.write(
      Buffer.from('바뀐'),
      0,
      6,
      Buffer.byteLength(text.slice(0, text.indexOf('처음'))),
    );
    await fh.close();
    await utimes(file, mtime, mtime);
    assert.equal(session(await service.refresh()).revision, appended.revision);

    now += 11 * 60_000;
    const verified = session(await service.refresh());
    assert.ok(JSON.stringify(verified).includes('바뀐 답장입니다'));
    assert.notEqual(verified.revision, appended.revision);
    // The verified window is trusted again: no further re-reads or revision changes.
    now += 11 * 60_000;
    assert.equal(session(await service.refresh()).revision, verified.revision);
  } finally {
    service.stop();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Codex metadata is reused until the index or threads DB changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-codex-meta-'));
  resetCodexMetadataCache();
  try {
    const index = path.join(dir, 'session_index.jsonl');
    await writeFile(index, JSON.stringify({ id: 'one', thread_name: 'First' }) + '\n');
    const first = await codexMetadata(dir);
    assert.equal(first.get('one')?.title, 'First');
    assert.equal(await codexMetadata(dir), first);

    await writeFile(index, JSON.stringify({ id: 'one', thread_name: 'Renamed' }) + '\n');
    await utimes(index, new Date(), new Date(Date.now() + 2000));
    const renamed = await codexMetadata(dir);
    assert.notEqual(renamed, first);
    assert.equal(renamed.get('one')?.title, 'Renamed');

    // An index that exists but cannot be read is retried, not remembered as empty.
    resetCodexMetadataCache();
    await chmod(index, 0o000);
    assert.equal((await codexMetadata(dir)).get('one'), undefined);
    await chmod(index, 0o644);
    assert.equal((await codexMetadata(dir)).get('one')?.title, 'Renamed');

    const db = new DatabaseSync(path.join(dir, 'state_2.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,title TEXT,name TEXT,cwd TEXT,updated_at INTEGER)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('two', 't', 'From DB', '/w', 1);
    db.close();
    const withDb = await codexMetadata(dir);
    assert.equal(withDb.get('two')?.cwd, '/w');
    assert.equal(await codexMetadata(dir), withDb);
  } finally {
    resetCodexMetadataCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Claude indexes and subagent sidecars are re-read only when they change', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-claude-meta-'));
  resetClaudeMetadataCache();
  try {
    await mkdir(path.join(dir, 'a'));
    await mkdir(path.join(dir, 'b'));
    const index = path.join(dir, 'a', 'sessions-index.json');
    const write = (title: string) =>
      writeFile(index, JSON.stringify({ entries: [{ sessionId: 'one', customTitle: title }] }));
    await write('Custom');
    const first = await claudeMetadata(dir);
    assert.equal(first.get('one')?.title, 'Custom');
    assert.equal(await claudeMetadata(dir), first);
    await write('Changed name');
    await utimes(index, new Date(), new Date(Date.now() + 2000));
    assert.equal((await claudeMetadata(dir)).get('one')?.title, 'Changed name');
    // A new project index is picked up from the directory listing.
    await writeFile(
      path.join(dir, 'b', 'sessions-index.json'),
      JSON.stringify({ entries: [{ sessionId: 'two', summary: 'Second' }] }),
    );
    assert.equal((await claudeMetadata(dir)).get('two')?.title, 'Second');

    const sub = path.join(dir, 'a', 'eeee5555-0000-0000-0000-000000000005', 'subagents');
    await mkdir(sub, { recursive: true });
    const source = path.join(sub, 'agent-abc.jsonl');
    const sidecar = source.replace(/\.jsonl$/, '.meta.json');
    assert.equal(await claudeSubagentMetadata(source), null);
    await writeFile(sidecar, JSON.stringify({ description: '조사', agentType: 'explorer' }));
    const meta = await claudeSubagentMetadata(source);
    assert.deepEqual(meta, { title: '조사', role: 'explorer' });
    assert.equal(await claudeSubagentMetadata(source), meta);
    await writeFile(sidecar, JSON.stringify({ description: '검토 작업', agentType: 'reviewer' }));
    await utimes(sidecar, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(await claudeSubagentMetadata(source), {
      title: '검토 작업',
      role: 'reviewer',
    });
    // A sidecar that exists but fails to read is not remembered as absent.
    await writeFile(sidecar, JSON.stringify({ description: '다른 작업', agentType: 'worker' }));
    await chmod(sidecar, 0o000);
    assert.equal(await claudeSubagentMetadata(source), null);
    await chmod(sidecar, 0o644);
    assert.deepEqual(await claudeSubagentMetadata(source), { title: '다른 작업', role: 'worker' });
  } finally {
    resetClaudeMetadataCache();
    await rm(dir, { recursive: true, force: true });
  }
});
