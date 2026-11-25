import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { EyeOff, LoaderCircle, Power, SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { isMac } from '../lib/platform';
import { OnTopButton, usePopupOnTop } from './WindowPin';
import { termOptions, useTermChrome } from './TermChrome';
import {
  clampCols,
  clampRows,
  fitSize,
  OutputFlow,
  SHELL_LIMITS,
  splitInput,
} from '../shared/mini-shell';
import { TERM_VIEW_SCROLLBACK, wantsAttach, type TermTarget } from '../shared/term-view';

type Status = 'connecting' | 'live' | 'away' | 'ended' | 'error';

/**
 * Draws one session of the built-in terminal (#401) in its own window (TermWindow): the screen
 * the daemon keeps, then live output, and keys back to it. The view attaches only while the
 * window is shown; hidden, it detaches and nothing streams, and shown again it starts from the
 * daemon's screen. All terminal state lives in the daemon: closing the window loses nothing.
 *
 * `embedded`: drawn inside the terminal manager (TermManager), which owns the window's own
 * buttons (on top, close). Its commands name the session, so main never attaches or ends one
 * the manager has already switched away from.
 */
export default function TermPanel({
  target,
  embedded = false,
}: {
  target: TermTarget;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const term = api.term!;
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const chrome = useTermChrome();
  const onTop = usePopupOnTop(embedded ? undefined : term.window);

  // The page's own shortcuts must not see terminal keys.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener('keydown', stop);
    return () => el.removeEventListener('keydown', stop);
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    let ended = false;
    let attaching = false;
    let viewId: string | null = null;
    /** A restored screen is being parsed at the session's size: no fitting until it is done. */
    let restoring = false;
    /** The size main has: a resize to it again would only signal the program for nothing. */
    let sent = { cols: 0, rows: 0 };
    /**
     * What arrives for a view before it is live (the attach answer comes on another IPC channel,
     * and its first screen takes a moment to parse), kept in order and replayed then: output, a
     * fresh screen, its exit, a lost connection.
     */
    type Early =
      | { kind: 'data'; data: Uint8Array | string }
      | { kind: 'resync'; restore: string; cols: number; rows: number }
      | { kind: 'exit' }
      | { kind: 'lost' };
    const early = new Map<string, Early[]>();
    /** Output held per view, and the views already told to pause while it is held. */
    const heldBytes = new Map<string, number>();
    const heldPaused = new Set<string>();
    const hold = (id: string, event: Early) => {
      early.set(id, [...(early.get(id) ?? []), event]);
      if (event.kind !== 'data') return;
      // Held output counts like drawn-later output: past the high-water mark that view's
      // connection pauses now, not only once it is replayed (its replay then resumes it).
      const bytes = (heldBytes.get(id) ?? 0) + event.data.length;
      heldBytes.set(id, bytes);
      if (bytes > SHELL_LIMITS.flowHigh && !heldPaused.has(id)) {
        heldPaused.add(id);
        void term.command({ type: 'flow', viewId: id, paused: true }).catch(() => {});
      }
    };
    const xterm = new XTerm(termOptions(TERM_VIEW_SCROLLBACK));
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(el);
    const unbind = chrome.bind(xterm, () => refit());
    const size = () => {
      let proposed;
      try {
        proposed = fit.proposeDimensions();
      } catch {
        /* not laid out yet */
      }
      const next = fitSize(proposed) ?? {
        cols: clampCols(xterm.cols),
        rows: clampRows(xterm.rows),
      };
      const differs = next.cols !== xterm.cols || next.rows !== xterm.rows;
      if (differs && !restoring) xterm.resize(next.cols, next.rows);
      return next;
    };
    // Output not drawn yet stays bounded: above the high-water mark main stops reading this
    // view's connection; the daemon then holds back and, past its limit, sends a fresh screen.
    const flow = new OutputFlow((paused) => {
      if (viewId) void term.command({ type: 'flow', viewId, paused }).catch(() => {});
    });
    const draw = (data: Uint8Array | string, done?: () => void) => {
      flow.wrote(data.length);
      xterm.write(data, () => {
        flow.drew(data.length);
        done?.();
      });
    };
    /**
     * A screen from the daemon replaces what is drawn, in parsing order: a full reset (RIS) and
     * the size it was taken at go after any output still queued, then the screen, then `done`.
     */
    const replace = (restore: string, cols: number, rows: number, done?: () => void) => {
      restoring = true;
      xterm.write('\x1bc', () => {
        if (cols !== xterm.cols || rows !== xterm.rows) xterm.resize(cols, rows);
      });
      draw(restore, () => {
        restoring = false;
        done?.();
      });
    };
    /** A fresh screen at the size it was taken (the session's now), then this window's again. */
    const resync = (restore: string, cols: number, rows: number) => {
      sent = { cols, rows };
      replace(restore, cols, rows, () => refit());
    };
    const offData = term.onData((id, data) => {
      if (id === viewId) draw(data);
      else if (!viewId) hold(id, { kind: 'data', data });
    });
    const offResync = term.onResync((id, restore, cols, rows) => {
      if (id === viewId) resync(restore, cols, rows);
      else if (!viewId) hold(id, { kind: 'resync', restore, cols, rows });
    });
    const finish = () => {
      viewId = null;
      ended = true;
      setStatus('ended');
    };
    const offExit = term.onExit((id) => {
      if (!alive) return;
      if (id === viewId) finish();
      else if (!viewId) hold(id, { kind: 'exit' });
    });
    // Its connection to the daemon closed without the session ending (the daemon stopped):
    // nothing typed would arrive, so the view lets go and tries once to attach again.
    const lose = () => {
      viewId = null;
      setStatus('error');
      setError(t.shell.term.lost);
      setTimeout(() => {
        if (alive && wantsAttach({ mounted: alive, visible: visible(), ended })) void attach();
      }, 500);
    };
    const offLost = term.onLost((id) => {
      if (!alive) return;
      if (id === viewId) lose();
      else if (!viewId) hold(id, { kind: 'lost' });
    });
    const input = xterm.onData((data) => {
      if (!viewId) return;
      for (const piece of splitInput(data)) term.input(viewId, piece);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      size();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!viewId || restoring) return;
        const next = size();
        if (next.cols === sent.cols && next.rows === sent.rows) return;
        sent = next;
        void term.command({ type: 'resize', viewId, ...next }).catch(() => {});
      }, 60);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    const visible = () => document.visibilityState !== 'hidden';

    const attach = async () => {
      if (attaching || viewId || ended) return;
      attaching = true;
      setStatus('connecting');
      setError('');
      const wanted = size();
      try {
        const a = await term.command({
          type: 'attach',
          ...wanted,
          ...(embedded && { session: target.session }),
        });
        // Gone or hidden meanwhile (before or while its screen was parsed): let go of it.
        const leave = () => {
          if (!a.exited) void term.command({ type: 'detach', viewId: a.viewId }).catch(() => {});
          if (alive) setStatus('away');
        };
        if (!alive || !visible()) return leave();
        // The screen as the daemon keeps it, parsed at its size, then fitted to this window
        // (main already resized the session to `wanted`, which makes the program draw again).
        await new Promise<void>((done) => replace(a.restore, a.cols, a.rows, done));
        if (a.exited) return finish();
        if (!alive || !visible()) return leave();
        sent = wanted;
        size();
        // Live before what came meanwhile is replayed, so flow control reaches this view; an
        // earlier view's pause, still counted, is said to this one too.
        viewId = a.viewId;
        if (flow.isPaused)
          void term.command({ type: 'flow', viewId, paused: true }).catch(() => {});
        // What came meanwhile, in order: the last output before an exit is still drawn.
        for (const event of early.get(a.viewId) ?? []) {
          if (event.kind === 'data') draw(event.data);
          else if (event.kind === 'resync') resync(event.restore, event.cols, event.rows);
          else if (event.kind === 'exit') return finish();
          else return lose();
        }
        setStatus('live');
        refit();
        xterm.focus();
      } catch (e) {
        if (!alive) return;
        setStatus('error');
        setError((e as Error).message);
      } finally {
        attaching = false;
        early.clear();
        heldBytes.clear();
        heldPaused.clear();
      }
    };
    const detach = () => {
      if (!viewId) return;
      const id = viewId;
      viewId = null;
      void term.command({ type: 'detach', viewId: id }).catch(() => {});
    };
    const follow = () => {
      if (wantsAttach({ mounted: alive, visible: visible(), ended })) void attach();
      else if (viewId) {
        detach();
        setStatus('away');
      }
    };
    document.addEventListener('visibilitychange', follow);
    follow();
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', follow);
      clearTimeout(resizeTimer);
      observer.disconnect();
      offData();
      offResync();
      offExit();
      offLost();
      input.dispose();
      detach();
      unbind();
      xterm.dispose();
    };
  }, [target.session]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 6000);
    return () => clearTimeout(timer);
  }, [note]);

  // Hiding closes the window only: the view detaches and the session keeps running in the
  // daemon (Settings › 내장 터미널 lists it). ⌘W is the macOS window menu's own Close.
  const hide = () => void term.window('close').catch(() => window.close());
  const kill = async () => {
    try {
      await term.command({ type: 'kill', ...(embedded && { session: target.session }) });
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  return (
    <section
      ref={root}
      className="mini-shell term-view"
      aria-label={t.launch.destination.builtin}
      data-status={status}
    >
      <header className="mini-shell-bar">
        <span className="mini-shell-icon" title={t.shell.term.hint}>
          <SquareTerminal size={13} aria-hidden />
        </span>
        <b title={target.title}>{target.title}</b>
        <span className="mini-shell-path" title={target.cwd}>
          {target.cwd}
        </span>
        <button
          type="button"
          className="mini-shell-btn danger"
          disabled={status === 'ended'}
          title={t.shell.term.killTitle}
          onClick={() => void kill()}
        >
          <Power size={12} />
          {t.shell.kill}
        </button>
        {!embedded && (
          <>
            <OnTopButton
              className="mini-shell-btn icon"
              size={13}
              on={onTop.on}
              busy={onTop.busy}
              onToggle={() => void onTop.toggle().catch((e: Error) => setNote(e.message))}
            />
            <button
              type="button"
              className="mini-shell-btn hide"
              title={t.shell.term.hideTitle(isMac ? '⌘W' : '')}
              onClick={hide}
            >
              <EyeOff size={12} />
              {t.shell.term.hide}
            </button>
          </>
        )}
      </header>
      <div className="mini-shell-body">
        <div ref={host} className="mini-shell-term" />
        {chrome.ui}
        {status === 'connecting' && (
          <p className="mini-shell-state">
            <LoaderCircle size={14} className="now-spin" /> {t.shell.connecting}
          </p>
        )}
        {status === 'error' && (
          <div className="mini-shell-state" role="alert">
            <span>{error}</span>
          </div>
        )}
      </div>
      {(note || status === 'ended' || status === 'away') && (
        <footer className="mini-shell-note" role="status">
          {note || (status === 'ended' ? t.shell.term.ended : t.shell.term.away)}
        </footer>
      )}
    </section>
  );
}
