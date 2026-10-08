import { parentPort, workerData } from 'node:worker_threads';
import { OfficeService } from './service.js';
import { m } from '../src/shared/i18n/index.js';
const service = new OfficeService(workerData?.dataDir);
// Only what changed crosses to the app, unless there is nothing to change from yet.
service.on('snapshot', (snapshot, patch) =>
  parentPort?.postMessage(
    patch ? { event: 'patch', snapshot: patch } : { event: 'snapshot', snapshot },
  ),
);
parentPort?.on('message', async ({ id, method, args }) => {
  try {
    parentPort?.postMessage({ id, result: await service.call(method, args) });
  } catch (e) {
    parentPort?.postMessage({ id, error: e instanceof Error ? e.message : m().server.rpc.failed });
  }
});
service.start();
