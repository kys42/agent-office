// A card moving to a new window (desktop/card-windows.ts `transfer`, the open-as-window button)
// leaves what the person had open and not saved for that window to pick up: the tab and memo
// notes edited but not saved. The reply draft needs nothing: it is kept per colleague already
// (lib/useComposerDraft.ts). Pure shelf rules; lib/cardHandoff.ts keeps the shelf.

export type CardTab = 'overview' | 'history' | 'notes' | 'outputs';
const TABS: readonly unknown[] = ['overview', 'history', 'notes', 'outputs'] satisfies CardTab[];

/** What a card leaves for its next window. */
export interface CardHandoff {
  /** Whose card. */
  id: string;
  tab: CardTab;
  /** Memo notes edited and not saved; absent when there are none. */
  notes?: string;
  at: number;
}
/** Long enough for the new window to load; a hand-off left over after that is stale. */
export const CARD_HANDOFF_MS = 20_000;
/** As the notes box allows. */
const NOTES_MAX = 12_000;

export type HandoffShelf = Record<string, CardHandoff>;

/** The shelf as stored: only well-formed hand-offs still fresh at `now`, never trusted. */
export function readHandoffShelf(raw: unknown, now: number): HandoffShelf {
  const shelf: HandoffShelf = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return shelf;
  for (const [id, h] of Object.entries(raw as Record<string, Record<string, unknown> | null>)) {
    if (
      !h ||
      h.id !== id ||
      !id.length ||
      id.length > 400 ||
      !TABS.includes(h.tab) ||
      (h.notes !== undefined && (typeof h.notes !== 'string' || h.notes.length > NOTES_MAX)) ||
      typeof h.at !== 'number' ||
      !(Math.abs(now - h.at) < CARD_HANDOFF_MS)
    )
      continue;
    shelf[id] = {
      id,
      tab: h.tab as CardTab,
      ...(typeof h.notes === 'string' ? { notes: h.notes } : {}),
      at: h.at,
    };
  }
  return shelf;
}

/** The shelf with `handoff` put on it, in place of that colleague's older one. */
export function shelveHandoff(raw: unknown, handoff: CardHandoff): HandoffShelf {
  return { ...readHandoffShelf(raw, handoff.at), [handoff.id]: handoff };
}

/** Takes that colleague's hand-off off the shelf (once): it, if still fresh, and what is left. */
export function takeHandoff(
  raw: unknown,
  id: string,
  now: number,
): { handoff: CardHandoff | null; rest: HandoffShelf } {
  const rest = readHandoffShelf(raw, now);
  const handoff = rest[id] ?? null;
  delete rest[id];
  return { handoff, rest };
}
