import type { Session, TerminalTarget } from '../../src/shared/types.js';
import type { PeerSender } from './sender.js';

/** One stuck native lookup must not hold every colleague in a batch hostage. */
export class TargetProbes {
  private pending = new Map<
    string,
    { result: Promise<TerminalTarget | null>; expire: () => void }
  >();
  private closed = false;
  constructor(
    private sender: PeerSender,
    private timeoutMs = 6000,
    private limit = 500,
  ) {}
  target(session: Session): Promise<TerminalTarget | null> {
    if (this.closed) return Promise.resolve(null);
    const key = JSON.stringify([
      session.id,
      session.provider,
      session.nativeId,
      session.sourcePath,
    ]);
    const existing = this.pending.get(key);
    if (existing) return existing.result;
    if (this.pending.size >= this.limit) return Promise.resolve(null);
    let resolve!: (target: TerminalTarget | null) => void;
    const result = new Promise<TerminalTarget | null>((done) => (resolve = done));
    const timer = setTimeout(() => resolve(null), this.timeoutMs);
    const entry = {
      result,
      expire: () => {
        clearTimeout(timer);
        resolve(null);
      },
    };
    this.pending.set(key, entry);
    // Keep timed-out operations registered until they actually settle. Repeated UI polls must
    // not spawn more blocked filesystem/process work or add listeners to an unresolved promise.
    void Promise.resolve()
      .then(() => (this.closed ? null : this.sender.target(session)))
      .then(
        (target) => resolve(target),
        () => resolve(null),
      )
      .finally(() => {
        clearTimeout(timer);
        if (this.pending.get(key) === entry) this.pending.delete(key);
      });
    return result;
  }
  close() {
    this.closed = true;
    for (const entry of this.pending.values()) entry.expire();
    this.pending.clear();
  }
}
