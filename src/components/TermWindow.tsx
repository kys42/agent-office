import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n, useSharedLocale } from '../lib/i18n';
import { isMac } from '../lib/platform';
import type { TermTarget } from '../shared/term-view';

// xterm.js is loaded only in a terminal window.
const TermPanel = lazy(() => import('./TermPanel'));

/**
 * The built-in terminal's own window (`#term`, desktop/term-windows.ts, #401): one session of
 * the app's terminal host, the whole window. Main chose the session; the window only asks what
 * it shows. Closing it only detaches: the session keeps running in the daemon.
 */
export function TermWindow() {
  const { t } = useI18n();
  useSharedLocale();
  const [target, setTarget] = useState<TermTarget | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (!api.term?.window) {
      setError(t.launch.builtinUnsupported);
      return;
    }
    api.term
      .window('target')
      .then((next) => alive && setTarget(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [t]);
  useEffect(() => {
    const name = t.launch.destination.builtin;
    document.title = target ? `${name} · ${target.title}` : name;
  }, [t, target]);
  useEffect(() => {
    const body = document.body.classList;
    body.add('shell-mode');
    body.toggle('is-mac', isMac);
    // A press in the terminal asks for the keyboard, as in the mini terminal's window.
    const press = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.xterm'))
        void api.term?.window('focus').catch(() => {});
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
          <TermPanel target={target} />
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
