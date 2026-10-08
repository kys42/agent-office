import type { Snapshot } from '../src/shared/types.js';

/** A window that can show the office: whether it is on screen, and how to hand it a snapshot. */
export interface Viewer {
  readonly id: number;
  shown(): boolean;
  send(snapshot: Snapshot): void;
}

/**
 * Hands the office only to windows on screen. A hidden window (the big office behind the desk
 * pet, a put-away card) gets nothing while hidden and the latest office once, when it shows
 * again — never each change it missed.
 */
export class SnapshotDelivery {
  latest: Snapshot | null = null;
  private given = new Map<number, string>();
  publish(snapshot: Snapshot, viewers: Viewer[]) {
    this.latest = snapshot;
    for (const v of viewers) if (v.shown()) this.give(v);
  }
  /** The window came on screen. */
  reveal(viewer: Viewer) {
    if (this.latest && viewer.shown()) this.give(viewer);
  }
  forget(id: number) {
    this.given.delete(id);
  }
  private give(viewer: Viewer) {
    const s = this.latest!;
    const key = `${s.epoch ?? ''}:${s.version}`;
    if (this.given.get(viewer.id) === key) return;
    this.given.set(viewer.id, key);
    viewer.send(s);
  }
}
