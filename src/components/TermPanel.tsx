import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { LoaderCircle, Power, SquareTerminal, X } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { OnTopButton, usePopupOnTop } from './WindowPin';
import { clampCols, clampRows, fitSize, OutputFlow, splitInput } from '../shared/mini-shell';
import { TERM_VIEW_SCROLLBACK, wantsAttach, type TermTarget } from '../shared/term-view';

type Status = 'connecting' | 'live' | 'away' | 'ended' | 'error';

/**
 * Draws one session of the built-in terminal (#401) in its own window (TermWindow): the screen
 * the daemon keeps, then live output, and keys back to it. The view attaches only while the
 * window is shown; hidden, it detaches and nothing streams, and shown again it starts from the
 * daemon's screen. All terminal state lives in the daemon: closing the window loses nothing.
 */
export default function TermPanel({ target }: { target: TermTarget }) {
  const { t } = useI18n();
  const term = api.term!;
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const onTop = usePopupOnTop(term.window);

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
    /** The size main has: a resize to it again would only signal the program for nothing. */
    let sent = { cols: 0, rows: 0 };
    // Output that may arrive before the attach answer (another IPC channel), per view.
    const early = new Map<string, (Uint8Array | string)[]>();
    const xterm = new XTerm({
      fontFamily: '"JetBrains Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: TERM_VIEW_SCROLLBACK,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      allowProposedApi: false,
      theme: { background: '#1c1c1e', foreground: '#e5e5ea', cursor: '#e5e5ea' },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(el);
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
      if (next.cols !== xterm.cols || next.rows !== xterm.rows) xterm.resize(next.cols, next.rows);
      return next;
    };
    // Output not drawn yet stays bounded: above the high-water mark main stops reading this
    // view's connection; the daemon then holds back and, past its limit, sends a fresh screen.
    const flow = new OutputFlow((paused) => {
      if (viewId) void term.command({ type: 'flow', viewId, paused }).catch(() => {});
    });
    const draw = (data: Uint8Array | string) => {
      flow.wrote(data.length);
      xterm.write(data, () => flow.drew(data.length));
    };
    const offData = term.onData((id, data) => {
      if (id === viewId) draw(data);
      else if (!viewId) early.set(id, [...(early.get(id) ?? []), data]);
    });
    const offResync = term.onResync((id, restore) => {
      if (id !== viewId) return;
      xterm.reset();
      draw(restore);
    });
    const offExit = term.onExit((id) => {
      if (id !== viewId || !alive) return;
      viewId = null;
      ended = true;
      setStatus('ended');
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
        if (!viewId) return;
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
        const a = await term.command({ type: 'attach', ...wanted });
        if (!alive || !visible()) {
          if (!a.exited) void term.command({ type: 'detach', viewId: a.viewId }).catch(() => {});
          return;
        }
        // The screen as the daemon keeps it, drawn at its size, then fitted to this window.
        xterm.reset();
        xterm.resize(a.cols, a.rows);
        draw(a.restore);
        if (a.exited) {
          ended = true;
          setStatus('ended');
          return;
        }
        viewId = a.viewId;
        sent = wanted;
        for (const chunk of early.get(a.viewId) ?? []) draw(chunk);
        early.clear();
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
      input.dispose();
      detach();
      xterm.dispose();
    };
  }, [target.session]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 6000);
    return () => clearTimeout(timer);
  }, [note]);

  const close = () => void term.window('close').catch(() => window.close());
  const kill = async () => {
    try {
      await term.command({ type: 'kill' });
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
          aria-label={t.shell.close}
          title={t.shell.close}
          onClick={close}
        >
          <X size={14} />
        </button>
      </header>
      <div className="mini-shell-body">
        <div ref={host} className="mini-shell-term" />
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
