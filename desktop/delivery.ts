import type { Snapshot } from '../src/shared/types.js';
import {
  applyPatch,
  type SnapshotMessage,
  type SnapshotPatch,
} from '../src/shared/snapshot-patch.js';

/** A window that can show the office: whether it is on screen, and how to hand it the office. */
export interface Viewer {
  readonly id: number;
  shown(): boolean;
  send(message: SnapshotMessage): void;
}
const versionOf = (s: Snapshot) => `${s.epoch ?? ''}:${s.version}`;

/**
 * Hands the office only to windows on screen. A window that holds the version a change starts
 * from gets just the change; any other window on screen gets the whole office. A hidden window
 * (the big office behind the desk pet, a put-away card) gets nothing while hidden and the latest
 * office once, when it shows again — never each change it missed.
 */
export class SnapshotDelivery {
  latest: Snapshot | null = null;
  private given = new Map<number, string>();
  /** A whole office from the collector. */
  publish(snapshot: Snapshot, viewers: Viewer[]) {
    this.latest = snapshot;
    for (const v of viewers) if (v.shown()) this.give(v);
  }
  /**
   * A change from the collector. False when it does not start from the office held here (the
   * caller then fetches the whole office).
   */
  update(patch: SnapshotPatch, viewers: Viewer[]): boolean {
    const held = this.latest;
    if (!held || held.epoch !== patch.epoch || held.version !== patch.base) return false;
    const from = versionOf(held);
    this.latest = applyPatch(held, patch);
    for (const v of viewers) {
      if (!v.shown()) continue;
      if (this.given.get(v.id) !== from) this.give(v);
      else {
        this.given.set(v.id, versionOf(this.latest));
        v.send(patch);
      }
    }
    return true;
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
    if (this.given.get(viewer.id) === versionOf(s)) return;
    this.given.set(viewer.id, versionOf(s));
    viewer.send(s);
  }
}
