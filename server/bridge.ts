import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { m } from '../src/shared/i18n/index.js';
export class ServiceBridge extends EventEmitter {
  worker!: Worker;
  nextId = 0;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      authorize?: () => Promise<void>;
    }
  >();
  /** Auto-recover within a bounded budget; a later explicit call can try again. */
  dead = false;
  closing = false;
  private restartAttempts = 0;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private file: string,
    private dataDir?: string,
    private restartDelays = [1000, 3000, 10000],
  ) {
    super();
    this.start();
  }
  private start() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.dead = false;
    const startedAt = Date.now();
    const worker = new Worker(this.file, { workerData: { dataDir: this.dataDir } });
    this.worker = worker;
    worker.on('message', (m) => {
      if (worker !== this.worker || this.dead || this.closing) return;
      if (m.authorize !== undefined) {
        const pending = this.pending.get(m.authorize);
        const guard = pending?.authorize;
        void (async () => {
          try {
            if (!guard || this.closing || worker !== this.worker) throw new Error('revoked');
            await guard();
            if (this.pending.get(m.authorize) !== pending || this.closing)
              throw new Error('revoked');
            worker.postMessage({ authorization: m.check, allowed: true });
          } catch {
            worker.postMessage({ authorization: m.check, allowed: false });
          }
        })();
        return;
      }
      if (m.event) {
        this.emit(m.event, m.snapshot);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    });
    const fail = (message: string) => {
      if (worker !== this.worker || this.dead) return;
      this.dead = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
      }
      this.pending.clear();
      if (!this.closing) {
        // One successful snapshot is not a healthy run. A flapping collector must stop
        // retrying rather than consuming a CPU forever. Only a stable minute resets it.
        if (Date.now() - startedAt >= 60_000) this.restartAttempts = 0;
        this.emit('failure', message);
        const delay = this.restartDelays[this.restartAttempts++];
        if (delay !== undefined) {
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            if (this.closing || !this.dead) return;
            this.start();
            void this.call('snapshot').then(
              (snapshot) => {
                if (this.closing || this.dead) return;
                this.emit('snapshot', snapshot);
              },
              () => {},
            );
          }, delay);
        }
      }
    };
    worker.on('error', (e) => fail(e.message));
    worker.on('exit', () => fail(m().server.rpc.stopped));
  }
  call(method: string, args: unknown[] = [], authorize?: () => Promise<void>): Promise<any> {
    if (this.closing) return Promise.reject(new Error(m().server.rpc.closed));
    if (this.dead) {
      this.restartAttempts = 0;
      this.start();
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(m().server.rpc.timeout));
        },
        ['remote-send', 'remote-targets', 'remote-launch'].includes(method) ? 120000 : 45000,
      );
      this.pending.set(id, { resolve, reject, timer, authorize });
      this.worker.postMessage({ id, method, args, guarded: !!authorize });
    });
  }
  /**
   * Asks the collector to stop cleanly (finish a pass in flight, write what the hot path staged,
   * close its database) and waits up to `timeout` ms for it, then ends the worker either way.
   */
  async close(timeout = 3000) {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.recoveryTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(m().server.rpc.closed));
    }
    this.pending.clear();
    const worker = this.worker;
    if (!this.dead) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          const done = (message: { stopped?: boolean }) => {
            if (!message?.stopped) return;
            worker.off('message', done);
            resolve();
          };
          worker.on('message', done);
          worker.once('exit', () => resolve());
          worker.postMessage({ stop: true });
        }),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout))),
      ]);
      clearTimeout(timer);
    }
    await worker.terminate();
  }
}
