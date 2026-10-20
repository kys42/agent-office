import { useEffect, useRef, useState } from 'react';
import type { OfficeNotice } from '../shared/types';
import { CARD_READ_DWELL_MS, CardReads } from '../shared/card-reads';
import { isPageShown, onPageVisibility } from './visibility';
import type { ReceiptAction } from './useOffice';

/** Resolves `false` (or throws) when the receipt was not recorded. */
type Receipts = (receipts: { id: string; version: string }[], action: ReceiptAction) => unknown;

/**
 * A colleague's work card that the person is looking at reads that colleague's final replies,
 * once it has stayed on that colleague in sight for `CARD_READ_DWELL_MS` (J/K stepping past does
 * not read), and then each new one as it arrives. Every window then drops the same blue marks
 * from the snapshot it receives. Calls and errors are not read here. `enabled` is false while
 * the card shows no conversation (privacy) or before the person touched a restored card.
 *
 * Returns the versions this open read, which the card keeps listing in its news.
 */
export function useReadOnOpen(
  colleague: string,
  notices: OfficeNotice[],
  memberIds: string[],
  onReceipt: Receipts,
  enabled = true,
): ReadonlySet<string> {
  const [shown, setShown] = useState(isPageShown);
  useEffect(() => {
    setShown(isPageShown());
    return onPageVisibility(() => setShown(isPageShown()));
  }, []);
  const reads = useRef(new CardReads(colleague));
  if (reads.current.colleague !== colleague) reads.current = new CardReads(colleague);
  // What is read now (here or elsewhere) is never read again by this open: '다시 미확인' sticks.
  reads.current.observe(notices, memberIds);
  const looking = enabled && shown;
  const [dwelled, setDwelled] = useState<string | null>(null);
  useEffect(() => {
    setDwelled(null);
    if (!looking) return;
    const timer = setTimeout(() => setDwelled(colleague), CARD_READ_DWELL_MS);
    return () => clearTimeout(timer);
  }, [looking, colleague]);
  const [, setSettled] = useState(0);
  const members = memberIds.join('\n');
  useEffect(() => {
    if (!looking || dwelled !== colleague) return;
    const current = reads.current;
    const due = current.due(notices, memberIds).map(({ id, version }) => ({ id, version }));
    if (!due.length) return;
    current.begin(due);
    // A failed receipt is asked again on a later snapshot or visibility change.
    void Promise.resolve()
      .then(() => onReceipt(due, 'read'))
      .then(
        (result) => result !== false,
        () => false,
      )
      .then((ok) => {
        current.settle(due, ok);
        if (ok) setSettled((n) => n + 1);
      });
  }, [looking, dwelled, colleague, members, notices]);
  return reads.current.readNow;
}
