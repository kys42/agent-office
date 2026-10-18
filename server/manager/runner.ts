import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request, type Connection } from './protocol.js';
import { runProvider } from './provider.js';
import type { ManagerProvider } from '../../src/shared/manager.js';
async function main() {
  const config: Connection & { executable: string; provider: ManagerProvider; workspace: string } =
    JSON.parse(await readFile(process.argv[2], 'utf8'));
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());
  process.on('SIGHUP', () => abort.abort());
  let disconnected = false;
  const heartbeat = setInterval(() => {
    void request(config, 'heartbeat').catch(() => {
      disconnected = true;
      abort.abort();
    });
  }, 2000);
  try {
    while (!abort.signal.aborted) {
      const job = await request(config, 'take');
      if (!job) {
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      await writeFile(
        path.join(config.workspace, '.office-connection.json'),
        JSON.stringify({ socket: config.socket, token: job.toolToken }),
        { mode: 0o600 },
      );
      console.log(`[${new Date().toISOString()}] ${job.kind} ${job.id}`);
      try {
        const result = await runProvider({
          provider: config.provider,
          executable: config.executable,
          cwd: config.workspace,
          sessionId: job.sessionId,
          prompt: job.prompt,
          signal: abort.signal,
          onText: (text) => {
            void request(config, 'progress', { jobId: job.id, text }).catch(() => {});
          },
          onSession: (id) => {
            void request(config, 'session', { jobId: job.id, id }).catch(() => {});
          },
        });
        await request(config, 'complete', { id: job.id, ...result });
        console.log('Completed.');
      } catch (e) {
        if (!disconnected)
          await request(config, 'complete', { id: job.id, error: (e as Error).message }).catch(
            () => {},
          );
        console.error((e as Error).message);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
