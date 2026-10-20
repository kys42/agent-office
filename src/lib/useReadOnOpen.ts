import { useEffect, useRef, useState } from 'react';
import type { OfficeNotice } from '../shared/types';
import { cardReadNotices } from '../shared/notices';
import { isPageShown, onPageVisibility } from './visibility';
import type { ReceiptAction } from './useOffice';

type Receipts = (receipts: { id: string; version: string }[], action: ReceiptAction) => unknown;

/**
 * A colleague's work card that the person is looking at reads that colleague's final replies:
 * when it opens, when it switches colleague, and when a new one arrives while it stays in
 * sight. Every window then drops the same blue marks from the snapshot it receives. Calls and
 * errors are not read here. `enabled` is false while the card shows no conversation (privacy).
 */
export function useReadOnOpen(
  colleague: string,
  notices: OfficeNotice[],
  memberIds: string[],
  onReceipt: Receipts,
  enabled = true,
) {
  const [shown, setShown] = useState(isPageShown);
  useEffect(() => {
    setShown(isPageShown());
    return onPageVisibility(() => setShown(isPageShown()));
  }, []);
  // Each notice version is read once per opened colleague, so a reply the person marked unread
  // again stays unread until the card is opened on that colleague anew.
  const sent = useRef({ colleague, keys: new Set<string>() });
  if (sent.current.colleague !== colleague) sent.current = { colleague, keys: new Set() };
  const due =
    enabled && shown
      ? cardReadNotices(notices, memberIds).filter(
          (n) => !sent.current.keys.has(`${n.id}\n${n.version}`),
        )
      : [];
  const dueKey = due.map((n) => `${n.id}\n${n.version}`).join('\n');
  useEffect(() => {
    if (!due.length) return;
    for (const n of due) sent.current.keys.add(`${n.id}\n${n.version}`);
    void onReceipt(
      due.map(({ id, version }) => ({ id, version })),
      'read',
    );
  }, [dueKey]);
}
