import type { NotifyPreferences, OfficeNotice, Preferences, Snapshot } from './types';
import { PROVIDERS } from './types';
import { isAttentionNotice, isFinalNotice } from './notices';
import { isRemoteId } from './federation';
import { messageExcerpt } from './activity';
import { buildOfficeModel } from './office-model';
import { sessionName } from './office';
import { m } from './i18n';

/**
 * OS notifications (#229): what to show when a colleague's final reply, a call or an error
 * arrives. Pure, so the main process only shows what this decides.
 *
 * By default only calls (and errors) notify, silently: a call means someone is stuck waiting on
 * the person, while finals arrive all day and would quickly become noise.
 */
export const DEFAULT_NOTIFY: NotifyPreferences = { finals: false, calls: true, sound: false };
export const notifyPreferences = (p?: Pick<Preferences, 'notifications'> | null) => ({
  ...DEFAULT_NOTIFY,
  ...p?.notifications,
});

export type NotifyKind = 'final' | 'call' | 'error';
/** One notification to show. `sessionId` is what a click opens (none: just the office). */
export interface NotifyItem {
  key: string;
  kind: NotifyKind | 'summary';
  title: string;
  body: string;
  sessionId?: string;
  silent: boolean;
  /** How many notices it stands for, and how many of them are finals. */
  count: number;
  finals: number;
}
/** Who a notice is from: its colleague's name, and every id that colleague's card shows. */
export interface Colleague {
  name: string;
  provider: string;
  ids: string[];
}
/** Where the person is looking: a notice about a colleague in front of them is not news. */
export interface NotifyFocus {
  /** The big office window is focused; `selected` is the colleague card open in it. */
  mainFocused: boolean;
  selected: string | null;
  /** Colleagues whose dock card window is on screen. */
  cards: string[];
}
/** A notice older than this when first seen is history (a long-unread one paged back in). */
export const NOTIFY_FRESH_MS = 2 * 60_000;
const key = (n: OfficeNotice) => `${n.id}@${n.version}`;
const kindOf = (n: OfficeNotice): NotifyKind | null =>
  isAttentionNotice(n)
    ? n.kind === 'error'
      ? 'error'
      : 'call'
    : isFinalNotice(n)
      ? 'final'
      : null;

export interface NotifyPlanInput {
  /** Notice keys already seen; null before the first snapshot (which only primes it). */
  seen: ReadonlySet<string> | null;
  notices: OfficeNotice[];
  prefs: Preferences;
  colleague: (sessionId: string) => Colleague | undefined;
  focus: NotifyFocus;
  now: number;
}
/**
 * The notices new since the last snapshot that should notify, and the keys seen now. Only the
 * keys still carried are kept, so the set stays as small as the snapshot's notices.
 */
export function planNotifications(input: NotifyPlanInput): {
  seen: Set<string>;
  items: NotifyItem[];
} {
  const { notices, prefs, colleague, focus, now } = input;
  const seen = new Set(notices.map(key));
  if (!input.seen) return { seen, items: [] };
  const want = notifyPreferences(prefs);
  const t = m().desktop.notify;
  const items: NotifyItem[] = [];
  for (const n of [...notices].sort((a, b) => a.at - b.at)) {
    if (input.seen.has(key(n))) continue;
    const kind = kindOf(n);
    if (!kind || (kind === 'final' ? !want.finals : !want.calls)) continue;
    // Old news, already read or put away, a helper's or a scheduled run's final, or another
    // office's (read-only here) news never notifies.
    if (n.bootstrap || n.seenAt || n.dismissedAt || now - n.receivedAt > NOTIFY_FRESH_MS) continue;
    if (kind === 'final' && n.background) continue;
    if (isRemoteId(n.id) || isRemoteId(n.sessionId)) continue;
    const who = colleague(n.sessionId);
    if (!who) continue;
    const ids = new Set(who.ids);
    if (
      (focus.mainFocused && focus.selected && ids.has(focus.selected)) ||
      focus.cards.some((id) => ids.has(id))
    )
      continue;
    const excerpt = kind === 'final' && !prefs.privacy ? messageExcerpt(n.text, 100) : '';
    items.push({
      key: key(n),
      kind,
      title: prefs.privacy ? who.provider : who.name,
      body: excerpt || (kind === 'final' ? t.final : kind === 'error' ? t.error : t.call),
      sessionId: n.sessionId,
      silent: !want.sound,
      count: 1,
      finals: kind === 'final' ? 1 : 0,
    });
  }
  return { seen, items };
}

/** Recently shown notifications, and the ones held back until the burst window ends. */
export interface NotifyThrottle {
  shown: number[];
  held: NotifyItem[];
}
export const NOTIFY_BURST = { limit: 3, windowMs: 5000 };
const summary = (items: NotifyItem[]): NotifyItem => {
  const sessions = new Set(items.map((i) => i.sessionId));
  const count = items.reduce((n, i) => n + i.count, 0);
  const finals = items.reduce((n, i) => n + i.finals, 0);
  return {
    key: `summary:${items.map((i) => i.key).join(',')}`,
    kind: 'summary',
    title: m().desktop.notify.summaryTitle,
    body: m().desktop.notify.summary(count, finals),
    sessionId: sessions.size === 1 ? items[0].sessionId : undefined,
    silent: items.every((i) => i.silent),
    count,
    finals,
  };
};
/**
 * At most `limit` notifications in any `windowMs`: a batch bigger than that becomes one summary
 * at once; anything over the limit within the window is held and later shown as one summary
 * (`flushNotifications` at `flushAt`).
 */
export function throttleNotifications(
  state: NotifyThrottle,
  items: NotifyItem[],
  now: number,
  { limit, windowMs } = NOTIFY_BURST,
): { state: NotifyThrottle; show: NotifyItem[]; flushAt?: number } {
  const shown = state.shown.filter((at) => now - at < windowMs);
  const held = [...state.held];
  const show: NotifyItem[] = [];
  const batch = items.length > limit ? [summary(items)] : items;
  for (const item of batch) {
    if (!held.length && shown.length < limit) {
      shown.push(now);
      show.push(item);
    } else held.push(item);
  }
  return {
    state: { shown, held },
    show,
    flushAt: held.length ? Math.max(now, (shown[0] ?? now) + windowMs) : undefined,
  };
}
/** The burst window ended: whatever was held, as one notification. */
export function flushNotifications(
  state: NotifyThrottle,
  now: number,
): { state: NotifyThrottle; show: NotifyItem[] } {
  if (!state.held.length) return { state, show: [] };
  const one = state.held.length === 1 ? state.held[0] : summary(state.held);
  return { state: { shown: [...state.shown, now], held: [] }, show: [one] };
}

/** Each colleague by any of its sessions, read from the same office model the windows draw. */
export function colleagueResolver(snapshot: Snapshot, now = Date.now()) {
  let model: ReturnType<typeof buildOfficeModel> | undefined;
  return (sessionId: string): Colleague | undefined => {
    model ??= buildOfficeModel(snapshot, now);
    const view = model.view(sessionId);
    const s = view?.session ?? snapshot.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const ids = [sessionId, s.id, ...(s.resident?.sessionIds ?? [])];
    // A helper also shows on its host's card.
    if (s.attachedTo)
      ids.push(s.attachedTo, ...(model.view(s.attachedTo)?.session.resident?.sessionIds ?? []));
    return { name: sessionName(s), provider: PROVIDERS[s.provider]?.short ?? s.provider, ids };
  };
}
