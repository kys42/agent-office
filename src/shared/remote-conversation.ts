/** Shared by every remote reader (desktop, mobile and the exporter). */
export const REMOTE_EVENT_LIMIT = 180;
export const REMOTE_TEXT_LIMIT = 512000;
export function remoteEventWindow<T extends { text: string }>(events: T[]): T[] {
  let chars = 0,
    start = events.length;
  while (start > 0 && events.length - start < REMOTE_EVENT_LIMIT) {
    const size = events[start - 1].text.length;
    if (chars + size > REMOTE_TEXT_LIMIT) break;
    chars += size;
    start--;
  }
  return start ? events.slice(start) : events;
}
