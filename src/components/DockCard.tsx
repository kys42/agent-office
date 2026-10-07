import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useOffice } from '../lib/useOffice';
import { useTerminalSend } from '../lib/useTerminalSend';
import type { CardTarget, ZoneRule } from '../shared/types';
import { Inspector } from './Inspector';

/**
 * The dock card window: a colleague's card opened at a desk or bubble of the desk pet / row.
 * Same office core and the very same card as the big office's right panel — only the frame
 * differs: it closes on Esc or when the person clicks elsewhere, and "전체 모드" moves to the
 * big office on that colleague.
 */
export function DockCard() {
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 3600);
  }, []);
  const { snapshot, model, setPrefs, patch, receipt, returnToOffice } = useOffice(false, notify);
  const send = useTerminalSend(false, notify);
  const [target, setTarget] = useState<CardTarget | null>(null);
  // Bumped on every open so the card jumps to news again even for the same colleague.
  const [opened, setOpened] = useState(0);
  const { reload } = send;
  useEffect(
    () =>
      api.onCard?.((next) => {
        setTarget(next);
        setOpened(Date.now());
        reload(); // the opt-in may have changed in the big office meanwhile
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
  return (
    <div className="dock-card">
      {session && target ? (
        <Inspector
          key={session.id}
          session={session}
          sessions={sessions}
          notices={snapshot?.notices ?? []}
          memberIds={model.ownerOf(session.id)?.resident?.sessionIds ?? [session.id]}
          onReceipt={receipt}
          onSelect={(id) => setTarget({ id, news: false })}
          showNews={target.news ? `${session.id}:${opened}` : null}
          onClose={close}
          onExpand={() => void api.card?.('expand', { id: session.id, news: false })}
          onPatch={patch}
          onReturn={returnToOffice}
          notify={notify}
          demo={false}
          privacy={prefs?.privacy ?? false}
          zoneRules={prefs?.zoneRules ?? []}
          onZoneRules={async (zoneRules: ZoneRule[]) => {
            if (await setPrefs({ zoneRules })) notify('사무실 구역을 다시 나눴어요');
          }}
          terminalSend={send.enabled}
        />
      ) : (
        <div className="dock-card-empty">
          <p>{snapshot ? '이 동료를 찾지 못했어요' : '업무 카드를 여는 중…'}</p>
          <button className="button subtle" onClick={close}>
            닫기
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
}
