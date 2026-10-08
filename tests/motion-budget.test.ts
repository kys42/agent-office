import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The office never stops moving, so what keeps moving must be cheap: animations that loop
 * forever may only change what the compositor can animate on its own. Anything else (a
 * background-position, a box-shadow, a filter) runs style and paint on the main thread every
 * display frame for as long as it loops (#52).
 */
const COMPOSITOR = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate']);
const dir = path.join(import.meta.dirname, '..', 'src', 'styles');
const css = readdirSync(dir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8') }));

function keyframes() {
  const found = new Map<string, { file: string; props: string[] }>();
  for (const { file, text } of css)
    for (const m of text.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g))
      found.set(m[1], {
        file,
        props: [...new Set([...m[2].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]))],
      });
  return found;
}

test('Looping animations change only what the compositor animates', () => {
  const frames = keyframes();
  assert.ok(frames.size > 20, 'keyframes were found');
  const looping = new Set<string>();
  for (const { text } of css)
    for (const m of text.matchAll(/animation(?:-name)?\s*:([^;]*);/g))
      if (/\binfinite\b/.test(m[1]))
        for (const name of frames.keys())
          if (new RegExp(`\\b${name}\\b`).test(m[1])) looping.add(name);
  assert.ok(looping.has('sprite-frames'), 'the sprite loop is checked');
  const costly = [...looping].flatMap((name) => {
    const { file, props } = frames.get(name)!;
    const bad = props.filter((p) => !COMPOSITOR.has(p));
    return bad.length ? [`${file} @keyframes ${name}: ${bad.join(', ')}`] : [];
  });
  assert.deepEqual(costly, []);
});

test('Nothing always on screen blurs or blends the moving office behind it', () => {
  const office = css.find((c) => c.file === 'office.css')!.text;
  const rule = (selector: string) =>
    office.match(new RegExp(`\\n${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
  assert.doesNotMatch(rule('.scene-controls'), /backdrop-filter/);
  assert.doesNotMatch(rule('.desk-glow'), /mix-blend-mode/);
});
