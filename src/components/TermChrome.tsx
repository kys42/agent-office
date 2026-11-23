import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ITerminalOptions, Terminal as XTerm } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { isMac } from '../lib/platform';
import { onTermFontSize, setTermFontSize, termFontSize } from '../lib/termFont';
import { webLink } from '../shared/links';
import { macTermKey, nextFontSize, shellQuotePaths, termShortcut } from '../shared/term-keys';

/**
 * Latin from a monospace font; Hangul (none of those have it) from the enlarged system faces in
 * mini-shell.css, which fill a wide character's two cells instead of leaving gaps between them.
 */
export const TERM_HANGUL_FONT = 'Agent Office Term Hangul';
export const TERM_FONT_FAMILY = `"JetBrains Mono", Menlo, Monaco, "${TERM_HANGUL_FONT}", monospace`;

/**
 * Resolves true once the Hangul face is ready, when it was not yet: xterm measures each
 * character once, and a width measured with the fallback font would stay for good.
 */
let hangulReady: Promise<boolean> | null = null;
function loadHangul(): Promise<boolean> {
  const spec = `13px "${TERM_HANGUL_FONT}"`;
  /** A Hangul syllable (U+D55C), so the face's unicode-range is the one asked for. */
  const sample = '\ud55c';
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve(false);
  if (document.fonts.check(spec, sample)) return Promise.resolve(false);
  hangulReady ??= document.fonts
    .load(spec, sample)
    .then((faces) => faces.length > 0)
    .catch(() => false);
  return hangulReady;
}

/**
 * What makes both terminal windows (MiniShellPanel, TermPanel) feel like a Mac terminal: the
 * shared xterm options, Mac editing keys (src/shared/term-keys.ts), ⌘ shortcuts, clickable web
 * links, text size, find, right-click menu and dropped files. A panel creates its xterm with
 * `termOptions`, calls `bind` once it is open, and draws `ui` inside its terminal body; every
 * byte still leaves through the panel's own `onData` → input path.
 */
export const termOptions = (scrollback: number): ITerminalOptions => ({
  fontFamily: TERM_FONT_FAMILY,
  fontSize: termFontSize(),
  lineHeight: 1.15,
  cursorBlink: true,
  scrollback,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  // Unicode 11 widths (Korean, emoji) and search highlights use xterm's proposed API.
  allowProposedApi: true,
  theme: { background: '#1c1c1e', foreground: '#e5e5ea', cursor: '#e5e5ea' },
});

const SEARCH_DECORATIONS = {
  matchBackground: '#5c4d1a',
  matchOverviewRuler: '#a08a3c',
  activeMatchBackground: '#c58a00',
  activeMatchColorOverviewRuler: '#ffcc00',
};

/** A web link opens in the browser through the window's guarded `window.open` (main's handler). */
const openWeb = (uri: string) => {
  const link = webLink(uri);
  if (link) window.open(link, '_blank', 'noopener,noreferrer');
};

interface Live {
  term: XTerm;
  search: SearchAddon;
}
type Menu = { x: number; y: number; selection: boolean };

export function useTermChrome(): {
  bind: (term: XTerm, refit: () => void) => () => void;
  ui: ReactNode;
} {
  const { t } = useI18n();
  const v = t.shell.view;
  const live = useRef<Live | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [fontNote, setFontNote] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  const bind = useCallback((term: XTerm, refit: () => void) => {
    const search = new SearchAddon();
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    // ⌘-click opens a link on a Mac (as in Terminal and iTerm2), so a plain click still selects.
    term.loadAddon(new WebLinksAddon((event, uri) => (!isMac || event.metaKey) && openWeb(uri)));
    live.current = { term, search };
    const results = search.onDidChangeResults((r) =>
      setResult({ index: r.resultIndex, count: r.resultCount }),
    );

    const applyFont = () => {
      const size = termFontSize();
      if (term.options.fontSize === size) return;
      term.options.fontSize = size;
      refit();
    };
    const offFont = onTermFontSize(applyFont);
    // The Hangul face arrived after this terminal opened: measure again with it.
    let bound = true;
    void loadHangul().then((loaded) => {
      if (!bound || !loaded) return;
      const family = term.options.fontFamily ?? TERM_FONT_FAMILY;
      term.options.fontFamily = `${family}, monospace`;
      term.options.fontFamily = family;
      refit();
    });

    term.attachCustomKeyEventHandler((e) => {
      if (!isMac || e.type !== 'keydown') return true;
      const seq = macTermKey(e);
      if (seq !== null) {
        e.preventDefault();
        // Through xterm's own input event: the panel's onData sends it like a typed key.
        term.input(seq, true);
        return false;
      }
      const shortcut = termShortcut(e);
      switch (shortcut) {
        case null:
          return true;
        // The app menu's Copy and Paste reach xterm's own copy and paste handlers (a selection
        // copied, a paste bracketed): xterm only has to not type anything. ⌘C with nothing
        // selected copies nothing and never becomes ^C.
        case 'copy':
        case 'paste':
          return false;
        case 'find':
          e.preventDefault();
          setFinding(true);
          setTimeout(() => findInput.current?.select(), 0);
          return false;
        case 'select-all':
          e.preventDefault();
          term.selectAll();
          return false;
        default:
          e.preventDefault();
          setTermFontSize(nextFontSize(termFontSize(), shortcut));
          setFontNote(Date.now());
          return false;
      }
    });

    const host = term.element;
    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, selection: term.hasSelection() });
    };
    const dropped = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (!dropped(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (!dropped(e)) return;
      e.preventDefault();
      const pathOf = api.termView?.pathForFile;
      if (!pathOf) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      const text = shellQuotePaths(
        files.map((f) => {
          try {
            return pathOf(f);
          } catch {
            return '';
          }
        }),
      );
      if (!text) return;
      term.paste(text);
      term.focus();
    };
    host?.addEventListener('contextmenu', onMenu);
    host?.addEventListener('dragover', onDragOver);
    host?.addEventListener('drop', onDrop);
    return () => {
      bound = false;
      host?.removeEventListener('contextmenu', onMenu);
      host?.removeEventListener('dragover', onDragOver);
      host?.removeEventListener('drop', onDrop);
      offFont();
      results.dispose();
      if (live.current?.term === term) live.current = null;
      setFinding(false);
      setMenu(null);
      setResult(null);
    };
  }, []);

  const find = (backward: boolean, text = query) => {
    const l = live.current;
    if (!l) return;
    if (!text) {
      l.search.clearDecorations();
      setResult(null);
      return;
    }
    const options = { decorations: SEARCH_DECORATIONS };
    if (backward) l.search.findPrevious(text, options);
    else l.search.findNext(text, { ...options, incremental: true });
  };
  const closeFind = () => {
    setFinding(false);
    setResult(null);
    live.current?.search.clearDecorations();
    live.current?.term.focus();
  };

  // The menu closes on any click elsewhere, Escape or the window losing focus.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape only dismisses the menu: it must not reach xterm and the running program.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key, true);
    };
  }, [menu]);
  useEffect(() => {
    if (!fontNote) return;
    const timer = setTimeout(() => setFontNote(0), 1200);
    return () => clearTimeout(timer);
  }, [fontNote]);

  const act = (f: (term: XTerm) => void) => {
    const term = live.current?.term;
    setMenu(null);
    if (!term) return;
    term.focus();
    f(term);
  };
  const paste = api.termView?.paste;
  const ui = (
    <>
      {finding && (
        <div className="term-find" role="search">
          <input
            ref={findInput}
            autoFocus
            value={query}
            placeholder={v.findPlaceholder}
            aria-label={v.find}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              find(false, e.target.value);
            }}
            // Capture phase: the panel stops terminal keys from bubbling to the page's shortcuts,
            // which also keeps them from React's bubbling handlers.
            onKeyDownCapture={(e) => {
              // Composing Korean: Enter finishes the syllable, not a search step.
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                find(e.shiftKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="term-find-count" aria-live="polite">
            {query && result
              ? result.count
                ? v.matches(result.index, result.count)
                : v.noMatch
              : ''}
          </span>
          <button
            type="button"
            aria-label={v.findPrev}
            title={v.findPrev}
            onClick={() => find(true)}
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            aria-label={v.findNext}
            title={v.findNext}
            onClick={() => find(false)}
          >
            <ChevronDown size={13} />
          </button>
          <button type="button" aria-label={v.findClose} title={v.findClose} onClick={closeFind}>
            <X size={13} />
          </button>
        </div>
      )}
      {fontNote > 0 && (
        <p className="term-font-note" role="status">
          {v.fontSize(termFontSize())}
        </p>
      )}
      {menu && (
        <div
          className="term-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 168),
            top: Math.min(menu.y, window.innerHeight - 140),
          }}
          // Clicks inside keep the terminal's keyboard focus (copy reads its selection).
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!menu.selection}
            onClick={() => act(() => document.execCommand('copy'))}
          >
            {v.copy}
          </button>
          {paste && (
            <button
              type="button"
              role="menuitem"
              onClick={() => act(() => void paste().catch(() => {}))}
            >
              {v.paste}
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => act((term) => term.selectAll())}>
            {v.selectAll}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!menu.selection}
            onClick={() => act((term) => term.clearSelection())}
          >
            {v.clearSelection}
          </button>
        </div>
      )}
    </>
  );
  return { bind, ui };
}
