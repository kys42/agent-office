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
          // Whole names only: `typing` is not `bubble-typing`.
          if (new RegExp(`(^|[\\s,])${name}(?=[\\s,]|$)`).test(m[1].trim())) looping.add(name);
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
  const rule = (selector: string) => {
    const body = office.match(
      new RegExp(`\\n${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`),
    )?.[1];
    assert.ok(body, `${selector} is still styled here`);
    return body;
  };
  assert.doesNotMatch(rule('.scene-controls'), /backdrop-filter/);
  assert.doesNotMatch(rule('.desk-glow'), /mix-blend-mode/);
});

test('Looping animations step on the office clock (#52)', async () => {
  const { FRAME_MS } = await import('../src/lib/frame-clock.js');
  const ms = (t: string) => (t.endsWith('ms') ? parseFloat(t) : parseFloat(t) * 1000);
  const times = (value: string) => [...value.matchAll(/-?\d*\.?\d+m?s\b/g)].map((m) => m[0]);
  const off: string[] = [];
  // Whole declarations (they may span lines), one animation layer per comma.
  for (const { file, text } of css)
    for (const [, prop, value] of text.matchAll(
      /(animation(?:-duration|-delay)?)\s*:([^;{}]*);/g,
    )) {
      // Layers split on top-level commas only (not inside steps(), cubic-bezier() or var()).
      for (const layer of value.split(/,(?![^(]*\))/)) {
        if (/calc|var\(/.test(layer)) continue;
        const where = `${file} ${prop}: ${layer.trim()}`;
        if (prop === 'animation') {
          if (!/\binfinite\b/.test(layer) || /\bspin\b/.test(layer)) continue;
          const [duration, delay] = times(layer);
          // A stepped loop's duration covers whole office frames per step.
          const steps = Number(layer.match(/steps\((\d+)/)?.[1] ?? 1);
          if (duration && ms(duration) % (FRAME_MS * steps)) off.push(where);
          if (delay && ms(delay) % FRAME_MS) off.push(where);
        } else for (const t of times(layer)) if (ms(t) % FRAME_MS) off.push(where);
      }
    }
  assert.deepEqual(off, []);
});

test('Sprite speeds keep every one of the four frames on the office clock', async () => {
  const { FRAME_MS } = await import('../src/lib/frame-clock.js');
  const tokens = css.find((c) => c.file === 'tokens.css')!.text;
  const speeds = [
    ...tokens.matchAll(/\n\.sprite[^{]*\{[^}]*?animation(?:-duration)?\s*:[^;]*?(\d*\.?\d+m?s)/g),
  ];
  assert.ok(speeds.length >= 5, 'sprite speeds were found');
  const ms = (t: string) => (t.endsWith('ms') ? parseFloat(t) : parseFloat(t) * 1000);
  // Four frames, each a whole number of office frames.
  assert.deepEqual(
    speeds.map((m) => m[1]).filter((t) => ms(t) % (4 * FRAME_MS)),
    [],
  );
});
