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
}

/** Escape sequences: CSI (SGR among them), OSC (hyperlinks, titles), DCS/PM/APC, and 2-byte ones. */
const SEQUENCE =
  /\x1b(?:\[([0-9;:?<=>]*)([ -/]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -~])/y;

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
