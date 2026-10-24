import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { demoSnapshot } from '../src/lib/demo.js';
import { nativeSessionRenamer, SessionTitles, codexSetTitle } from '../server/session-title.js';
import { sessionTitleSchema } from '../src/shared/session-title.js';
import { parseRecords } from '../server/adapters/normalize.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-title-'));
  const projects = path.join(root, 'claude', 'projects');
  await mkdir(path.join(projects, 'project'), { recursive: true });
  const id = randomUUID();
  const s = {
    ...demoSnapshot().sessions[0],
    provider: 'claude' as const,
    nativeId: id,
    id: `claude:${id}`,
    sourcePath: path.join(projects, 'project', id + '.jsonl'),
    sourcePaths: undefined,
    relation: undefined,
    origin: undefined,
    title: 'Original',
    cwd: root,
  };
  const original =
    JSON.stringify({
      type: 'user',
      sessionId: id,
      uuid: randomUUID(),
      timestamp: '2026-10-01T00:00:00Z',
      message: { role: 'user', content: 'A real request' },
    }) + '\n';
  await writeFile(s.sourcePath, original);
  const renamer = nativeSessionRenamer({ claudeRoot: projects });
  return {
    root,
    projects,
    s,
    original,
    renamer,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('official Claude SDK appends only a title, preserves requests, and supports relocated directories', async () => {
  const f = await fixture();
  try {
    const relocated = path.join(f.root, 'linked-projects');
    await symlink(f.projects, relocated);
    f.s.sourcePath = f.s.sourcePath.replace(f.projects, relocated);
    const rename = nativeSessionRenamer({ claudeRoot: relocated });
    assert.equal((await rename.info(f.s)).available, true);
    await rename.rename(f.s, '  새 제목 🐈  ', async () => {});
    const content = await readFile(f.s.sourcePath, 'utf8');
    assert.ok(content.startsWith(f.original));
    const lines = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].type, 'custom-title');
    assert.equal(lines[1].customTitle, '새 제목 🐈');
    const parsed = parseRecords(lines, {
      provider: 'claude',
      sourcePath: f.s.sourcePath,
      mtime: Date.now(),
    });
    assert.equal(parsed?.title, '새 제목 🐈');
    assert.equal(parsed?.events.length, 1);
    assert.equal(parsed?.updatedAt, Date.parse('2026-10-01T00:00:00Z'));
  } finally {
    await f.close();
  }
});

test('unsupported identities, mismatched headers, foreign roots, partial lines and revoked authorization do not write', async () => {
  const f = await fixture();
  try {
    for (const s of [
      { ...f.s, id: 'fallback-id' },
      { ...f.s, provider: 'openclaw' as const },
      { ...f.s, sourcePaths: ['a', 'b'] },
      { ...f.s, relation: { kind: 'subagent' as const, parentNativeId: null, source: 'test' } },
    ])
      assert.equal((await f.renamer.info(s)).available, false);
    assert.equal(
      (await nativeSessionRenamer({ claudeRoot: path.join(f.root, 'other') }).info(f.s)).available,
      false,
    );
    await assert.rejects(
      f.renamer.rename(f.s, 'Changed', async () => {
        throw Error('revoked');
      }),
    );
    assert.equal(await readFile(f.s.sourcePath, 'utf8'), f.original);
    await assert.rejects(
      f.renamer.rename(f.s, 'Replaced source', async () => {
        await rename(f.s.sourcePath, f.s.sourcePath + '.old');
        await writeFile(f.s.sourcePath, f.original);
      }),
    );
    assert.equal(await readFile(f.s.sourcePath + '.old', 'utf8'), f.original);
    assert.equal(await readFile(f.s.sourcePath, 'utf8'), f.original);
    await writeFile(f.s.sourcePath, f.original + '{"partial":');
    await assert.rejects(f.renamer.rename(f.s, 'Changed', async () => {}));
    assert.equal(await readFile(f.s.sourcePath, 'utf8'), f.original + '{"partial":');
    await writeFile(f.s.sourcePath, f.original.replace(f.s.nativeId, randomUUID()));
    assert.equal((await f.renamer.info(f.s)).available, false);
    for (const name of ['', ' ', 'x\ny', '\0', 'x'.repeat(121)])
      assert.equal(sessionTitleSchema.safeParse(name).success, false);
  } finally {
    await f.close();
  }
});

test('durable request identity prevents a repeated rename from overwriting later external edits', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const adapter = {
      info: async () => ({ available: true, title: f.s.title, status: 'ready' as const }),
      rename: async (_s: unknown, _title: string, verify: () => void | Promise<void>) => {
        await verify();
        calls++;
      },
    };
    const request = { title: 'New', expected: f.s.title, requestId: randomUUID() };
    const controller = new SessionTitles(f.root, adapter);
    assert.equal(
      (
        await controller.call(
          () => f.s,
          request,
          async () => {},
        )
      ).status,
      'renamed',
    );
    f.s.title = 'Changed elsewhere';
    const restarted = new SessionTitles(f.root, adapter);
    assert.equal(
      (
        await restarted.call(
          () => f.s,
          request,
          async () => {},
        )
      ).status,
      'renamed',
    );
    assert.equal(calls, 1);
    await assert.rejects(
      restarted.call(
        () => f.s,
        { ...request, title: 'Different payload' },
        async () => {},
      ),
    );
    assert.equal(
      (
        await restarted.call(
          () => f.s,
          { ...request, requestId: randomUUID() },
          async () => {},
        )
      ).status,
      'uncertain',
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('Codex transport uses only initialize and thread/name/set; failed requests are not replayed', async () => {
  const f = await fixture();
  try {
    const script = path.join(f.root, 'fake-codex');
    const log = path.join(f.root, 'requests.jsonl');
    await writeFile(
      script,
      `#!${process.execPath}\n` +
        `
      const fs = require('node:fs');
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
        const r=JSON.parse(line);
        if(r.id) process.stdout.write(JSON.stringify({id:r.id,result:{}})+'\\n');
      });
    `,
      { mode: 0o700 },
    );
    await codexSetTitle(script, f.root, f.s.nativeId, 'New title');
    const requests = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.deepEqual(
      requests.map((r) => r.method),
      ['initialize', 'initialized', 'thread/name/set'],
    );
    assert.deepEqual(requests[2].params, { threadId: f.s.nativeId, name: 'New title' });
    await assert.rejects(codexSetTitle(path.join(f.root, 'missing'), f.root, f.s.nativeId, 'New'));
  } finally {
    await f.close();
  }
});
