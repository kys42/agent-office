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
}

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
      client.close();
      throw new Error(m().shell.gone);
    }
    client.onOutput((id, data) => id === session && sink.data(viewId, data));
    client.onResync(
      (id, restore) =>
        id === session && sink.resync(viewId, restoreSequence(restore), restore.cols, restore.rows),
    );
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
      client.close();
      throw error;
    }
    const restore = restoreSequence(result);
    const answer = { viewId, restore, cols: result.cols, rows: result.rows };
    if (result.exit || stale()) {
      // Ended already (its last screen is shown), or the window left meanwhile.
      client.close();
      if (stale()) throw new Error(m().shell.gone);
      return { ...answer, exited: { code: result.exit!.code, signal: result.exit!.signal } };
    }
    this.views.set(viewId, { owner, session, client });
    // Draw again at the view's size: the program repaints what a snapshot cannot hold.
    void (async () => {
      for (const next of nudgeSizes(result, size))
        await client.resize(session, next.cols, next.rows).catch(() => undefined);
    })();
    return answer;
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
    if (view) void view.client.resize(view.session, cols, rows).catch(() => undefined);
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
    // Closing the connection detaches it in the daemon.
    view.client.close();
  }

  /** Quitting the app: every view ends, every session keeps running. */
  dispose() {
    for (const id of [...this.views.keys()]) this.end(id);
  }

  get count() {
    return this.views.size;
  }
}
