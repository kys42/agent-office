import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
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
    worker.on('exit', () => fail('수집기가 멈췄어요. 새로고침하면 다시 시작해요.'));
  }
  call(method: string, args: unknown[] = []): Promise<any> {
    if (this.dead && !this.closing) this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('수집기의 응답이 늦어요. 다시 시도해 주세요.'));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  async close() {
    this.closing = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('앱이 종료되었습니다.'));
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}
