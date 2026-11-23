// A small stand-in for an Ink app (Claude Code's input box) in the built-in terminal's tests:
// raw mode with bracketed paste, an input box kept at the bottom and redrawn on every chunk of
// input by erasing the previous frame line by line (cursor up + erase line) inside a
// synchronized update, long Korean lines wrapped by display width. A resize clears and redraws.
// With INK_CARET=1 it parks the cursor at the end of the typed text, as an app showing an IME
// caret does: the frame's end is saved (DECSC) and restored (DECRC) before the next redraw.
// Every byte it writes is also appended to the file named by INK_LOG (a reference terminal
// fed the same bytes shows what the view should show).
import { appendFileSync } from 'node:fs';

const log = process.env.INK_LOG;
const out = (s) => {
  process.stdout.write(s);
  if (log) appendFileSync(log, s);
};
const wide = (c) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/.test(c);
const width = (s) => [...s].reduce((n, c) => n + (wide(c) ? 2 : 1), 0);
function wrap(text, cols) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const c of para) {
      if (width(line) + width(c) > cols) {
        lines.push(line);
        line = '';
      }
      line += c;
    }
    lines.push(line);
  }
  return lines;
}
let text = '';
let previous = 0;
// What Ink keeps above the live frame (Claude Code's transcript): redrawn in full whenever the
// frame no longer fits the screen, as Ink does (clear the terminal, then everything again).
const history = Array.from(
  { length: Number(process.env.INK_HISTORY ?? 0) },
  (_, i) =>
    `\x1b[1m⏺\x1b[22m ${i}번째 답변: 이전 대화 내용이 여기에 길게 이어집니다. 한국어 문장과 English words 가 섞여 있습니다.`,
);
let renders = 0;
let answered = 0;
const caret = process.env.INK_CARET === '1';
let parked = false;
function frame() {
  const cols = process.stdout.columns || 80;
  const inner = cols - 4;
  return [
    '\x1b[2m╭' + '─'.repeat(cols - 2) + '╮\x1b[22m',
    ...wrap(text, inner).map((l) => '│ ' + l + ' '.repeat(inner - width(l)) + ' │'),
    '\x1b[2m╰' + '─'.repeat(cols - 2) + '╯\x1b[22m',
    `  \x1b[2m? for shortcuts · ${[...text].length} chars · ${answered} answers\x1b[22m`,
  ];
}
/** `above`: lines printed once above the frame (an answer streaming in, Ink's static output). */
function render(clear = false, above = '') {
  let s = '\x1b[?2026h';
  const lines = frame();
  const rows = process.stdout.rows || 24;
  renders++;
  if (clear || lines.length >= rows)
    s += '\x1b[2J\x1b[3J\x1b[H' + history.map((h) => h + '\r\n').join('');
  else if (previous > 0) {
    if (parked) s += '\x1b8';
    for (let i = 0; i < previous; i++) s += '\x1b[2K' + (i < previous - 1 ? '\x1b[1A' : '');
    s += '\x1b[G';
  }
  s += above;
  previous = lines.length;
  s += lines.join('\r\n');
  parked = caret;
  if (caret) {
    const typed = wrap(text, (process.stdout.columns || 80) - 4);
    s += `\x1b7\x1b[${lines.length - 1 - typed.length}A\x1b[${3 + width(typed.at(-1))}G`;
  }
  out(s + '\x1b[?2026l');
}
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out('\x1b[?2004h' + 'ink-like ready\r\n'.repeat(3));
render();
process.stdin.on('data', (chunk) => {
  if (chunk === '\x03') {
    out('\x1b[?2004l\r\n');
    process.exit(0);
  }
  // Each ^F: a long answer streams in above the input box.
  const answers = chunk.split('\x06').length - 1;
  chunk = chunk.replaceAll('\x06', '');
  for (let i = 0; i < answers; i++) {
    answered++;
    render(false, history.map((h) => h + '\r\n').join(''));
  }
  if (!chunk) return;
  text += chunk.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n');
  render();
});
process.on('SIGWINCH', () => render(true));
