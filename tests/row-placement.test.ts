import test from 'node:test';
import assert from 'node:assert/strict';
import type { RowLayout } from '../src/shared/office-layout';
import { positionRow, readRowPositions, rememberRowPositions } from '../src/shared/row-placement';

function row(widths: number[], gap = 18): RowLayout {
  let x = 0;
  const zones = widths.map((width, i) => {
    const zone = {
      key: `zone-${i}`,
      name: `Team ${i}`,
      x,
      width,
      stations: [{ id: `pet-${i}`, x: 12 }],
      helpers: [{ id: `helper-${i}`, parent: `pet-${i}`, x: 176 }],
      benches: [
        { key: `bench-${i}`, members: [`pet-${i}`], x: 17, width: width - 24, shared: false },
      ],
    };
    x += width + gap;
    return zone;
  });
  return { zones, width: Math.max(0, x - gap), count: widths.length * 2 };
}

test('Default row remains centered; saved left/right anchors follow available screen width', () => {
  const base = row([200]);
  assert.equal(positionRow(base, 1000, {}).zones[0].x, 400);
  assert.equal(positionRow(base, 1000, { 'zone-0': 0 }).zones[0].x, 0);
  assert.equal(positionRow(base, 1000, { 'zone-0': 1 }).zones[0].x, 800);
  assert.equal(positionRow(base, 600, { 'zone-0': 1 }).zones[0].x, 400);
  assert.deepEqual(base, row([200]), 'source topology is untouched');
});

test('Dragging can reorder groups without breaking benches or helper placement', () => {
  const base = row([200, 300, 180], 56);
  const placed = positionRow(base, 1200, {}, { key: 'zone-0', x: 1000 });
  assert.deepEqual(
    [...placed.zones].sort((a, b) => a.x - b.x).map((z) => z.key),
    ['zone-1', 'zone-2', 'zone-0'],
  );
  for (const zone of placed.zones) {
    const original = base.zones.find((z) => z.key === zone.key)!;
    assert.deepEqual(zone.stations, original.stations);
    assert.deepEqual(zone.benches, original.benches);
    assert.deepEqual(zone.helpers, original.helpers);
  }
});

test('Crowded and changing rows never overlap or shrink furniture', () => {
  for (let count = 1; count <= 12; count++)
    for (const gap of [18, 56]) {
      const base = row(
        Array.from({ length: count }, (_, i) => 188 + i * 21),
        gap,
      );
      for (const available of [100, base.width, base.width + 700]) {
        const positions = Object.fromEntries(base.zones.map((z, i) => [z.key, (i % 3) / 2]));
        const placed = positionRow(base, available, positions, { key: 'zone-0', x: available * 2 });
        assert.ok(placed.width >= base.width);
        const ordered = [...placed.zones].sort((a, b) => a.x - b.x);
        assert.ok(ordered[0].x >= -0.00001);
        for (let i = 1; i < count; i++)
          assert.ok(ordered[i].x >= ordered[i - 1].x + ordered[i - 1].width + gap - 0.00001);
        assert.ok(ordered.at(-1)!.x + ordered.at(-1)!.width <= placed.width + 0.00001);
        assert.deepEqual(
          placed.zones.map((z) => z.width).sort((a, b) => a - b),
          base.zones.map((z) => z.width).sort((a, b) => a - b),
        );
      }
    }
});

test('Remembering stores resolved neighbors and retains hidden groups; reload reproduces placement', () => {
  const base = row([200, 300]);
  const placed = positionRow(base, 1000, {}, { key: 'zone-0', x: 800 });
  const saved = rememberRowPositions({ hidden: 0.6 }, placed);
  assert.equal(saved.hidden, 0.6);
  assert.deepEqual(positionRow(base, 1000, readRowPositions(JSON.stringify(saved))), placed);
  const bigger = positionRow(row([400, 300, 200]), 1000, saved);
  assert.ok(bigger.zones.every((z) => z.x >= 0 && z.x + z.width <= bigger.width));
});

test('Malformed, oversized and nonfinite saved positions are ignored safely', () => {
  for (const raw of [null, 'oops', 'null', '[]', '1', '"hello"', ' '.repeat(250001)])
    assert.deepEqual(readRowPositions(raw), {});
  assert.deepEqual(
    readRowPositions(
      '{"left":0,"right":1,"middle":0.5,"bad":-1,"over":2,"text":"0.2","null":null,"infinite":1e999}',
    ),
    { left: 0, right: 1, middle: 0.5 },
  );
  assert.equal(
    Object.keys(
      readRowPositions(
        JSON.stringify(Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`z${i}`, 0.5]))),
      ),
    ).length,
    500,
  );
  const positions = readRowPositions('{"__proto__":0.5}');
  assert.equal(Object.hasOwn(positions, '__proto__'), true);
  assert.equal(
    positionRow(row([200]), 1000, {}).zones[0].x,
    400,
    'inherited properties are not positions',
  );
});
