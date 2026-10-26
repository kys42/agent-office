import { MiniShellDock } from './MiniShell';
import { PetAppearanceContext } from './PetAppearanceContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useTerminalSend } from '../lib/useTerminalSend';
import type { CardTarget, CardWindowState, ZoneRule } from '../shared/types';
import type { BookmarkFocus } from '../shared/bookmarks';
import { Inspector } from './Inspector';
import { useI18n } from '../lib/i18n';
import { NoticePagingContext } from '../lib/notice-paging';
import { cardReadSettings } from '../shared/card-reads';

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
  const targetRef = useRef<CardTarget | null>(null);
  const [bookmarkFocus, setBookmarkFocus] = useState<BookmarkFocus | null>(null);
  const focusSerial = useRef(0);
  const receivedTarget = useRef(false);
  const [opened, setOpened] = useState(0);
  const { reload } = send;
  const acceptTarget = useCallback(
    (next: CardTarget | null) => {
      receivedTarget.current = true;
      const previous = targetRef.current;
      targetRef.current = next;
      setTarget(next);
      setBookmarkFocus(
        next?.bookmark
          ? {
              sessionId: next.id,
              eventId: next.bookmark.eventId,
              at: next.bookmark.at,
              key: ++focusSerial.current,
            }
          : null,
      );
      if (!next) return;
      // A bookmark in the same card preserves notes and the pages already read.
      if (previous?.id !== next.id || previous.news !== next.news) setOpened((n) => n + 1);
      reload();
    },
    [reload],
  );
  const [windowState, setWindowState] = useState<CardWindowState>({
    pinned: false,
    positionRemembered: false,
  });
  const [windowBusy, setWindowBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const stop = api.onCardState?.((state) => {
      if (active) setWindowState(state);
    });
    void api
      .cardState?.()
      .then((state) => {
        if (!active) return;
        setWindowState(state);
        if (!receivedTarget.current && state.target !== undefined) acceptTarget(state.target);
      })
      .catch((e) => notify(e.message));
    return () => {
      active = false;
      stop?.();
    };
  }, [notify, acceptTarget]);
  const changeWindow = async (action: 'pin-on' | 'pin-off' | 'position-on' | 'position-off') => {
    setWindowBusy(true);
    try {
      await api.card?.(action);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setWindowBusy(false);
    }
  };
  const select = (next: CardTarget) => {
    void api.card?.('select', next).catch((e) => notify(e.message));
  };
  useEffect(() => api.onCard?.(acceptTarget), [acceptTarget]);
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
          onSelect={(id) => select({ id, news: false })}
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
          reading={cardReadSettings(prefs)}
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
          onOpenBookmark={(b) =>
            select({ id: b.sessionId, news: false, bookmark: { eventId: b.eventId, at: b.at } })
          }
          focus={bookmarkFocus}
          onFocused={() => setBookmarkFocus(null)}
          movable
          cardPinned={windowState.pinned}
          positionRemembered={windowState.positionRemembered}
          windowBusy={windowBusy}
          onCardPin={(on) => void changeWindow(on ? 'pin-on' : 'pin-off')}
          onPositionRemember={(on) => void changeWindow(on ? 'position-on' : 'position-off')}
        />
      ) : (
        <div className="dock-card-empty">
          <p>{snapshot ? t.dock.card.missing : t.dock.card.opening}</p>
          <button className="button subtle" onClick={close}>
            {t.app.close}
          </button>
        </div>
      )}
      <MiniShellDock privacy={prefs?.privacy ?? false} />
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
