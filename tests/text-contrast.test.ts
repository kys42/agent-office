import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `--text-3` carries text people read (project names, times, hints), so it has to clear 4.5:1
 * on the chrome surfaces in both appearances while `--text-2` above it and the decorative
 * `--text-4` below it stay apart. The desktop HUD windows copy the dark palette into
 * `body.dock-mode`; that copy must not drift from tokens.css.
 */
const styles = path.join(import.meta.dirname, '..', 'src', 'styles');
const tokens = readFileSync(path.join(styles, 'tokens.css'), 'utf8');
const native = readFileSync(path.join(styles, 'native.css'), 'utf8');

function vars(block: string) {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].replace(/\s+/g, ' ').trim(),
    ]),
  );
}
function body(text: string, start: RegExp) {
  const at = text.search(start);
  assert.ok(at >= 0, `${start} is still there`);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`${start} is not closed`);
}

const light = vars(body(tokens, /^:root \{/m));
const dark = vars(body(body(tokens, /^@media \(prefers-color-scheme: dark\)/m), /:root \{/));
const dock = vars(body(native, /^body\.dock-mode \{/m));

function luminance(hex: string) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `${hex} is a solid colour`);
  return [0, 2, 4]
    .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes = [
  { name: 'light', palette: light, surfaces: ['--bg-0', '--bg-1', '--sidebar', '--grouped'] },
  { name: 'dark', palette: dark, surfaces: ['--bg-0', '--bg-1', '--bg-2', '--sidebar'] },
  { name: 'dock', palette: dock, surfaces: ['--bg-0', '--bg-1', '--bg-2', '--sidebar'] },
];

for (const { name, palette, surfaces } of themes) {
  test(`${name}: --text-3 reads at 4.5:1 on the chrome surfaces`, () => {
    for (const surface of surfaces) {
      const value = ratio(palette.get('--text-3')!, palette.get(surface)!);
      assert.ok(value >= 4.5, `${name} --text-3 on ${surface}: ${value.toFixed(2)}`);
    }
  });

  test(`${name}: text, text-2, text-3 and text-4 stay in order and apart`, () => {
    const on = palette.get('--bg-1')!;
    const [text, text2, text3, text4] = ['--text', '--text-2', '--text-3', '--text-4'].map((v) =>
      ratio(palette.get(v)!, on),
    );
    assert.ok(text > text2 && text2 > text3 && text3 > text4, `${name} order`);
    // A darker --text-3 must not swallow --text-2: secondary copy still reads as a step above.
    assert.ok(text2 / text3 >= 1.2, `${name} text-2 / text-3: ${(text2 / text3).toFixed(2)}`);
  });
}

test('the desktop HUD windows use the same dark palette as tokens.css', () => {
  assert.ok(dock.size > 30, 'the dock-mode palette was found');
  const drift = [...dock].filter(([v, value]) => dark.has(v) && dark.get(v) !== value);
  assert.deepEqual(
    drift.map(([v, value]) => `${v}: dock ${value} vs dark ${dark.get(v)}`),
    [],
  );
  const missing = ['--text', '--text-2', '--text-3', '--text-4'].filter((v) => !dock.has(v));
  assert.deepEqual(missing, []);
});
