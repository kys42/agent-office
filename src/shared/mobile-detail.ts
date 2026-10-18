import type { MobileDetail } from './mobile';

export const MOBILE_EVENT_LIMIT = 400;
export const MOBILE_TEXT_LIMIT = 512000;
/** Keep the most recent contiguous window, bounded by text size as well as event count. */
export function boundMobileDetail(detail: MobileDetail): MobileDetail {
  let start = detail.events.length,
    chars = 0;
  while (start > 0 && detail.events.length - start < MOBILE_EVENT_LIMIT) {
    const size = detail.events[start - 1].text.length;
    if (start < detail.events.length && chars + size > MOBILE_TEXT_LIMIT) break;
    chars += size;
    start--;
  }
  return start
    ? { ...detail, events: detail.events.slice(start), older: true, capped: true }
    : detail;
}
