import { shelveHandoff, takeHandoff, type CardHandoff } from '../shared/card-handoff';

// Local storage is shared by every window of the app: the card's next window reads it there.
const KEY = 'office:card-handoff:v1';

function load(): unknown {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}
function store(shelf: Record<string, CardHandoff>) {
  try {
    if (Object.keys(shelf).length) localStorage.setItem(KEY, JSON.stringify(shelf));
    else localStorage.removeItem(KEY);
  } catch {
    // No storage: the new window opens as a fresh card.
  }
}

/** Leaves this card's open tab and unsaved notes for the window it is moving to. */
export function leaveCard(handoff: Omit<CardHandoff, 'at'>) {
  store(shelveHandoff(load(), { ...handoff, at: Date.now() }));
}

/** What a card moving here left for this window, taken once (null when nothing fresh). */
export function pickUpCard(id: string) {
  const raw = load();
  if (raw === null) return null;
  const { handoff, rest } = takeHandoff(raw, id, Date.now());
  store(rest);
  return handoff;
}
