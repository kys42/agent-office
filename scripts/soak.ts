/**
 * Long-run check (#64): replays hours of office activity fast and reports whether memory stays
 * flat. Sessions keep appending (some of them at a time), new ones start, old ones go quiet;
 * every cycle is one collector pass. Temporary home and data only.
 *
 *   node --expose-gc --import tsx scripts/soak.ts [cycles=720] [sessions=150] [newEvery=0]
 *
 * 720 cycles is an hour of 5-second passes. Few sessions fill their caches sooner (each keeps
 * up to 180 events), which makes the flat part longer. Exits non-zero if the post-GC heap after warm-up
 * grows more than 10% (PERFORMANCE-DESIGN.md target) or a cache passes its bound.
 */
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeService } from '../server/service.js';

const cycles = Number(process.argv[2] ?? 720);
const total = Number(process.argv[3] ?? 150);
/** Cycles between new conversations; 0 keeps the same sessions (a pure leak check). */
const every = Number(process.argv[4] ?? 0);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1048576;
};

const temp = await mkdtemp(path.join(os.tmpdir(), 'office-soak-'));
const project = path.join(temp, 'claude', 'projects', 'soak');
await mkdir(project, { recursive: true });
let clock = Date.now() - cycles * 5000;
const line = (id: string, n: number, role: 'user' | 'assistant') =>
  JSON.stringify(
    role === 'user'
      ? {
          type: 'user',
          sessionId: id,
          timestamp: new Date(clock).toISOString(),
          cwd: '/tmp/soak',
          message: { role, content: `요청 ${n}: ${'설명 '.repeat(40)}` },
        }
      : {
          type: 'assistant',
          sessionId: id,
          timestamp: new Date(clock).toISOString(),
          message: {
            id: `m-${id}-${n}`,
            role,
            // Tool output is large and only a short excerpt is kept: the slice case.
            content: [{ type: 'text', text: `진행 ${n} ${'출력'.repeat(3000)}` }],
            stop_reason: n % 5 ? null : 'end_turn',
          },
        },
  ) + '\n';
const id = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
const file = (i: number) => path.join(project, `${id(i)}.jsonl`);
const turns = new Map<number, number>();
async function touch(i: number) {
  const n = (turns.get(i) ?? 0) + 1;
  turns.set(i, n);
  await appendFile(file(i), line(id(i), n, 'user') + line(id(i), n, 'assistant'));
  await utimes(file(i), clock / 1000, clock / 1000);
}
// Every conversation starts with a long history (past the 180 events a session keeps), so the
// caches are full from the first pass and what follows measures growth, not filling.
const history = (i: number) =>
  Array.from({ length: 100 }, (_, n) =>
    [
      JSON.stringify({
        type: 'user',
        sessionId: id(i),
        timestamp: new Date(clock - (100 - n) * 60_000).toISOString(),
        cwd: '/tmp/soak',
        message: { role: 'user', content: `예전 요청 ${n}: ${'설명 '.repeat(40)}` },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id(i),
        timestamp: new Date(clock - (100 - n) * 60_000).toISOString(),
        message: {
          id: `old-${id(i)}-${n}`,
          role: 'assistant',
          // As large as live output, so the retained events don't grow when new ones replace them.
          content: [{ type: 'text', text: `예전 결과 ${n} ${'출력'.repeat(3000)}` }],
          stop_reason: 'end_turn',
        },
      }),
    ].join('\n'),
  ).join('\n') + '\n';
for (let i = 0; i < total; i++) {
  await writeFile(file(i), history(i));
  turns.set(i, 100);
  await touch(i);
}

// The replayed clock, before the collector exists: its caches read the clock they are given.
const realNow = Date.now;
Date.now = () => clock;
const service = new OfficeService(path.join(temp, 'data'), temp);
service.roots.claude = path.join(temp, 'claude', 'projects');
service.store.preferences({ enabledProviders: ['claude'] });
let next = total;
const samples: {
  cycle: number;
  heap: number;
  windows: number;
  windowMiB: number;
  cache: number;
  cacheMiB: number;
  notices: number;
}[] = [];
let failed = '';
try {
  for (let c = 1; c <= cycles; c++) {
    clock += 5000;
    // A group of eight is at work for ten minutes (five of them write each pass), then goes
    // quiet while the next group works; now and then a new conversation starts.
    const group = Math.floor(c / 120) % Math.ceil(next / 8);
    for (let k = 0; k < 5; k++) await touch(Math.min(next - 1, group * 8 + ((c + k) % 8)));
    if (every && c % every === 0) {
      await writeFile(file(next), history(next));
      turns.set(next, 100);
      await touch(next++);
    }
    await service.refresh();
    const w = service.windows;
    if (w.bytes > w.budgetBytes) failed = `window cache over budget at ${c}`;
    if (service.cache.size > next) failed = `parse cache larger than the files at ${c}`;
    if (c === 1 || c % Math.max(1, Math.floor(cycles / 12)) === 0)
      samples.push({
        cycle: c,
        heap: heap(),
        windows: w.size,
        windowMiB: w.bytes / 1048576,
        cache: service.cache.size,
        // What the parse cache holds, as JSON text (a proxy for its share of the heap).
        // Notices the office carries in every snapshot (and keeps in the last one sent).
        notices: (service.snapshot().notices ?? []).length,
        cacheMiB:
          [...service.cache.values()].reduce((n, e) => n + JSON.stringify(e.session).length, 0) /
          1048576,
      });
  }
} finally {
  Date.now = realNow;
  service.stop();
  await rm(temp, { recursive: true, force: true });
}
console.table(
  samples.map((s) => ({
    cycle: s.cycle,
    'heap MiB': s.heap.toFixed(1),
    windows: s.windows,
    'window MiB': s.windowMiB.toFixed(1),
    'parse cache': s.cache,
    'cache MiB': s.cacheMiB.toFixed(1),
    notices: s.notices,
  })),
);
// Caches start full; the first sixth lets the active windows and the collector settle.
const warm = samples.find((s) => s.cycle >= cycles / 6) ?? samples[0];
const last = samples.at(-1)!;
const growth = (last.heap - warm.heap) / warm.heap;
console.log(
  `heap after warm-up ${warm.heap.toFixed(1)} MiB → ${last.heap.toFixed(1)} MiB (${(growth * 100).toFixed(1)}%)`,
);
if (growth > 0.1) failed ||= `heap grew ${(growth * 100).toFixed(1)}% after warm-up`;
if (failed) {
  console.error(`soak failed: ${failed}`);
  process.exit(1);
}
console.log('soak ok');
