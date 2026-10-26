import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { isMac } from '../lib/platform';
import { shellLabel, type ShellTarget } from '../shared/mini-shell';

// xterm.js is loaded only in a terminal window.
const MiniShellPanel = lazy(() => import('./MiniShellPanel'));

/**
 * The mini terminal's own window (`#shell`, desktop/shell-windows.ts): one folder's shell, the
 * whole window. It is moved by its header; its close button (or the window manager) closes it,
 * which only detaches — tmux keeps the shell.
 */
export function ShellWindow() {
  const { t } = useI18n();
  const [target, setTarget] = useState<ShellTarget | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (!api.shell?.window) {
      setError(t.shell.unsupported);
      return;
    }
    api.shell
      .window('target')
      .then((next) => alive && setTarget(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [t]);
  useEffect(() => {
    document.title = target ? `${t.shell.title} · ${shellLabel(target.cwd)}` : t.shell.title;
  }, [t, target]);
  useEffect(() => {
    const body = document.body.classList;
    body.add('shell-mode');
    body.toggle('is-mac', isMac);
    // A press in the terminal asks for the keyboard: after another app was used, keys would
    // otherwise still go there while the cursor blinks here (as in the colleague card).
    const press = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.xterm'))
        void api.shell?.window('focus').catch(() => {});
    };
    window.addEventListener('pointerdown', press, true);
    return () => {
      body.remove('shell-mode');
      window.removeEventListener('pointerdown', press, true);
    };
  }, []);
  return (
    <div className="shell-window">
      {target ? (
        <Suspense fallback={null}>
          <MiniShellPanel target={target} />
        </Suspense>
      ) : (
        error && (
          <p className="shell-window-error" role="alert">
            {error}
          </p>
        )
      )}
    </div>
  );
}
