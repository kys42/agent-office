import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover } from '../server/adapters/files.js';
import { OfficeService } from '../server/service.js';

const directoryLink = (target: string, link: string) =>
  symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('Relocated Codex months appear once and keep their identity and new activity', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-linked-'));
  const root = path.join(temp, 'codex', 'sessions');
  const external = path.join(temp, 'external', '06');
  const day = path.join(external, '16');
  await mkdir(path.join(root, '2026'), { recursive: true });
  await mkdir(day, { recursive: true });
  await directoryLink(external, path.join(root, '2026', '06'));
  await directoryLink(external, path.join(root, '2026', 'alias'));
  await directoryLink(root, path.join(day, 'cycle'));
  const id = 'aaaaaaaa-0000-0000-0000-000000000001';
  const file = path.join(day, `rollout-2026-06-16-${id}.jsonl`);
  const at = Date.now();
  const line = (record: object) => JSON.stringify(record) + '\n';
  await writeFile(
    file,
    line({ type: 'session_meta', timestamp: '2026-06-16T00:00:00Z', payload: { id, cwd: temp } }) +
      line({
        type: 'event_msg',
        timestamp: new Date(at).toISOString(),
        payload: { type: 'user_message', message: '최근에 다시 시작한 작업' },
      }),
  );
  await writeFile(
    path.join(temp, 'codex', 'session_index.jsonl'),
    line({ id, thread_name: '이전 기록 이어서 정리' }),
  );
  const service = new OfficeService(path.join(temp, 'data'), temp);
  service.roots.codex = root;
  service.store.preferences({ enabledProviders: ['codex'] });
  try {
    const files = await discover(root);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, path.join(root, '2026', '06', '16', path.basename(file)));
    const first = (await service.refresh()).sessions;
    assert.equal(first.length, 1);
    assert.equal(first[0].nativeId, id);
    assert.equal(first[0].title, '이전 기록 이어서 정리');
    assert.equal(first[0].updatedAt, at);
    await appendFile(
      file,
      line({
        type: 'response_item',
        timestamp: new Date(at + 1000).toISOString(),
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '파일 크기를 확인하고 있어요.' }],
        },
      }),
    );
    await utimes(file, new Date(at + 1000), new Date(at + 1000));
    const next = (await service.refresh()).sessions;
    assert.equal(next.length, 1);
    assert.equal(next[0].id, first[0].id);
    assert.equal(next[0].updatedAt, at + 1000);
    assert.ok(JSON.stringify(next[0]).includes('파일 크기를 확인하고 있어요.'));
  } finally {
    await service.shutdown();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Linked discovery keeps depth limits, exclusions, root errors and mtime ordering', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-linked-depth-'));
  const root = path.join(temp, 'root');
  const external = path.join(temp, 'external');
  await mkdir(root);
  await mkdir(path.join(external, 'deep'), { recursive: true });
  await mkdir(path.join(external, 'archive'));
  await writeFile(path.join(external, 'latest.jsonl'), '{}\n');
  await writeFile(path.join(external, 'deep', 'too-deep.jsonl'), '{}\n');
  await writeFile(path.join(external, 'archive', 'ignored.jsonl'), '{}\n');
  await writeFile(path.join(root, 'old.jsonl'), '{}\n');
  await utimes(path.join(root, 'old.jsonl'), 1, 1);
  await directoryLink(external, path.join(root, 'month'));
  await directoryLink(path.join(external, 'archive'), path.join(root, 'disguised-archive'));
  await directoryLink(path.join(temp, 'absent'), path.join(root, 'broken'));
  try {
    assert.deepEqual(
      (await discover(root, 0)).map((f) => path.basename(f.path)),
      ['old.jsonl'],
    );
    assert.deepEqual(
      (await discover(root, 1)).map((f) => path.basename(f.path)),
      ['latest.jsonl', 'old.jsonl'],
    );
    assert.deepEqual(
      new Set((await discover(root)).map((f) => path.basename(f.path))),
      new Set(['latest.jsonl', 'too-deep.jsonl', 'old.jsonl']),
    );
    await assert.rejects(discover(path.join(temp, 'missing')), { code: 'ENOENT' });
    assert.equal(
      (await discover(path.join(root, 'month'), 0)).length,
      1,
      'linked root is supported',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('A deeper alias cannot consume the traversal budget of a shallower directory', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-linked-budget-'));
  await mkdir(path.join(temp, 'root', 'a'), { recursive: true });
  await mkdir(path.join(temp, 'external', 'child'), { recursive: true });
  await writeFile(path.join(temp, 'external', 'child', 'session.jsonl'), '{}\n');
  await directoryLink(path.join(temp, 'external'), path.join(temp, 'root', 'a', 'early-alias'));
  await directoryLink(path.join(temp, 'external'), path.join(temp, 'root', 'z-shallow'));
  try {
    assert.equal((await discover(path.join(temp, 'root'), 2)).length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test(
  'JSONL file aliases are read once; broken and non-file links are ignored',
  { skip: process.platform === 'win32' },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'office-linked-file-'));
    await writeFile(path.join(temp, 'original.jsonl'), '{}\n');
    await writeFile(path.join(temp, 'notes.txt'), 'ignore');
    await symlink(path.join(temp, 'original.jsonl'), path.join(temp, 'alias.jsonl'));
    await symlink(path.join(temp, 'missing'), path.join(temp, 'broken.jsonl'));
    await symlink('/dev/null', path.join(temp, 'device.jsonl'));
    try {
      assert.deepEqual(
        (await discover(temp)).map((f) => path.basename(f.path)),
        ['original.jsonl'],
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
