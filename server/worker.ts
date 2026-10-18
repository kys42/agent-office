import { parentPort, workerData } from 'node:worker_threads';
import { OfficeService } from './service.js';
import path from 'node:path';
import { defaultDataDir } from './store.js';
import { PeerManager } from './federation/peers.js';
import { FederatedService } from './federation/service.js';
import { m } from '../src/shared/i18n/index.js';
const local = new OfficeService(workerData?.dataDir);
const service = new FederatedService(
  local,
  new PeerManager(
    process.env.AGENT_OFFICE_FEDERATION_DIR ??
      path.join(workerData?.dataDir ?? defaultDataDir(), 'federation-beta'),
  ),
);
// Only what changed crosses to the app, unless there is nothing to change from yet.
service.on('snapshot', (snapshot, patch) =>
  parentPort?.postMessage(
    patch ? { event: 'patch', snapshot: patch } : { event: 'snapshot', snapshot },
  ),
);
let nextCheck = 0;
const checks = new Map<number, (allowed: boolean) => void>();
function authorize(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = ++nextCheck;
    const timer = setTimeout(() => {
      checks.delete(check);
      reject(new Error('authorization-timeout'));
    }, 10000);
    checks.set(check, (allowed) => {
      clearTimeout(timer);
      checks.delete(check);
      allowed ? resolve() : reject(new Error('authorization-revoked'));
    });
    parentPort?.postMessage({ authorize: id, check });
  });
}
parentPort?.on(
  'message',
  async ({ id, method, args, stop, guarded, authorization, allowed, managerState }) => {
    if (authorization !== undefined) {
      checks.get(authorization)?.(allowed === true);
      return;
    }
    if (managerState) {
      try {
        local.syncManager(managerState);
      } catch (e) {
        console.error(e);
      }
      return;
    }
    // The app is quitting: finish what is in flight, write what the hot path staged, then say so.
    if (stop) {
      for (const check of checks.values()) check(false);
      await service.shutdown().catch(() => {});
      parentPort?.postMessage({ stopped: true });
      return;
    }
    try {
      parentPort?.postMessage({
        id,
        result: await service.call(
          method,
          args,
          guarded && method === 'remote-send' ? () => authorize(id) : undefined,
        ),
      });
    } catch (e) {
      parentPort?.postMessage({
        id,
        error: e instanceof Error ? e.message : m().server.rpc.failed,
      });
    }
  },
);
service.start();
