import { parentPort, workerData } from 'node:worker_threads';
import { OfficeService } from './service.js';
const service = new OfficeService(workerData?.dataDir);
service.on('snapshot', (snapshot) => parentPort?.postMessage({ event: 'snapshot', snapshot }));
parentPort?.on('message', async ({ id, method, args }) => {
  try {
    parentPort?.postMessage({ id, result: await service.call(method, args) });
  } catch (e) {
    parentPort?.postMessage({ id, error: e instanceof Error ? e.message : '요청 실패' });
  }
});
service.start();
