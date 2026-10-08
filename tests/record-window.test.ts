import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, stat, truncate, writeFile, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRecords } from '../server/adapters/files.js';
import { RecordWindowCache } from '../server/adapters/record-window.js';

async function temp() {
  return mkdtemp(path.join(os.tmpdir(), 'office-window-'));
}
async function source(file: string) {
  const st = await stat(file);
  return { path: file, size: st.size, mtime: st.mtimeMs };
}
const line = (id: number, pad = 120) =>
  JSON.stringify({ type: 'event', id, text: `${'가'.repeat(pad / 3)}${'x'.repeat(pad)}` }) + '\n';
const lines = (from: number, count: number, pad?: number) =>
  Array.from({ length: count }, (_, i) => line(from + i, pad)).join('');

/** The cache must return exactly what the bounded reader returns for the same bytes. */
async function same(
  cache: RecordWindowCache,
  file: string,
  mode?: 'append' | 'full',
  verify = false,
) {
  const src = await source(file);
  const got = await (verify ? cache.verify(src) : cache.read(src));
  const want = await readRecords(src);
  assert.deepEqual(got.records, want.records);
  assert.equal(got.partial, want.partial);
  if (mode) assert.equal(got.mode, mode);
  return got;
}

test('Appended JSONL reads only new lines and still equals the bounded reader', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const cache = new RecordWindowCache();
    await writeFile(file, lines(0, 20));
    await same(cache, file, 'full');
    // Small appends, an unchanged re-read, and a malformed complete line.
    await appendFile(file, lines(20, 3));
    await same(cache, file, 'append');
    await same(cache, file, 'append');
    await appendFile(file, 'not json\n[1,2]\n   \n');
    assert.equal((await same(cache, file, 'append')).partial, true);
    await writeFile(file, lines(0, 20));
    await same(cache, file, 'full');
    // A write that stops mid-line, then a multi-byte character split across two appends.
    const next = Buffer.from(line(100));
    const cut = next.indexOf(Buffer.from('가')) + 1;
    await appendFile(file, next.subarray(0, cut));
    assert.equal((await same(cache, file, 'append')).partial, true);
    await appendFile(file, next.subarray(cut));
    const done = await same(cache, file, 'append');
    assert.equal(done.partial, false);
    assert.equal(done.records.at(-1)!.id, 100);
    // Cross the 3 MiB budget in steps, then keep going far beyond it.
    let id = 200;
    while ((await stat(file)).size < 3 * 1024 * 1024 - 400_000) {
      await appendFile(file, lines(id, 2000));
      id += 2000;
      await same(cache, file);
    }
    await appendFile(file, lines(id, 3000));
    id += 3000;
    assert.ok((await stat(file)).size > 3 * 1024 * 1024);
    assert.equal((await same(cache, file, 'append')).partial, true);
    for (let step = 0; step < 6; step++) {
      await appendFile(file, lines(id, 3000) + line(id + 3000).replace('\n', '\r\n') + '\n');
      id += 3001;
      // An unfinished tail line beyond the budget, completed on the next step.
      await appendFile(file, '{"type":"event","id":');
      await same(cache, file, 'append');
      await appendFile(file, `${id++}}\n`);
      await same(cache, file, 'append');
    }
    assert.ok((await stat(file)).size > 6 * 1024 * 1024);
    const tail = await same(cache, file, 'append');
    assert.equal(tail.records[0].id, 0);
    assert.equal(tail.records.at(-1)!.id, id - 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('A file that is shrunk, replaced or rewritten in place is read in full again', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const cache = new RecordWindowCache();
    await writeFile(file, lines(0, 50));
    await same(cache, file, 'full');
    await truncate(file, Buffer.byteLength(lines(0, 30)));
    await same(cache, file, 'full');
    // A new inode at the same path (atomic rewrite), even when it is longer.
    const other = path.join(dir, 'b.jsonl');
    await writeFile(other, lines(1000, 60));
    await rename(other, file);
    await same(cache, file, 'full');
    // Same-size overwrite just before the resume point, then an append: the guard notices.
    const fh = await open(file, 'r+');
    await fh.write(Buffer.from('yyyy'), 0, 4, Buffer.byteLength(lines(1000, 60)) - 10);
    await fh.close();
    await appendFile(file, line(1060));
    const r = await same(cache, file, 'full');
    assert.ok(r.records.at(-2)!.text.endsWith('yyyyxxx'));
    await appendFile(file, line(1061));
    await same(cache, file, 'append');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Stale entries are verified with a full read after ten minutes', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    let now = 1_000_000;
    const cache = new RecordWindowCache({ now: () => now });
    await writeFile(file, lines(0, 5));
    await same(cache, file, 'full');
    await appendFile(file, line(5));
    now += 9 * 60_000;
    await same(cache, file, 'append');
    now += 2 * 60_000;
    await same(cache, file, 'full');
    await same(cache, file, 'append');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('The first record larger than the head window still uses the full recovery path', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const cache = new RecordWindowCache();
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'big', x: 'y'.repeat(900_000) },
    });
    await writeFile(file, `${meta}\n${lines(0, 100)}`);
    await same(cache, file, 'full');
    await appendFile(file, lines(100, 15_000));
    assert.ok((await stat(file)).size > 3 * 1024 * 1024);
    const r = await same(cache, file, 'full');
    assert.equal(r.records[0].type, 'session_meta');
    assert.equal(cache.has(file), false);
    await appendFile(file, line(20_000));
    await same(cache, file, 'full');
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('The window cache stays within its byte budget and drops undiscovered paths', async () => {
  const dir = await temp();
  try {
    const files = ['a', 'b', 'c'].map((n) => path.join(dir, `${n}.jsonl`));
    for (const f of files) await writeFile(f, lines(0, 400));
    const one = Buffer.byteLength(lines(0, 400));
    const cache = new RecordWindowCache({ budgetBytes: one * 2 + 1000 });
    for (const f of files) await same(cache, f, 'full');
    assert.equal(cache.size, 2);
    assert.ok(cache.bytes <= cache.budgetBytes);
    assert.equal(cache.has(files[0]), false);
    // The evicted file simply reads in full next time; recently read ones stay.
    await appendFile(files[0], line(400));
    await same(cache, files[0], 'full');
    assert.equal(cache.has(files[1]), false);
    await appendFile(files[2], line(400));
    await same(cache, files[2], 'append');
    cache.prune(new Set([files[2]]));
    assert.equal(cache.size, 1);
    assert.equal(cache.has(files[2]), true);
    // Pruning scoped to another root leaves these entries alone.
    cache.prune(new Set(), path.join(dir, 'elsewhere'));
    assert.equal(cache.size, 1);
    cache.prune(new Set(), dir);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Random append splits match the bounded reader with a small budget', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const maxBytes = 64 * 1024;
    const cache = new RecordWindowCache({ maxBytes });
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n) as number;
    const body = Buffer.from(
      Array.from({ length: 1500 }, (_, i) =>
        rand(25) === 0
          ? ['oops\n', '\n', '"str"\n', '  \r\n'][rand(4)]
          : JSON.stringify({ id: i, t: '한글✓'.repeat(rand(40)) }) + (rand(9) ? '\n' : '\r\n'),
      ).join(''),
    );
    await writeFile(file, '');
    let appends = 0;
    for (let at = 0; at < body.length;) {
      const n = Math.min(body.length - at, 1 + rand(4000));
      await appendFile(file, body.subarray(at, at + n));
      at += n;
      const src = await source(file);
      const got = await cache.read(src);
      const want = await readRecords(src, maxBytes);
      assert.deepEqual(got.records, want.records);
      assert.equal(got.partial, want.partial);
      if (got.mode === 'append') appends++;
    }
    assert.ok(body.length > maxBytes * 3);
    assert.ok(appends > 50);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('A window built by appends asks for a full re-verification and reports drift', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    let now = 1_000_000;
    const cache = new RecordWindowCache({ now: () => now });
    await writeFile(file, lines(0, 5));
    await same(cache, file, 'full');
    assert.equal(cache.stale(file), false);
    now += 11 * 60_000;
    // Only appended windows are due: a full-read window stays trusted until the file changes.
    assert.equal(cache.stale(file), false);
    await appendFile(file, line(5));
    await same(cache, file, 'full');
    await appendFile(file, line(6));
    await same(cache, file, 'append');
    assert.equal(cache.stale(file), false);
    now += 11 * 60_000;
    assert.equal(cache.stale(file), true);
    const quiet = await same(cache, file, 'full', true);
    assert.equal(quiet.drifted, false);
    assert.equal(cache.stale(file), false);
    // An in-place rewrite outside the guard that the append path could not see.
    await appendFile(file, line(7));
    await same(cache, file, 'append');
    const fh = await open(file, 'r+');
    await fh.write(Buffer.from('9'), 0, 1, Buffer.byteLength('{"type":"event","id":'));
    await fh.close();
    now += 11 * 60_000;
    assert.equal(cache.stale(file), true);
    const drift = await same(cache, file, 'full', true);
    assert.equal(drift.drifted, true);
    assert.equal(drift.records[0].id, 9);
    // Ordinary fallbacks re-parse anyway and never pay for the comparison.
    await appendFile(file, line(8));
    await same(cache, file, 'append');
    now += 11 * 60_000;
    assert.equal((await same(cache, file, 'full')).drifted, undefined);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('An appended window evicted before verification is still re-verified', async () => {
  const dir = await temp();
  try {
    const [a, b] = ['a', 'b'].map((n) => path.join(dir, `${n}.jsonl`));
    let now = 1_000_000;
    const one = Buffer.byteLength(lines(0, 200));
    const cache = new RecordWindowCache({ now: () => now, budgetBytes: one * 1.5 });
    await writeFile(a, lines(0, 200));
    await same(cache, a, 'full');
    await appendFile(a, line(200));
    await same(cache, a, 'append');
    await writeFile(b, lines(0, 200));
    await same(cache, b, 'full');
    assert.equal(cache.has(a), false);
    assert.equal(cache.stale(a), false);
    now += 11 * 60_000;
    assert.equal(cache.stale(a), true);
    assert.equal((await same(cache, a, 'full', true)).drifted, true);
    assert.equal(cache.stale(a), false);
    cache.prune(new Set());
    assert.equal(cache.stale(a), false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Long lines, large jumps and unfinished lines wider than the tail match the bounded reader', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    // A single growth beyond the tail window falls back to the bounded reader.
    const maxBytes = 16 * 1024;
    let cache = new RecordWindowCache({ maxBytes });
    const check = async (bytes: number, mode?: 'append' | 'full') => {
      const src = await source(file);
      assert.equal(src.size, bytes);
      const got = await cache.read(src);
      const want = await readRecords(src, maxBytes);
      assert.deepEqual(got.records, want.records);
      assert.equal(got.partial, want.partial);
      if (mode) assert.equal(got.mode, mode);
    };
    await writeFile(file, lines(0, 10, 30));
    let size = Buffer.byteLength(lines(0, 10, 30));
    await check(size, 'full');
    const jump = lines(10, 120, 30);
    await appendFile(file, jump);
    await check((size += Buffer.byteLength(jump)), 'full');
    await appendFile(file, line(500, 30));
    await check((size += Buffer.byteLength(line(500, 30))), 'append');
    // An unfinished line longer than the tail window, then its end.
    const unfinished = `{"type":"event","id":501,"t":"${'z'.repeat(maxBytes)}`;
    await appendFile(file, unfinished);
    await check((size += Buffer.byteLength(unfinished)), 'full');
    await appendFile(file, '"}\n');
    await check((size += 3), 'full');
    await appendFile(file, line(502, 30));
    await check((size += Buffer.byteLength(line(502, 30))), 'append');

    // Seeded fuzz: lines up to twice the budget straddle the head and tail cuts.
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    let appends = 0;
    let fulls = 0;
    for (let iter = 0; iter < 10; iter++) {
      const budget = 8 * 1024 + rand(8192);
      cache = new RecordWindowCache({ maxBytes: budget, budgetBytes: 1e9 });
      await writeFile(file, '');
      let id = 0;
      for (let step = 0; step < 90; step++) {
        const r = rand(100);
        let chunk: string;
        if (r < 4) chunk = JSON.stringify({ id: id++, big: 'x'.repeat(rand(budget * 2)) }) + '\n';
        else if (r < 7) chunk = 'garbage' + (rand(2) ? '\n' : '');
        else if (r < 10) chunk = '\r\n';
        else if (r < 13)
          chunk = Array.from(
            { length: 50 + rand(300) },
            () => JSON.stringify({ id: id++, t: '가✓'.repeat(rand(30)) }) + '\n',
          ).join('');
        else
          chunk = Array.from(
            { length: 1 + rand(6) },
            () =>
              JSON.stringify({ id: id++, t: '가✓'.repeat(rand(60)) }) + (rand(5) ? '\n' : '\r\n'),
          ).join('');
        const buf = Buffer.from(chunk);
        const cut = rand(buf.length + 1);
        for (const part of [buf.subarray(0, cut), buf.subarray(cut)]) {
          if (!part.length) continue;
          await appendFile(file, part);
          const src = await source(file);
          const got = await cache.read(src);
          const want = await readRecords(src, budget);
          assert.deepEqual(got.records, want.records, `iter ${iter} step ${step}`);
          assert.equal(got.partial, want.partial, `iter ${iter} step ${step}`);
          if (got.mode === 'append') appends++;
          else fulls++;
        }
      }
    }
    assert.ok(appends > 500 && fulls > 50, `${appends} appends, ${fulls} full reads`);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('Shrinking only an unfinished tail of a large file is not treated as an append', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const maxBytes = 16 * 1024;
    const cache = new RecordWindowCache({ maxBytes });
    const unfinished = `{"type":"event","id":-1,"t":"${'z'.repeat(4000)}`;
    await writeFile(file, lines(0, 200, 30) + unfinished);
    const read = async (mode: 'append' | 'full') => {
      const src = await source(file);
      const got = await cache.read(src);
      const want = await readRecords(src, maxBytes);
      assert.deepEqual(got.records, want.records);
      assert.equal(got.partial, want.partial);
      assert.equal(got.mode, mode);
    };
    await read('full');
    await read('append');
    // Still past the last complete line, but the bounded tail window moves back.
    await truncate(file, Buffer.byteLength(lines(0, 200, 30)) + 500);
    await read('full');
    await appendFile(file, '"}\n');
    await read('append');
  } finally {
    await rm(dir, { recursive: true });
  }
});
