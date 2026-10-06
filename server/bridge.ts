import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
export class ServiceBridge extends EventEmitter {
  worker: Worker;
  nextId = 0;
  pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(file: string, dataDir?: string) {
    super();
    this.worker = new Worker(file, { workerData: { dataDir } });
    this.worker.on('message', (m) => {
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
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
      this.emit('failure', e.message);
    });
  }
  call(method: string, args: unknown[] = []): Promise<any> {
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
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('앱이 종료되었습니다.'));
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}
