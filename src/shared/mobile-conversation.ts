import { LOADED_EVENTS } from './conversation-pages';
import type { MobileDetail } from './mobile';

/** Same resident event budget as a desktop card; older records remain on the server. */
export interface MobileConversation extends MobileDetail {
  newer: boolean;
}

export function newestMobilePage(
  old: MobileConversation | null,
  page: MobileDetail,
  remote = false,
): MobileConversation {
  if (remote)
    return { ...page, events: page.events.slice(-LOADED_EVENTS), older: false, newer: false };
  const head = page.events[0];
  const joins =
    old?.id === page.id && page.older && head
      ? old.events.findIndex((event) => event.id === head.id)
      : -1;
  const all = joins >= 0 && old ? [...old.events.slice(0, joins), ...page.events] : page.events;
  return {
    ...page,
    events: all.slice(-LOADED_EVENTS),
    older: (joins >= 0 && old ? old.older : page.older) || all.length > LOADED_EVENTS,
    newer: false,
  };
}

export function olderMobilePage(old: MobileConversation, page: MobileDetail): MobileConversation {
  if (old.id !== page.id) return old;
  // Stored ordering breaks equal-time ties; the loaded copy of a duplicate wins.
  const all = [
    ...new Map([...page.events, ...old.events].map((event) => [event.id, event])).values(),
  ];
  return {
    ...page,
    events: all.slice(0, LOADED_EVENTS),
    newer: old.newer || all.length > LOADED_EVENTS,
  };
}
