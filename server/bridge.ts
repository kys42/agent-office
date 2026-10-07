import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { m } from '../src/shared/i18n/index.js';
export class ServiceBridge extends EventEmitter {
  worker!: Worker;
  nextId = 0;
  pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** The collector crashed or exited (e.g. its database was locked); the next call restarts it. */
  dead = false;
  closing = false;
  constructor(
    private file: string,
    private dataDir?: string,
  ) {
    super();
    this.start();
  }
  private start() {
    this.dead = false;
    const worker = new Worker(this.file, { workerData: { dataDir: this.dataDir } });
    this.worker = worker;
    worker.on('message', (m) => {
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
      if (!this.closing) this.emit('failure', message);
    };
    worker.on('error', (e) => fail(e.message));
    worker.on('exit', () => fail(m().server.rpc.stopped));
  }
  call(method: string, args: unknown[] = []): Promise<any> {
    if (this.dead && !this.closing) this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(m().server.rpc.timeout));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  async close() {
    this.closing = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(m().server.rpc.closed));
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}
