import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { demoSnapshot, reconcileDemo } from './demo';
import { applyNoticeReceipt } from '../shared/notices';
import { officeResidents } from '../shared/residents';
import { allocateSeats, officeZone, seatKey } from '../shared/office';
import { buildOfficeModel } from '../shared/office-model';
import type { NoticeReceipt, Preferences, SessionPatch, Snapshot } from '../shared/types';

export type ReceiptAction = 'read' | 'dismiss' | 'unread' | 'view';
/** Decorative/derived time (working → resting after 2 minutes) refreshes at this pace. */
const CLOCK_MS = 15_000;

/**
 * The office core every window shares: the same snapshot, the same derived model and the
 * same mutations. Presentations (big office, desk pet, desk row) only draw `model`.
 */
export function useOffice(demo: boolean, notify: (message: string) => void = () => {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(demo ? demoSnapshot() : null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (demo) {
      setSnapshot(demoSnapshot());
      setError('');
      return;
    }
    let active = true;
    setSnapshot(null);
    api
      .snapshot()
      .then((s) => {
        if (active) {
          setSnapshot(s);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const unsubscribe = api.subscribe((s) => {
      if (active) {
        setSnapshot(s);
        setError('');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [demo]);
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setClock(Date.now());
    };
    const timer = setInterval(tick, CLOCK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  // `clock` only re-derives time-based state between snapshots; the model always uses now.
  const model = useMemo(() => buildOfficeModel(snapshot, Date.now()), [snapshot, clock]);

  const refresh = async () => {
    if (demo) {
      notify('데모 화면이에요. 실제 연결을 보려면 데모를 종료해 주세요.');
      return;
    }
    setRefreshing(true);
    try {
      const s = await api.refresh();
      setSnapshot(s);
      setError('');
      notify('동료들의 최신 기록을 확인했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  /** Resolves to whether the preference was saved. */
  const setPrefs = async (p: Partial<Preferences>) => {
    if (demo) {
      setSnapshot((s) =>
        s ? reconcileDemo({ ...s, preferences: { ...s.preferences, ...p } }) : s,
      );
      return true;
    }
    try {
      setSnapshot(await api.preferences(p));
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  const patch = async (id: string, p: SessionPatch) => {
    if (demo) {
      setSnapshot((s) =>
        s
          ? reconcileDemo({
              ...s,
              sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...p } : x)),
            })
          : s,
      );
      return;
    }
    setSnapshot(await api.patch(id, p));
  };
  const receipt = async (receipts: NoticeReceipt[], action: ReceiptAction) => {
    if (demo) {
      setSnapshot((s) =>
        s ? { ...s, notices: applyNoticeReceipt(s.notices ?? [], receipts, action) } : s,
      );
      return;
    }
    try {
      for (let i = 0; i < receipts.length; i += 1000)
        setSnapshot(await api.notices(receipts.slice(i, i + 1000), action));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  /** Count an open of this colleague (frequent sort); never blocks the selection. */
  const visit = (id: string) => {
    if (!demo) {
      void api
        .visit(id)
        .then(setSnapshot)
        .catch((e) => notify(e.message));
      return;
    }
    setSnapshot((s) =>
      s
        ? {
            ...s,
            sessions: s.sessions.map((x) =>
              x.id === id
                ? { ...x, openCount: (x.openCount || 0) + 1, lastViewedAt: Date.now() }
                : x,
            ),
          }
        : s,
    );
  };
  /** Hide colleagues until their next conversation (`on`), or bring them back now. */
  const veil = async (ids: string[], on: boolean) => {
    const hiddenAt = on ? Date.now() : null;
    if (demo) {
      setSnapshot((s) =>
        s
          ? reconcileDemo({
              ...s,
              sessions: s.sessions.map((x) => (ids.includes(x.id) ? { ...x, hiddenAt } : x)),
            })
          : s,
      );
      return;
    }
    try {
      for (const id of ids) setSnapshot(await api.patch(id, { hiddenAt }));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const returnToOffice = async (id: string) => {
    if (!demo) {
      try {
        setSnapshot(await api.returnToOffice(id));
        notify('사무실에 자리를 마련했어요');
      } catch (e) {
        notify((e as Error).message);
      }
      return;
    }
    setSnapshot((s) => {
      if (!s) return s;
      const sessions = s.sessions.map((x) =>
        x.id === id
          ? { ...x, archived: false, returnedAt: Date.now(), zone: 'office' as const }
          : x,
      );
      const active = officeResidents(sessions).sessions.filter(
        (x) => officeZone(x, s.preferences) === 'office',
      );
      const seats = allocateSeats(
        active,
        Object.fromEntries(
          active.filter((x) => x.officeSeat !== undefined).map((x) => [seatKey(x), x.officeSeat!]),
        ),
      );
      return {
        ...s,
        sessions: sessions.map((x) => ({
          ...x,
          officeSeat: seats[seatKey(x)],
          zone: officeZone(x, s.preferences),
        })),
      };
    });
  };
  return {
    snapshot,
    error,
    refreshing,
    model,
    refresh,
    setPrefs,
    patch,
    receipt,
    visit,
    veil,
    returnToOffice,
  };
}
export type OfficeCore = ReturnType<typeof useOffice>;
