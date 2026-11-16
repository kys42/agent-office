import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Forward, X } from 'lucide-react';
import type { Session } from '../shared/types';
import { formatBubbles, handedText, REPLY_MAX, type SharedBubble } from '../shared/bubble-share';
import { sessionName } from '../shared/office';
import { intlLocale } from '../shared/i18n';
import { writeClipboard } from '../lib/clipboard';
import { addToComposerDraft, replyDraftKey } from '../lib/useComposerDraft';
import { useI18n } from '../lib/i18n';
import { menuItems, moveInMenu } from './CardMenu';
import { Sprite } from './Sprite';

/**
 * Takes the chat box's place while bubbles are being picked (#377): how many, [Copy N], [Send to
 * a teammate] and [Cancel]. Copying puts them on the clipboard; handing on puts them, under one
 * line saying where they came from, after that colleague's unsent draft and opens its card —
 * never sent from here. Esc closes the teammate list first, then stops picking (never also the
 * card).
 */
export function BubbleShareBar({
  bubbles,
  waiting,
  from,
  targets,
  handBlock,
  demo,
  notify,
  onHanded,
  onDone,
}: {
  /** The run's bubbles, in order. */
  bubbles: SharedBubble[];
  /** Only the start is picked so far: the end is asked for. */
  waiting: boolean;
  /** Whose conversation the bubbles come from, as the office names it. */
  from: string;
  targets: Session[];
  /** Why handing on is not possible here (the setting is off, nobody can take it); else empty. */
  handBlock: string;
  demo: boolean;
  notify: (message: string) => void;
  /** The bubbles are in that colleague's chat box: open its card. */
  onHanded: (id: string) => void;
  /** Done (copied, handed on) or cancelled: picking stops. */
  onDone: () => void;
}) {
  const { t } = useI18n();
  const share = t.conversation.share;
  const count = bubbles.length;
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const handed = useMemo(
    () => handedText(share.from(from), formatBubbles(bubbles)),
    [share, from, bubbles],
  );
  const tooLong = share.tooLong(REPLY_MAX.toLocaleString(intlLocale()));
  // Too long is said under the bar (fewer bubbles fix it); the rest on the button.
  const over = !handBlock && handed.length > REPLY_MAX;
  const blocked = handBlock || (over ? tooLong : '');
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // Another menu open (the card's, a bubble's) closes on its own first.
      if (!open && (e.target as Element | null)?.closest?.('[role="menu"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!open) return onDone();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, onDone]);
  useEffect(() => {
    if (!open) return;
    menuItems(list.current)[0]?.focus();
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!list.current?.contains(at) && !trigger.current?.contains(at)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const copy = () =>
    writeClipboard(formatBubbles(bubbles))
      .then(() => {
        notify(share.copied(count));
        onDone();
      })
      .catch(() => notify(t.conversation.copyFailed));
  const hand = (to: Session) => {
    setOpen(false);
    // After what that colleague already wrote; nothing changes when the two would not fit.
    if (!addToComposerDraft(replyDraftKey(to.id, demo), handed)) return notify(tooLong);
    onDone();
    notify(share.handed(sessionName(to)));
    onHanded(to.id);
  };
  return (
    <div className="bubble-share-bar" role="toolbar" aria-label={share.barLabel}>
      <p className="bubble-share-status" role="status">
        {!count ? (
          share.startHidden
        ) : (
          <>
            <b>{share.count(count)}</b>
            {waiting && <span> · {share.pickEnd}</span>}
          </>
        )}
      </p>
      <div className="bubble-share-actions">
        <button className="card-action primary" disabled={!count} onClick={() => void copy()}>
          <Copy size={13} />
          {share.copy(count)}
        </button>
        <div className="bubble-share-hand">
          <button
            ref={trigger}
            className="card-action"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={!count || !!blocked}
            data-tip={blocked || undefined}
            onClick={() => setOpen((v) => !v)}
          >
            <Forward size={13} />
            {share.handTo}
          </button>
          {open && (
            <div
              ref={list}
              className="card-menu-list bubble-share-targets"
              role="menu"
              aria-label={share.handToLabel}
              onKeyDown={(e) => {
                if (e.key === 'Tab') setOpen(false);
                moveInMenu(e, menuItems(list.current));
              }}
            >
              {targets.map((s) => (
                <button role="menuitem" key={s.id} onClick={() => hand(s)}>
                  <span className={`bubble-share-face face-${s.provider}`}>
                    <Sprite session={s} provider={s.provider} mood={s.status} size={20} />
                  </span>
                  <span className="bubble-share-who">
                    <b>{sessionName(s)}</b>
                    <small>{s.area ? s.area.name : s.project}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="card-action" onClick={onDone}>
          <X size={13} />
          {share.cancel}
        </button>
      </div>
      {over && count > 0 && <small className="bubble-share-note">{tooLong}</small>}
    </div>
  );
}
