import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, EyeOff, Power, SquareTerminal, X } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n, useSharedLocale } from '../lib/i18n';
import { isMac } from '../lib/platform';
import { shortPath } from '../lib/format';
import { OnTopButton, usePopupOnTop } from './WindowPin';
import {
  BUILTIN_LIST_REFRESH_MS,
  formatBytes,
  groupedOrder,
  groupRows,
  managerKey,
  managerRows,
  outputMoved,
  previewTargets,
  stepSelection,
  TERM_MANAGER_PREVIEW_MS,
  termRowTitle,
  type BuiltinListing,
  type BuiltinSessionAction,
  type BuiltinSessionRow,
  type TermPreview,
} from '../shared/term-list';
import type { TermTarget } from '../shared/term-view';

// xterm.js is loaded only once a session is shown.
const TermPanel = lazy(() => import('./TermPanel'));

const visible = () => document.visibilityState !== 'hidden';

/**
 * The terminal manager (`#terms`, desktop/term-manager.ts): every session of the built-in
 * terminal in one window, cmux/Orca-like. The list and every action come from main (the same
 * list as Settings › 내장 터미널); this page only draws them.
 *
 * Light by design: only the selected session has a live view (TermPanel, keyed by session, so
 * switching detaches one and attaches the next from the daemon's screen). The others show a few
 * rows of their visible screen, read every few seconds while the window is seen and never while
 * it is hidden. Ended sessions: only the latest few.
 */
export function TermManagerWindow() {
  const { t } = useI18n();
  useSharedLocale();
  const s = t.shell.manager;
  const service = api.termManager;
  const term = api.term;
  const [listing, setListing] = useState<BuiltinListing | null>(null);
  const [target, setTarget] = useState<TermTarget | null>(null);
  // The latest read of each session (kept while it is selected: its title stays the same).
  const [previews, setPreviews] = useState<Record<string, TermPreview>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [acting, setActing] = useState('');
  const [note, setNote] = useState('');
  const onTop = usePopupOnTop(term?.window);
  /** The session asked for last: a slower answer for an earlier one is dropped. */
  const wanted = useRef<string | null>(null);
  const previous = useRef(new Map<string, BuiltinSessionRow>());
  const hidden = !!listing?.hidden;
  // Under project headings; ⌘1…9 and stepping follow the order drawn.
  const groups = useMemo(() => groupRows(managerRows(listing)), [listing]);
  const rows = useMemo(() => groupedOrder(groups), [groups]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selected = target?.session ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const refresh = useCallback(async () => {
    if (!service) return;
    try {
      const next = await service.list();
      const moved: Record<string, boolean> = {};
      for (const row of next.sessions)
        moved[row.id] = outputMoved(previous.current.get(row.id), row);
      previous.current = new Map(next.sessions.map((r) => [r.id, r]));
      setBusy(moved);
      setListing(next);
    } catch (e) {
      setNote((e as Error).message);
    }
  }, [service]);

  const choose = useCallback(
    async (session: string | null) => {
      if (!service || !session || session === wanted.current) return;
      wanted.current = session;
      setNote('');
      try {
        const next = await service.select(session);
        if (wanted.current === session) setTarget(next);
      } catch (e) {
        if (wanted.current === session) {
          wanted.current = selectedRef.current;
          setNote((e as Error).message);
        }
      }
    },
    [service],
  );

  // The list, now and every few seconds while the window is seen.
  useEffect(() => {
    if (!service) return;
    void refresh();
    const timer = setInterval(() => {
      if (visible()) void refresh();
    }, BUILTIN_LIST_REFRESH_MS);
    const shown = () => visible() && void refresh();
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [service, refresh]);

  // What main chose for it (a jump opened it there), now and whenever it chooses again.
  useEffect(() => {
    if (!service) return;
    let alive = true;
    void service
      .selected()
      .then((id) => {
        if (alive && id) void choose(id);
      })
      .catch(() => {});
    const off = service.onSelect((id) => void choose(id));
    return () => {
      alive = false;
      off();
    };
  }, [service, choose]);

  // Nothing chosen yet: the newest session.
  useEffect(() => {
    if (!wanted.current && !hidden && rows.length) void choose(rows[0].id);
  }, [rows, hidden, choose]);

  // Previews of the others: a few rows each, only while the window is seen.
  const previewKey = previewTargets(rows, selected, hidden).join(',');
  useEffect(() => {
    if (!service) return;
    const ids = previewKey ? previewKey.split(',') : [];
    if (hidden) {
      setPreviews({});
      return;
    }
    if (!ids.length) return;
    let alive = true;
    const read = async () => {
      if (!visible()) return;
      try {
        const next = await service.preview(ids);
        if (!alive) return;
        const known = new Set(rowsRef.current.map((r) => r.id));
        setPreviews((before) => {
          const kept = Object.entries(before).filter(([id]) => known.has(id) && !(id in next));
          return { ...Object.fromEntries(kept), ...next };
        });
      } catch {
        /* the next read tries again */
      }
    };
    void read();
    const timer = setInterval(() => void read(), TERM_MANAGER_PREVIEW_MS);
    const shown = () => visible() && void read();
    document.addEventListener('visibilitychange', shown);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [service, previewKey, hidden]);

  // The selected session is not previewed: read its name once when chosen (its title and last
  // prompt, for a row with no conversation), then follow its live view's title changes.
  useEffect(() => {
    if (!service || !selected || hidden) return;
    if (!rowsRef.current.some((r) => r.id === selected && !r.exit)) return;
    let alive = true;
    void service
      .preview([selected])
      .then((next) => {
        if (alive && next[selected]) setPreviews((before) => ({ ...before, ...next }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [service, selected, hidden]);
  const titleChanged = useCallback(
    (session: string, title: string) =>
      setPreviews((before) => ({
        ...before,
        [session]: { lines: before[session]?.lines ?? [], title: title.trim() },
      })),
    [],
  );

  // The window's own keys, before the terminal sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = managerKey(e);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      if ('close' in key) void term?.window('close').catch(() => window.close());
      else if ('select' in key) void choose(rowsRef.current[key.select]?.id ?? null);
      else void choose(stepSelection(rowsRef.current, selectedRef.current, key.step));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [choose, term]);

  // The page of a frameless dark window, like a terminal window's.
  useEffect(() => {
    const body = document.body.classList;
    body.add('shell-mode');
    body.toggle('is-mac', isMac);
    const press = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.xterm'))
        void term?.window('focus').catch(() => {});
    };
    window.addEventListener('pointerdown', press, true);
    return () => {
      body.remove('shell-mode');
      window.removeEventListener('pointerdown', press, true);
    };
  }, [term]);

  useEffect(() => {
    document.title = s.title;
  }, [s.title]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 6000);
    return () => clearTimeout(timer);
  }, [note]);

  const act = async (row: BuiltinSessionRow, action: BuiltinSessionAction) => {
    if (!service) return;
    setActing(`${row.id}:${action}`);
    setNote('');
    try {
      await service.act(row.id, action);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setActing('');
      void refresh();
    }
  };

  if (!service || !term)
    return (
      <div className="shell-window">
        <p className="shell-window-error" role="alert">
          {t.launch.builtinUnsupported}
        </p>
      </div>
    );

  const empty = listing?.error
    ? s.error(listing.error)
    : listing && !listing.daemon
      ? s.off
      : listing && !rows.length
        ? s.empty
        : '';
  return (
    <div className="shell-window term-manager">
      <header className="mini-shell-bar term-manager-bar">
        <span className="mini-shell-icon">
          <SquareTerminal size={13} aria-hidden />
        </span>
        <b>{s.title}</b>
        <span className="mini-shell-path">{s.keys}</span>
        <OnTopButton
          className="mini-shell-btn icon"
          size={13}
          on={onTop.on}
          busy={onTop.busy}
          onToggle={() => void onTop.toggle().catch((e: Error) => setNote(e.message))}
        />
        <button
          type="button"
          className="mini-shell-btn icon"
          aria-label={s.close}
          title={s.close}
          onClick={() => void term.window('close').catch(() => window.close())}
        >
          <X size={13} />
        </button>
      </header>
      <div className="term-manager-body">
        <nav className="term-manager-list" aria-label={s.list}>
          {hidden && <p className="term-manager-hint">{s.hidden}</p>}
          {empty && <p className="term-manager-hint">{empty}</p>}
          <ul>
            {groups.map((group) => (
              <li
                key={group.key || '-'}
                className="term-manager-group"
                data-term-project={group.key}
              >
                {group.name && (
                  <div
                    className="term-manager-group-head"
                    title={group.key}
                    aria-label={s.group(group.name, group.rows.length)}
                  >
                    <span>{group.name}</span>
                    <span className="term-manager-group-count">{group.rows.length}</span>
                  </div>
                )}
                <ul>
                  {group.rows.map((row) => {
                    const i = rows.indexOf(row);
                    const title = termRowTitle(row, previews[row.id], hidden, shortPath);
                    const program = hidden ? '' : row.program;
                    const cwd = hidden ? '' : row.cwd;
                    const ended = !!row.exit;
                    const state = ended ? 'ended' : row.windowOpen ? 'open' : 'background';
                    const lines =
                      hidden || row.id === selected ? [] : (previews[row.id]?.lines ?? []);
                    const isBusy = !ended && !!busy[row.id];
                    return (
                      <li
                        key={row.id}
                        data-term-session={row.id}
                        data-state={state}
                        aria-current={row.id === selected ? 'true' : undefined}
                      >
                        <button
                          type="button"
                          className="term-manager-row"
                          onClick={() => void choose(row.id)}
                          title={cwd || undefined}
                        >
                          <span className="term-manager-name">
                            <span
                              className="term-manager-dot"
                              data-busy={isBusy ? 'true' : 'false'}
                              aria-label={ended ? s.ended : isBusy ? s.busy : s.idle}
                            />
                            <b data-title-source={title.source}>{title.text}</b>
                            {isMac && i < 9 && <kbd className="term-manager-key">⌘{i + 1}</kbd>}
                          </span>
                          <span className="term-manager-meta">
                            {program && <span className="term-manager-program">{program}</span>}
                            {cwd && title.source !== 'path' && (
                              <span className="term-manager-path">{shortPath(cwd)}</span>
                            )}
                            <span className="term-manager-state">
                              {ended ? s.ended : row.windowOpen ? s.windowOpen : s.background}
                            </span>
                            {row.rss !== undefined && <span>{formatBytes(row.rss)}</span>}
                          </span>
                          {lines.length > 0 && (
                            <span className="term-manager-preview" aria-hidden>
                              {lines.join('\n')}
                            </span>
                          )}
                        </button>
                        <span className="term-manager-actions">
                          <button
                            type="button"
                            className="mini-shell-btn icon"
                            aria-label={s.openWindow}
                            title={s.openWindowTitle}
                            disabled={ended || hidden || !!acting}
                            onClick={() => void act(row, 'open')}
                          >
                            <AppWindow size={12} />
                          </button>
                          <button
                            type="button"
                            className="mini-shell-btn icon"
                            aria-label={s.hide}
                            title={s.hideTitle}
                            disabled={!row.windowOpen || !!acting}
                            onClick={() => void act(row, 'hide')}
                          >
                            <EyeOff size={12} />
                          </button>
                          <button
                            type="button"
                            className="mini-shell-btn icon danger"
                            aria-label={s.kill}
                            title={t.shell.term.killTitle}
                            disabled={ended || !!acting}
                            onClick={() => void act(row, 'kill')}
                          >
                            <Power size={12} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
        <main className="term-manager-view">
          {target && !hidden ? (
            <Suspense fallback={null}>
              <TermPanel
                key={target.session}
                target={target}
                embedded
                heading={(() => {
                  const row = rows.find((r) => r.id === target.session);
                  return row
                    ? termRowTitle(row, previews[row.id], hidden, shortPath)?.text
                    : undefined;
                })()}
                onTitle={(title) => titleChanged(target.session, title)}
              />
            </Suspense>
          ) : (
            <p className="term-manager-hint center">{hidden ? s.hidden : s.pick}</p>
          )}
        </main>
      </div>
      {note && (
        <footer className="mini-shell-note" role="status">
          {note}
        </footer>
      )}
    </div>
  );
}
