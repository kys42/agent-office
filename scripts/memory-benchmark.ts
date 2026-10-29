/** Synthetic collector-only benchmark; never opens real provider homes or app data.
 * node --expose-gc --import tsx scripts/memory-benchmark.ts [notices=50000]
 * Run the same script on the comparison revision in a separate checkout/process.
 * GC is measurement-only. RSS includes SQLite/allocator effects and is not a heap limit.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OfficeService } from '../server/service.js';
import { parseRecords } from '../server/adapters/normalize.js';
const gc = (globalThis as any).gc;
if (!gc) throw new Error('--expose-gc required');
const dir = await mkdtemp(path.join(os.tmpdir(), 'office-memory-bench-'));
const service = new OfficeService(dir, dir);
const count = Number(process.argv[2] ?? 50000);
if (!Number.isSafeInteger(count) || count < 100 || count > 1000000)
  throw new Error('notice count must be 100..1000000');
const now = Date.now();
const mib = (n: number) => Math.round((n / 1048576) * 100) / 100;
const memory = () => {
  gc();
  gc();
  const m = process.memoryUsage();
  return { heapMiB: mib(m.heapUsed), rssMiB: mib(m.rss) };
};
try {
  const sessions = Array.from({ length: 100 }, (_, i) =>
    parseRecords(
      [
        { type: 'session_meta', payload: { id: `bench-${i}`, cwd: '/tmp/office-benchmark' } },
        {
          type: 'response_item',
          timestamp: new Date(now).toISOString(),
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '합성 성능 검수' }],
          },
        },
      ],
      { provider: 'codex', sourcePath: `/tmp/bench-${i}.jsonl`, mtime: now },
    ),
  );
  service.store.upsert(sessions, 'codex');
  service.store.db.exec('DELETE FROM notices; BEGIN');
  const put = service.store.db.prepare('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)');
  for (let i = 0; i < count; i++) {
    const sid = sessions[i < count * 0.8 ? 0 : i % 100].id;
    const n = {
      id: `bench-${String(i).padStart(8, '0')}`,
      sessionId: sid,
      eventId: `event-${i}`,
      version: `v${i}`,
      kind: i % 5 ? 'reply' : 'request',
      phase: i % 5 ? 'final' : undefined,
      title: '합성 소식',
      text: `${i} ${'가나다라마바사 '.repeat(64)}`,
      at: now - (count - i) * 1000,
      receivedAt: now - (count - i) * 1000,
      seenAt: i % 3 ? null : now - 1000,
      dismissedAt: null,
      viewedAt: null,
    };
    put.run(n.id, sid, n.at, JSON.stringify(n));
  }
  service.store.db.exec('COMMIT');
  const before = memory();
  const cpu = process.cpuUsage();
  const start = performance.now();
  let snapshot = service.emitSnapshot();
  const firstMs = performance.now() - start;
  const steady = performance.now();
  for (let i = 0; i < 8; i++) snapshot = service.emitSnapshot();
  const steadyMs = (performance.now() - steady) / 8;
  const after = memory();
  const paging = performance.now();
  const page = service.store.noticePage({ filter: 'final', includeRead: true, limit: 50 });
  const pageMs = performance.now() - paging;
  const detailStart = performance.now();
  const detail = service.store.detail(sessions[0].id);
  const detailMs = performance.now() - detailStart;
  const hot = { ...sessions[0], revision: 'live-2', updatedAt: now + 1 };
  const stageStart = performance.now();
  service.store.stage([hot], 'codex');
  const stageMs = performance.now() - stageStart;
  const staged = memory();
  const used = process.cpuUsage(cpu);
  console.log(
    JSON.stringify(
      {
        count,
        before,
        after,
        staged,
        firstMs,
        steadyMs,
        pageMs,
        detailMs,
        stageMs,
        cpuMs: (used.user + used.system) / 1000,
        snapshotNotices: snapshot.notices?.length,
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        pageNotices: page.notices.length,
        detailNotices: detail.notices?.length,
        stats: snapshot.noticeStats,
      },
      null,
      2,
    ),
  );
} finally {
  service.stop();
  await rm(dir, { recursive: true, force: true });
}
