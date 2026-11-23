import { randomUUID } from 'node:crypto';
import { m } from '../src/shared/i18n/index.js';
import { nudgeSizes, TERM_VIEW_SCROLLBACK, type TermAttachment } from '../src/shared/term-view.js';
import type { TermHostClient } from './term-host/client.js';
import { restoreSequence, type ExitInfo } from './term-host/protocol.js';

/**
 * The built-in terminal's views (#401): each window that shows a session has its own connection
 * to the daemon, so two windows on one session never take output from each other, and each
 * gets the daemon's flow control on its own (a slow window is paused, then sent a fresh screen).
 * The window only draws; nothing here knows an agent.
 *
 * - attach: the screen as it is now (`restoreSequence`), then live output; the size is nudged
 *   once so the program draws its screen again (`nudgeSizes`).
 * - resync (the view fell behind and the daemon sent a fresh screen): nudged the same way. A
 *   serialized screen lacks what the program keeps relying on (a saved cursor, character sets),
 *   and its next frames, drawn relative to that, would land in the wrong place until a resize.
 * - sizes: one view's resizes and nudges go out one after another, and a nudge ends on the size
 *   the window asked for last, so a nudge never undoes a newer resize.
 * - detach (the window hid, reloaded or closed): the connection ends; the session keeps running
 *   in the daemon, and nothing streams to a view nobody sees.
 */

/** Where a view's output goes (the window that attached it). */
export interface TermViewSink {
  data(viewId: string, data: Uint8Array): void;
  /**
   * The view fell behind: clear it and draw this instead, at the size it was taken (output
   * resumes after it).
   */
  resync(viewId: string, restore: string, cols: number, rows: number): void;
  exit(viewId: string, exit: ExitInfo): void;
  /** Its connection to the daemon closed while the session did not end (the daemon stopped). */
  lost(viewId: string): void;
}

export interface TermViewDeps {
  /** A connection to the running daemon (never starts one: a view needs a session there). */
  connect(): Promise<TermHostClient>;
  newId?: () => string;
}

interface View {
  owner: number;
  session: string;
  client: TermHostClient;
  /** The size the window asked for last. */
  size: { cols: number; rows: number };
  /** Resizes sent for this view, in order. */
  resizing: Promise<unknown>;
  /** A redraw after a fresh screen is waiting (at most one at a time, see `RESYNC_REDRAW_MS`). */
  redrawTimer: ReturnType<typeof setTimeout> | null;
  lastRedraw: number;
}

/**
 * Redraws asked by fresh screens are at least this far apart: a program redrawing everything on
 * a resize must not keep a view that is far behind falling behind again.
 */
export const RESYNC_REDRAW_MS = 1000;

export class TermViews {
  private views = new Map<string, View>();
  /** Bumped when a window closes or reloads: an attach still in flight for it is dropped. */
  private epochs = new Map<number, number>();

  constructor(private deps: TermViewDeps) {}

  /** The window's current lifetime; capture it before any await of a request it made. */
  epoch(owner: number) {
    return this.epochs.get(owner) ?? 0;
  }

  /** Attaches `owner` to `session` through a connection of its own. */
  async attach(
    owner: number,
    session: string,
    size: { cols: number; rows: number },
    sink: TermViewSink,
    since = this.epoch(owner),
  ): Promise<TermAttachment> {
    const client = await this.deps.connect();
    const viewId = (this.deps.newId ?? randomUUID)();
    const stale = () => this.epoch(owner) !== since;
    if (stale()) {
      client.destroy();
      throw new Error(m().shell.gone);
    }
    client.onOutput((id, data) => id === session && sink.data(viewId, data));
    client.onResync((id, restore) => {
      if (id !== session) return;
      sink.resync(viewId, restoreSequence(restore), restore.cols, restore.rows);
      this.redrawSoon(viewId);
    });
    client.onExit((id, exit) => {
      if (id !== session) return;
      sink.exit(viewId, exit);
      this.end(viewId);
    });
    // Closed by anything but this view's own end (a detach, the window leaving, an exit): the
    // window must know, or it would keep typing into nothing.
    client.onClose(() => {
      if (this.views.delete(viewId)) sink.lost(viewId);
    });
    let result;
    try {
      result = await client.attach(session, { scrollback: TERM_VIEW_SCROLLBACK });
    } catch (error) {
      client.destroy();
      throw error;
    }
    const restore = restoreSequence(result);
    const answer = { viewId, restore, cols: result.cols, rows: result.rows };
    if (result.exit || stale()) {
      // Ended already (its last screen is shown), or the window left meanwhile.
      client.destroy();
      if (stale()) throw new Error(m().shell.gone);
      return { ...answer, exited: { code: result.exit!.code, signal: result.exit!.signal } };
    }
    const view: View = {
      owner,
      session,
      client,
      size,
      resizing: Promise.resolve(),
      redrawTimer: null,
      lastRedraw: 0,
    };
    this.views.set(viewId, view);
    // Draw again at the view's size: the program repaints what a snapshot cannot hold.
    this.nudge(view, result);
    return answer;
  }

  /**
   * Resizes the session so its program draws again (see `nudgeSizes`), from the size the screen
   * was drawn at. The last step is the window's size when it is sent, not when it was queued.
   */
  private nudge(view: View, drawn: { cols: number; rows: number }) {
    const steps = nudgeSizes(drawn, view.size);
    steps.forEach((step, i) => this.sendSize(view, i === steps.length - 1 ? null : step));
  }

  /** Queues one resize of this view's session; `null` is the window's size at sending time. */
  private sendSize(view: View, size: { cols: number; rows: number } | null) {
    view.resizing = view.resizing.then(() => {
      const next = size ?? view.size;
      return view.client.resize(view.session, next.cols, next.rows).catch(() => undefined);
    });
  }

  /** After a fresh screen: one nudge now, or once `RESYNC_REDRAW_MS` has passed since the last. */
  private redrawSoon(viewId: string) {
    const view = this.views.get(viewId);
    if (!view || view.redrawTimer) return;
    const wait = Math.max(0, view.lastRedraw + RESYNC_REDRAW_MS - Date.now());
    view.redrawTimer = setTimeout(() => {
      view.redrawTimer = null;
      if (this.views.get(viewId) !== view) return;
      view.lastRedraw = Date.now();
      // Same size both ways: one row smaller and back.
      this.nudge(view, view.size);
    }, wait);
  }

  private own(owner: number, viewId: string) {
    const view = this.views.get(viewId);
    return view && view.owner === owner ? view : null;
  }

  /** Keystrokes from the window that owns this view; anything else is dropped. */
  write(owner: number, viewId: string, data: string) {
    const view = this.own(owner, viewId);
    if (!view) return;
    try {
      view.client.write(view.session, data);
    } catch {
      /* the connection just closed */
    }
  }

  resize(owner: number, viewId: string, cols: number, rows: number) {
    const view = this.own(owner, viewId);
    if (!view) return;
    view.size = { cols, rows };
    this.sendSize(view, null);
  }

  /** Pauses or resumes reading this view's output (its window is behind / caught up). */
  flow(owner: number, viewId: string, paused: boolean) {
    this.own(owner, viewId)?.client.pauseReading(paused);
  }

  /** Ends this window's view only; the session keeps running. */
  detach(owner: number, viewId: string) {
    if (this.own(owner, viewId)) this.end(viewId);
  }

  /** A window closed or reloaded: its views go, the sessions stay. */
  detachOwner(owner: number) {
    this.epochs.set(owner, this.epoch(owner) + 1);
    for (const [id, view] of this.views) if (view.owner === owner) this.end(id);
  }

  private end(viewId: string) {
    const view = this.views.get(viewId);
    if (!view) return;
    this.views.delete(viewId);
    if (view.redrawTimer) clearTimeout(view.redrawTimer);
    // Closing the connection detaches it in the daemon.
    // Destroyed, not ended: a paused view leaves unread output that a graceful end would wait
    // on, keeping the daemon's side open (and attached) for good.
    view.client.destroy();
  }

  /** Quitting the app: every view ends, every session keeps running. */
  dispose() {
    for (const id of [...this.views.keys()]) this.end(id);
  }

  get count() {
    return this.views.size;
  }
}
