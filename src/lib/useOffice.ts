import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { savedLocalePreference, useI18n, useLocalePreference } from './i18n';
import { getLocale, m } from '../shared/i18n';
import { demoSnapshot, reconcileDemo } from './demo';
import { applyNoticeReceipt } from '../shared/notices';
import { officeResidents } from '../shared/residents';
import { allocateSeats, officeZone, seatKey } from '../shared/office';
import { buildOfficeModel } from '../shared/office-model';
import type { NoticeReceipt, Preferences, Session, SessionPatch, Snapshot } from '../shared/types';
import { useWakeAt } from './useWakeAt';
import { arrivalEnds } from '../shared/speech';
import { mergePetCustomization, normalizePetCustomization } from '../shared/pets';

/**
 * The demo rewritten in the active language, carrying over what the viewer did in it: preferences
 * (the language choice lives there), pins, hides, archive/return and notice receipts.
 */
function relocalizedDemo(prev: Snapshot): Snapshot {
  const fresh = demoSnapshot();
  const sessions = new Map(prev.sessions.map((s) => [s.id, s]));
  const notices = new Map((prev.notices ?? []).map((n) => [n.id, n]));
  return reconcileDemo({
    ...fresh,
    preferences: prev.preferences,
    sessions: fresh.sessions.map((s) => {
      const was = sessions.get(s.id);
      if (!was) return s;
      const { pinned, archived, completed, notes, hiddenAt, openCount, lastViewedAt, returnedAt } =
        was;
      return {
        ...s,
        pinned,
        archived,
        completed,
        notes,
        hiddenAt,
        openCount,
        lastViewedAt,
        returnedAt,
      };
    }),
    notices: fresh.notices?.map((n) => {
      const was = notices.get(n.id);
      return was
        ? { ...n, seenAt: was.seenAt, viewedAt: was.viewedAt, dismissedAt: was.dismissedAt }
        : n;
    }),
  });
}
export type ReceiptAction = 'read' | 'dismiss' | 'unread' | 'view';
/** Decorative/derived time (working → resting after 2 minutes) refreshes at this pace. */
const CLOCK_MS = 15_000;
/** Matches the service's per-request limit for `veil`. */
const VEIL_BATCH = 500;

/**
 * The office core every window shares: the same snapshot, the same derived model and the
 * same mutations. Presentations (big office, desk pet, desk row) only draw `model`.
 */
function customizedDemo() {
  const snapshot = demoSnapshot();
  try {
    snapshot.preferences.petAppearance = normalizePetCustomization(
      JSON.parse(localStorage.getItem('office:demo-pets') || 'null'),
    );
  } catch {
    // An invalid demo setting falls back to the original characters.
  }
  return snapshot;
}

export function useOffice(demo: boolean, notify: (message: string) => void = () => {}) {
  const { locale } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(demo ? customizedDemo() : null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  // Demo content is written in the language it was generated in.
  const demoLocale = useRef(locale);
  useEffect(() => {
    if (demo) {
      demoLocale.current = getLocale();
      // Carry the chosen language into the demo so entering it doesn't switch languages.
      setSnapshot((prev) => {
        const next = customizedDemo();
        const chosen = prev?.preferences.locale ?? savedLocalePreference();
        return chosen ? { ...next, preferences: { ...next.preferences, locale: chosen } } : next;
      });
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
    if (!demo || !snapshot?.preferences.petAppearance) return;
    try {
      localStorage.setItem('office:demo-pets', JSON.stringify(snapshot.preferences.petAppearance));
    } catch {
      // Demo still works when local storage is unavailable.
    }
  }, [demo, snapshot?.preferences.petAppearance]);
  // Every window (big office, desk pet / row, dock card) follows the saved language.
  useLocalePreference(snapshot?.preferences.locale, !!snapshot, snapshot?.locale);
  // On a language switch, rewrite the demo in the new language but keep its preferences:
  // the language choice itself lives there, so resetting them would bounce the switch back.
  useEffect(() => {
    if (!demo || demoLocale.current === locale) return;
    demoLocale.current = locale;
    setSnapshot((s) => (s ? relocalizedDemo(s) : s));
  }, [demo, locale]);
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
  // A just-arrived request ends on time even between the coarse ticks.
  useWakeAt(arrivalEnds(snapshot?.notices ?? []), () => setClock(Date.now()));
  // `clock` only re-derives time-based state between snapshots; the model always uses now.
  const model = useMemo(() => buildOfficeModel(snapshot, Date.now()), [snapshot, clock]);

  const refresh = async () => {
    if (demo) {
      notify(m().app.toast.demoRefresh);
      return;
    }
    setRefreshing(true);
    try {
      const s = await api.refresh();
      setSnapshot(s);
      setError('');
      notify(m().app.toast.refreshed);
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  /** Resolves to whether the preference was saved. */
  const setPrefs = async (p: Partial<Preferences>) => {
    if (demo) {
      setSnapshot((s) =>
        s
          ? reconcileDemo({
              ...s,
              preferences: {
                ...s.preferences,
                ...p,
                petAppearance: p.petAppearance
                  ? mergePetCustomization(s.preferences.petAppearance, p.petAppearance)
                  : s.preferences.petAppearance,
              },
            })
          : s,
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
  /**
   * Pin or unpin a colleague. A persona colleague pins all of its runs, so the pin stays when
   * another run starts speaking for it. Resolves to the new state; rejects so callers can tell.
   */
  const pin = async (s: Session) => {
    const next = !s.pinned;
    const ids = s.resident?.key.startsWith('actor:') ? s.resident.sessionIds : [s.id];
    for (const id of ids) await patch(id, { pinned: next });
    return next;
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
      // The service takes up to 500 ids per request; "bring everyone back" can be more.
      for (let i = 0; i < ids.length; i += VEIL_BATCH)
        setSnapshot(await api.veil(ids.slice(i, i + VEIL_BATCH), on));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const returnToOffice = async (id: string) => {
    if (!demo) {
      try {
        setSnapshot(await api.returnToOffice(id));
        notify(m().app.toast.returned);
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
    pin,
    receipt,
    visit,
    veil,
    returnToOffice,
  };
}
export type OfficeCore = ReturnType<typeof useOffice>;
