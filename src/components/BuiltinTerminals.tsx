import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, EyeOff, Power, RotateCw, SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { ago, shortPath } from '../lib/format';
import {
  BUILTIN_LIST_REFRESH_MS,
  formatBytes,
  type BuiltinListing,
  type BuiltinSessionAction,
  type BuiltinSessionRow,
} from '../shared/term-list';

/**
 * Settings › 내장 터미널: the sessions the built-in terminal keeps running in the background,
 * as main lists them (desktop/term-list.ts), with 열기 · 숨기기 · 종료 on each. It only draws:
 * the list, the names and every action come from main. Refreshed every few seconds while it is
 * on screen, and right after an action.
 */
export function BuiltinTerminals({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const s = t.settings.builtinList;
  const service = api.builtinTerminals;
  const [listing, setListing] = useState<BuiltinListing | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!service) return;
    try {
      setListing(await service.list());
    } catch (e) {
      setNote((e as Error).message);
    }
  }, [service]);

  useEffect(() => {
    if (!service) return;
    void refresh();
    // Only while it can be seen: on screen, in a window that is shown.
    let onScreen = true;
    const io =
      typeof IntersectionObserver === 'function' && root.current
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            if (onScreen) void refresh();
          })
        : null;
    if (io && root.current) io.observe(root.current);
    const timer = setInterval(() => {
      if (onScreen && document.visibilityState !== 'hidden') void refresh();
    }, BUILTIN_LIST_REFRESH_MS);
    return () => {
      clearInterval(timer);
      io?.disconnect();
    };
  }, [service, refresh]);

  if (!service || (listing && !listing.supported)) return null;
  // Off and nothing running: nothing to show.
  if (!enabled && (!listing || (!listing.daemon && !listing.error))) return null;

  const act = async (row: BuiltinSessionRow, action: BuiltinSessionAction) => {
    setBusy(`${row.id}:${action}`);
    setNote('');
    try {
      await service.act(row.id, action);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy('');
      void refresh();
    }
  };

  const daemon = listing?.daemon;
  return (
    <div className="builtin-terms" data-setting="builtin-terminal-list" ref={root}>
      <div className="setting-row builtin-terms-head">
        <SquareTerminal size={18} />
        <div>
          <b>{s.title}</b>
          <p>
            {listing?.error
              ? s.daemonError(listing.error)
              : daemon
                ? s.summary(daemon.live, formatBytes(daemon.rss))
                : listing
                  ? s.daemonOff
                  : s.hint}
          </p>
        </div>
        <button
          type="button"
          className="builtin-terms-btn icon"
          aria-label={s.refresh}
          title={s.refresh}
          onClick={() => void refresh()}
        >
          <RotateCw size={13} />
        </button>
      </div>
      {daemon && (
        <>
          <p className="builtin-terms-hint">{listing?.hidden ? s.hidden : s.hint}</p>
          {listing!.sessions.length === 0 ? (
            <p className="builtin-terms-empty">{s.empty}</p>
          ) : (
            <ul className="builtin-terms-list">
              {listing!.sessions.map((row) => {
                const names = row.agents.map((a) => a.name).join(', ');
                const ended = !!row.exit;
                return (
                  <li
                    key={row.id}
                    data-term-session={row.id}
                    data-state={ended ? 'ended' : row.windowOpen ? 'open' : 'background'}
                  >
                    <div className="builtin-terms-main">
                      <b title={names || undefined}>
                        {names || row.program || row.id}
                        {names && row.program && (
                          <span className="builtin-terms-program">{row.program}</span>
                        )}
                      </b>
                      {row.cwd && (
                        <span className="builtin-terms-path" title={row.cwd}>
                          {shortPath(row.cwd)}
                        </span>
                      )}
                      <span className="builtin-terms-meta">
                        <span className="builtin-terms-state">
                          {ended
                            ? s.ended(row.exit!.code)
                            : row.windowOpen
                              ? s.windowOpen
                              : s.background}
                        </span>
                        <span>{s.started(ago(row.startedAt))}</span>
                        {row.rss !== undefined && <span>{s.memory(formatBytes(row.rss))}</span>}
                        {!ended && <span>{s.pid(row.pid)}</span>}
                        {!names && !listing!.hidden && !ended && <span>{s.unknown}</span>}
                      </span>
                    </div>
                    <div className="builtin-terms-actions">
                      <button
                        type="button"
                        className="builtin-terms-btn"
                        disabled={ended || !!busy}
                        onClick={() => void act(row, 'open')}
                      >
                        <AppWindow size={12} />
                        {s.open}
                      </button>
                      <button
                        type="button"
                        className="builtin-terms-btn"
                        disabled={!row.windowOpen || !!busy}
                        title={t.shell.term.hideTitle('')}
                        onClick={() => void act(row, 'hide')}
                      >
                        <EyeOff size={12} />
                        {s.hide}
                      </button>
                      <button
                        type="button"
                        className="builtin-terms-btn danger"
                        disabled={ended || !!busy}
                        title={t.shell.term.killTitle}
                        onClick={() => void act(row, 'kill')}
                      >
                        <Power size={12} />
                        {s.kill}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {note && (
        <p className="builtin-terms-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
