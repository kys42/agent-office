import { PetAppearanceContext } from './PetAppearanceContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useTerminalSend } from '../lib/useTerminalSend';
import type { CardTarget, ZoneRule } from '../shared/types';
import { Inspector } from './Inspector';
import { useI18n } from '../lib/i18n';
import { NoticePagingContext } from '../lib/notice-paging';

/**
 * The dock card window: a colleague's card opened at a desk or bubble of the desk pet / row.
 * Same office core and the very same card as the big office's right panel — only the frame
 * differs: it closes on Esc or when the person clicks elsewhere, and "전체 모드" moves to the
 * big office on that colleague.
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
  const { snapshot, model, setPrefs, patch, pin, receipt, readAll, returnToOffice } = useOffice(
    false,
    notify,
  );
  const send = useTerminalSend(false, notify);
  const [target, setTarget] = useState<CardTarget | null>(null);
  // Bumped on every open so the card jumps to news again even for the same colleague.
  const [opened, setOpened] = useState(0);
  const { reload } = send;
  useEffect(
    () =>
      api.onCard?.((next) => {
        // null: the card was put away. Showing nothing stops background detail polling and
        // keeps the next open from flashing the previous colleague.
        setTarget(next);
        if (!next) return;
        setOpened(Date.now());
        reload(); // the setting may have changed in the big office meanwhile
      }),
    [reload],
  );
  useEffect(() => {
    document.body.classList.add('card-mode');
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // In a field, Esc leaves the field first, as in the big office.
      const field =
        e.target instanceof Element ? e.target.closest('input, textarea, select') : null;
      if (field instanceof HTMLElement) field.blur();
      else void api.card?.('close');
    };
    window.addEventListener('keydown', key);
    return () => {
      document.body.classList.remove('card-mode');
      window.removeEventListener('keydown', key);
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
          onSelect={(id) => setTarget({ id, news: false })}
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
