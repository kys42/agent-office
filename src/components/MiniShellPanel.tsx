import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, LoaderCircle, Power, SquareTerminal, X } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { closeMiniShell, openMiniShell } from '../lib/miniShell';
import { OnTopButton, usePopupOnTop } from './WindowPin';
import {
  clampCols,
  clampRows,
  fitSize,
  OutputFlow,
  shellLabel,
  splitInput,
  type ShellAttachment,
  type ShellInfo,
  type ShellTarget,
} from '../shared/mini-shell';

type Status = 'connecting' | 'live' | 'ended' | 'error';

/**
 * Draws one attachment to a tmux-kept shell, filling its own terminal window (ShellWindow). All
 * terminal state lives in tmux: this view only mirrors the screen and forwards keys, so closing
 * the window (or the app) loses nothing.
 */
export default function MiniShellPanel({ target }: { target: ShellTarget }) {
  const { t } = useI18n();
  const shell = api.shell!;
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [attachment, setAttachment] = useState<ShellAttachment | null>(null);
  const [others, setOthers] = useState<ShellInfo[]>([]);
  const [othersOpen, setOthersOpen] = useState(false);
  const [round, setRound] = useState(0);
  const fitRef = useRef<() => void>(() => {});
  // This terminal window's own on-top toggle (desktop/popup-windows.ts `setOnTop`).
  const onTop = usePopupOnTop(shell.window);

  // The page's own shortcuts (Esc closes a card, letters jump around) must not see terminal keys.
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
    let ptyId: string | null = null;
    const early = new Map<string, string>();
    setStatus('connecting');
    setError('');
    setNote('');
    setAttachment(null);
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 1000,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      allowProposedApi: false,
      theme: { background: '#1c1c1e', foreground: '#e5e5ea', cursor: '#e5e5ea' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    /**
     * Fits the view, but never past the PTY's limits: xterm is resized to exactly the size that
     * is sent, so the screen and tmux always agree.
     */
    const size = () => {
      let proposed;
      try {
        proposed = fit.proposeDimensions();
      } catch {
        /* not laid out yet */
      }
      const next = fitSize(proposed) ?? {
        cols: clampCols(term.cols),
        rows: clampRows(term.rows),
      };
      if (next.cols !== term.cols || next.rows !== term.rows) term.resize(next.cols, next.rows);
      return next;
    };
    size();
    // Output that xterm has not drawn yet stays bounded: above the high-water mark main pauses
    // reading this client (tmux then holds back too), and resumes once the view catches up.
    const flow = new OutputFlow((paused) => {
      if (ptyId) void shell.command({ type: 'flow', ptyId, paused }).catch(() => {});
    });
    const draw = (data: string) => {
      flow.wrote(data.length);
      term.write(data, () => flow.drew(data.length));
    };
    const offData = shell.onData((id, data) => {
      if (id === ptyId) draw(data);
      else if (!ptyId) early.set(id, (early.get(id) ?? '') + data);
    });
    const offExit = shell.onExit((id) => {
      if (id !== ptyId || !alive) return;
      ptyId = null;
      setStatus('ended');
    });
    const input = term.onData((data) => {
      if (!ptyId) return;
      for (const piece of splitInput(data)) shell.input(ptyId, piece);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    fitRef.current = () => {
      size();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!ptyId) return;
        const { cols, rows } = size();
        void shell.command({ type: 'resize', ptyId, cols, rows }).catch(() => {});
      }, 60);
    };
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(el);
    const { cols, rows } = size();
    const request = target.name
      ? shell.command({ type: 'attach', name: target.name, cols, rows })
      : shell.command({ type: 'open', id: target.id!, cols, rows });
    request
      .then((a) => {
        if (!alive) {
          void shell.command({ type: 'detach', ptyId: a.ptyId }).catch(() => {});
          return;
        }
        ptyId = a.ptyId;
        const first = early.get(a.ptyId);
        early.clear();
        if (first) draw(first);
        setAttachment(a);
        setStatus('live');
        if (a.created) setNote(t.shell.started);
        void shell
          .command({ type: 'list' })
          .then((list) => alive && setOthers(list))
          .catch(() => {});
        term.focus();
        fitRef.current();
      })
      .catch((e: Error) => {
        if (!alive) return;
        setStatus('error');
        setError(e.message);
      });
    return () => {
      alive = false;
      clearTimeout(resizeTimer);
      observer.disconnect();
      offData();
      offExit();
      input.dispose();
      if (ptyId) void shell.command({ type: 'detach', ptyId }).catch(() => {});
      term.dispose();
    };
    // `round` restarts a shell that ended; the target picks the folder or shell.
  }, [target.id, target.name, target.cwd, round]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 6000);
    return () => clearTimeout(timer);
  }, [note]);
  useEffect(() => {
    if (!othersOpen) return;
    let alive = true;
    shell
      .command({ type: 'list' })
      .then((list) => alive && setOthers(list))
      .catch(() => alive && setOthers([]));
    return () => {
      alive = false;
    };
  }, [othersOpen]);

  const cwd = attachment?.cwd ?? target.cwd;
  const kill = async () => {
    if (!attachment) return;
    try {
      if (await shell.command({ type: 'kill', name: attachment.name })) closeMiniShell();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const elsewhere = attachment
    ? Math.max(0, (others.find((o) => o.name === attachment.name)?.attached ?? 1) - 1)
    : 0;
  return (
    <section ref={root} className="mini-shell" aria-label={t.shell.title} data-status={status}>
      <header className="mini-shell-bar">
        <span className="mini-shell-icon" title={t.shell.hint}>
          <SquareTerminal size={13} aria-hidden />
        </span>
        <b title={cwd}>{shellLabel(cwd)}</b>
        <span className="mini-shell-path" title={cwd}>
          {cwd}
        </span>
        <div className="mini-shell-others">
          <button
            type="button"
            className="mini-shell-btn"
            aria-expanded={othersOpen}
            aria-haspopup="menu"
            title={t.shell.others}
            onClick={() => setOthersOpen(!othersOpen)}
          >
            {t.shell.others}
            <ChevronDown size={12} />
          </button>
          {othersOpen && (
            <div className="mini-shell-menu" role="menu">
              {others.map((o) => (
                <button
                  key={o.name}
                  type="button"
                  role="menuitem"
                  aria-current={o.name === attachment?.name}
                  title={o.cwd}
                  onClick={() => {
                    setOthersOpen(false);
                    // Another shell has its own window: opened beside this one, or brought forward.
                    if (o.name !== attachment?.name)
                      void openMiniShell({ name: o.name, cwd: o.cwd }).catch((e: Error) =>
                        setNote(e.message),
                      );
                  }}
                >
                  <span>{shellLabel(o.cwd)}</span>
                  <small>{o.cwd}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="mini-shell-btn danger"
          disabled={!attachment || status !== 'live'}
          title={t.shell.killTitle}
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
          onClick={closeMiniShell}
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
        {(status === 'ended' || status === 'error') && (
          <div className="mini-shell-state" role={status === 'error' ? 'alert' : 'status'}>
            <span>{status === 'error' ? error : t.shell.ended}</span>
            {status === 'ended' && target.id && (
              <button type="button" className="mini-shell-btn" onClick={() => setRound(round + 1)}>
                {t.shell.reopen}
              </button>
            )}
          </div>
        )}
      </div>
      {(note || elsewhere > 0) && status === 'live' && (
        <footer className="mini-shell-note" role="status">
          {note || t.shell.attachedElsewhere(elsewhere)}
        </footer>
      )}
    </section>
  );
}
