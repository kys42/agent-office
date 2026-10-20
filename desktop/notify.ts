import { Notification } from 'electron';
import type { Snapshot } from '../src/shared/types.js';
import {
  colleagueResolver,
  flushNotifications,
  notifyReady,
  planNotifications,
  revalidateNotifications,
  throttleNotifications,
  type NotifyContext,
  type NotifyFocus,
  type NotifyItem,
  type NotifyThrottle,
} from '../src/shared/notify-plan.js';

/** What a test run (quiet mode) sees instead of real notifications: each one and its click. */
export interface RecordedNotification extends NotifyItem {
  click: () => void;
}

/**
 * OS notifications (#229) through Electron's Notification (macOS Notification Center, Windows
 * toasts). It watches every office the main process hands its windows; `notify-plan` decides
 * what is news, this only shows it and opens the colleague on a click.
 */
export class Notifier {
  private seen: Set<string> | null = null;
  private readonly startedAt = Date.now();
  private firstAt: number | null = null;
  private ready = false;
  private latest: Snapshot | null = null;
  private throttle: NotifyThrottle = { shown: [], held: [] };
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Electron drops a notification's click handler once nothing references it.
  private live = new Set<Notification>();
  readonly recorded: RecordedNotification[] = [];

  constructor(
    private options: {
      focus: () => NotifyFocus;
      open: (sessionId?: string) => void;
      /** Record instead of showing (quiet test runs never put anything on the screen). */
      record: boolean;
    },
  ) {}

  private context(snapshot: Snapshot, now: number): NotifyContext {
    return {
      notices: snapshot.notices ?? [],
      prefs: snapshot.preferences,
      colleague: colleagueResolver(snapshot, now),
      focus: this.options.focus(),
      now,
    };
  }

  observe(snapshot: Snapshot) {
    const now = Date.now();
    this.latest = snapshot;
    this.firstAt ??= now;
    // The first snapshot always only primes; after that, startup keeps priming until
    // `notifyReady` (the backlog never bursts out when the app opens).
    this.ready ||= this.seen !== null && notifyReady(snapshot, this.startedAt, this.firstAt, now);
    const { seen, items } = planNotifications({
      ...this.context(snapshot, now),
      seen: this.ready ? this.seen : null,
    });
    this.seen = seen;
    if (!items.length) return;
    const next = throttleNotifications(this.throttle, items, now);
    this.throttle = next.state;
    next.show.forEach((item) => this.show(item));
    if (next.flushAt !== undefined && !this.timer)
      this.timer = setTimeout(() => this.flush(), next.flushAt - now);
  }

  private flush() {
    this.timer = undefined;
    const now = Date.now();
    const latest = this.latest;
    // What waited is checked again against the office and settings now.
    const next = flushNotifications(this.throttle, now, (items) =>
      latest ? revalidateNotifications(items, this.context(latest, now)) : [],
    );
    this.throttle = next.state;
    next.show.forEach((item) => this.show(item));
  }

  private show(item: NotifyItem) {
    const click = () => this.options.open(item.sessionId);
    if (this.options.record) {
      this.recorded.push({ ...item, click });
      return;
    }
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: item.title, body: item.body, silent: item.silent });
    const done = () => this.live.delete(n);
    n.on('click', () => {
      done();
      click();
    });
    n.on('close', done);
    n.on('failed', done);
    this.live.add(n);
    // Never hold on to more than the last few.
    for (const old of this.live) {
      if (this.live.size <= 20) break;
      this.live.delete(old);
    }
    n.show();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.live.clear();
  }
}
