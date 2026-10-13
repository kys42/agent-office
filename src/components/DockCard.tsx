import { PetAppearanceContext } from './PetAppearanceContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useTerminalSend } from '../lib/useTerminalSend';
import type { CardTarget, ZoneRule } from '../shared/types';
import type { BookmarkFocus } from '../shared/bookmarks';
import { Inspector } from './Inspector';
import { useI18n } from '../lib/i18n';
import { NoticePagingContext } from '../lib/notice-paging';

/**
 * The dock card window: a colleague's card opened at a desk or bubble of the desk pet / row.
 * Same office core and the very same card as the big office's right column — only the frame
 * differs: it is moved by its header, closes on Esc or when the person clicks elsewhere, and
 * "전체 모드" moves to the big office on that colleague.
 */
export function DockCard() {
  const { t } = useI18n();
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 3600);
  }, []);
  const {
    snapshot,
    model,
    setPrefs,
    patch,
    pin,
    receipt,
    readAll,
    returnToOffice,
    bookmark,
    unbookmark,
  } = useOffice(false, notify);
  const send = useTerminalSend(false, notify);
  const [target, setTarget] = useState<CardTarget | null>(null);
  const [bookmarkFocus, setBookmarkFocus] = useState<BookmarkFocus | null>(null);
  // Stay open when clicking elsewhere (the card's own toggle, remembered on this computer).
  const [keepOpen, setKeepOpen] = useState(() => {
    try {
      return localStorage.getItem('office:card-keep') === 'on';
    } catch {
      return false;
    }
  });
  // The main process starts out closing on blur, so 'off' is only said after an 'on'.
  const keepSaid = useRef(false);
  useEffect(() => {
    if (!keepOpen && !keepSaid.current) return;
    keepSaid.current = keepOpen;
    void api.card?.(keepOpen ? 'keep-on' : 'keep-off');
  }, [keepOpen, target?.id]);
  // Bumped on every open so the card jumps to news again even for the same colleague.
  const [opened, setOpened] = useState(0);
  const { reload } = send;
  useEffect(
    () =>
      api.onCard?.((next) => {
        // null: the card was put away. Showing nothing stops background detail polling and
        // keeps the next open from flashing the previous colleague.
        setBookmarkFocus(null);
        setTarget(next);
        if (!next) return;
        setOpened(Date.now());
        reload(); // the setting may have changed in the big office meanwhile
      }),
    [reload],
  );
  useEffect(() => {
    document.body.classList.add('card-mode');
    // On a Mac the window is vibrant glass (desktop/main.ts): the page lets it show through.
    document.body.classList.toggle('is-mac', /Mac/i.test(navigator.userAgent));
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // In a field, Esc leaves the field first, as in the big office.
      const field =
        e.target instanceof Element ? e.target.closest('input, textarea, select') : null;
      if (field instanceof HTMLElement) field.blur();
      else void api.card?.('close');
    };
    // A press on a text box asks for the keyboard: after another app was used (the card kept
    // open, or a jump to the terminal) the caret would blink while keys go to that app.
    const press = (e: PointerEvent) => {
      const field =
        e.target instanceof Element ? e.target.closest('input, textarea, [contenteditable]') : null;
      if (field) void api.card?.('focus');
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', press, true);
    return () => {
      document.body.classList.remove('card-mode');
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', press, true);
    };
  }, []);
  const sessions = snapshot?.sessions ?? [];
  const session = target ? sessions.find((s) => s.id === target.id) : undefined;
  const prefs = snapshot?.preferences;
  const close = () => void api.card?.('close');
  const content = (
    <div className="dock-card">
      {session && target ? (
        <Inspector
          onPrefs={setPrefs}
          // A fresh card per open: a desk opens on the conversation even after a bubble chose news.
          key={`${session.id}:${opened}`}
          session={session}
          sessions={sessions}
          notices={snapshot?.notices ?? []}
          memberIds={model.ownerOf(session.id)?.resident?.sessionIds ?? [session.id]}
          resident={model.ownerOf(session.id)}
          onReceipt={receipt}
          onSelect={(id) => {
            setBookmarkFocus(null);
            setTarget({ id, news: false });
            void api.card?.('select', { id, news: false });
          }}
          showNews={target.news ? `${session.id}:${opened}` : null}
          onClose={close}
          onExpand={() => void api.card?.('expand', { id: session.id, news: false })}
          onPatch={patch}
          onPin={(s) =>
            void pin(s)
              .then((on) => notify(on ? t.app.toast.pinned : t.app.toast.unpinned))
              .catch((e) => notify((e as Error).message))
          }
          onReturn={returnToOffice}
          notify={notify}
          demo={false}
          privacy={prefs?.privacy ?? false}
          zoneRules={prefs?.zoneRules ?? []}
          onZoneRules={async (zoneRules: ZoneRule[]) => {
            if (await setPrefs({ zoneRules })) notify(t.app.toast.zonesSaved);
          }}
          terminalSend={send.enabled}
          bookmarked={snapshot?.bookmarked?.[session.id]}
          onBookmark={bookmark}
          bookmarkMarks={snapshot?.bookmarked}
          bookmarkStamp={JSON.stringify([
            snapshot?.bookmarkStamp,
            snapshot?.bookmarked,
            prefs?.excludedProjects,
            prefs?.enabledProviders,
          ])}
          onUnbookmark={unbookmark}
          onOpenBookmark={(b) => {
            setTarget({ id: b.sessionId, news: false });
            void api.card?.('select', { id: b.sessionId, news: false });
            setBookmarkFocus({
              sessionId: b.sessionId,
              eventId: b.eventId,
              at: b.at,
              key: Date.now(),
            });
          }}
          focus={bookmarkFocus}
          onFocused={() => setBookmarkFocus(null)}
          movable
          keepOpen={keepOpen}
          onKeepOpen={(on) => {
            setKeepOpen(on);
            try {
              localStorage.setItem('office:card-keep', on ? 'on' : 'off');
            } catch {
              // Remembering is a convenience.
            }
          }}
        />
      ) : (
        <div className="dock-card-empty">
          <p>{snapshot ? t.dock.card.missing : t.dock.card.opening}</p>
          <button className="button subtle" onClick={close}>
            {t.app.close}
          </button>
        </div>
      )}
      {toast && (
        <div className="dock-card-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );

  return (
    <PetAppearanceContext.Provider value={prefs?.petAppearance}>
      <NoticePagingContext.Provider
        value={{
          paged: model.noticesPaged,
          stats: JSON.stringify(snapshot?.noticeStats ?? null),
          readAll,
        }}
      >
        {content}
      </NoticePagingContext.Provider>
    </PetAppearanceContext.Provider>
  );
}
