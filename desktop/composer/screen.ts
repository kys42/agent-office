/**
 * A rendered terminal screen: the text as drawn, and — when the host can tell — which characters
 * are drawn faint. Agents draw placeholders and suggestions faint (SGR 2) in the very place typed
 * text goes, so only the style tells them apart.
 */
export interface Screen {
  text: string;
  /**
   * Per line of `text`, per UTF-16 index of that line: drawn faint. Absent when the host reports
   * plain characters only (Orca's `terminal read`).
   */
  faint?: boolean[][];
  /**
   * The composer's text when the host reports it apart from the screen. Orca (1.4.216) returns
   * it as `draft` ("UI-only composer text excluded from tail"): the prompt line then shows only
   * the marker. The suggestion Claude offers was seen here too, and later drawn plain on the
   * prompt line instead (both measured): neither is told from typing without a probe.
   */
  composer?: string;
  /** The pane's height in rows, when the host reports it (tmux). */
  height?: number;
  /**
   * The pane shows its alternate screen (tmux `#{alternate_on}`), when the host reports it.
   * Claude Code's fullscreen renderer draws there and caps its box (see maxBoxRows); its
   * default (inline) renderer draws on the main screen and shows every row of the box. Reported
   * only while the pane's `alternate-screen` option is on: with it off, the fullscreen renderer
   * draws on the main screen too.
   */
  alternate?: boolean;
}

/**
 * Escape sequences: CSI (SGR among them), OSC (hyperlinks, titles), DCS/PM/APC, sequences with
 * intermediate bytes (charset selection such as `ESC ( B`), and the other 2-byte ones.
 */
const SEQUENCE =
  /\x1b(?:\[([0-9;:?<=>]*)([ -/]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]+[0-~]|[0-~])/y;
/** Other control characters (SO/SI, BEL, CR…): never drawn. Tabs and line breaks stay. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** The faint state after one SGR sequence. Colour arguments (38;5;n, 38;2;r;g;b) are skipped. */
function applySgr(params: string, faint: boolean): boolean {
  const parts = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const [head, ...sub] = parts[i].split(':');
    const code = Number(head || '0');
    if (code === 0 || code === 22) faint = false;
    else if (code === 2) faint = true;
    else if ((code === 38 || code === 48 || code === 58) && sub.length === 0) {
      if (parts[i + 1] === '5') i += 2;
      else if (parts[i + 1] === '2') i += 4;
    }
  }
  return faint;
}

/**
 * Reads `tmux capture-pane -p -e` output. The text equals the plain capture (`-p`); attributes
 * carry over line breaks, as tmux only writes them where they change.
 */
export function parseStyledScreen(raw: string): Screen {
  const lines: string[] = [];
  const faint: boolean[][] = [];
  let line = '';
  let flags: boolean[] = [];
  let dim = false;
  for (let i = 0; i < raw.length;) {
    const char = raw[i];
    if (char === '\x1b') {
      SEQUENCE.lastIndex = i;
      const m = SEQUENCE.exec(raw);
      if (!m) {
        i++;
        continue;
      }
      if (m[3] === 'm' && !m[2] && !/[?<=>]/.test(m[1] ?? '')) dim = applySgr(m[1] ?? '', dim);
      i = SEQUENCE.lastIndex;
      continue;
    }
    if (CONTROL.test(char)) {
      i++;
      continue;
    }
    if (char === '\n') {
      lines.push(line);
      faint.push(flags);
      line = '';
      flags = [];
    } else {
      line += char;
      flags.push(dim);
    }
    i++;
  }
  lines.push(line);
  faint.push(flags);
  return { text: lines.join('\n'), faint };
}

/** Equal as drawn: no spacing or wrapping, no invisible joiners and variation selectors. */
export const drawn = (value: string) =>
  value.normalize('NFC').replace(/[\s\u200b-\u200d\u2060\ufe0e\ufe0f]+/g, '');

const invisible = (value: string) =>
  value.normalize('NFC').replace(/[\u200b-\u200d\u2060\ufe0e\ufe0f]+/g, '');

/**
 * `shown` (rows read from the box, each trimmed) is exactly `text` as the box wraps it: every row
 * is a stretch of the text, spaces inside it included, and between rows the text has only
 * whitespace (a line break, the space the wrap took, indentation) or nothing (a word split by the
 * wrap). Unlike `drawn`, a space taken out or added inside a row is a different text.
 */
export function sameWrapped(shown: string, text: string): boolean {
  const rows = invisible(shown)
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  const source = invisible(text);
  const skip = (at: number) => {
    while (at < source.length && /\s/.test(source[at])) at++;
    return at;
  };
  let at = skip(0);
  for (const row of rows) {
    if (!source.startsWith(row, at)) return false;
    at = skip(at + row.length);
  }
  return at === source.length;
}
