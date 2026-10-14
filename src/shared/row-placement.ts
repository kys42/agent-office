import type { RowLayout } from './office-layout';

/** Left edge as a fraction of the space this zone can move through. Shared by row/floor. */
export type RowPositions = Record<string, number>;
const MAX_ZONES = 500;
const clamp = (n: number, max = 1) => Math.max(0, Math.min(max, n));

export function readRowPositions(raw: string | null): RowPositions {
  if (!raw || raw.length > 250_000) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, x]) =>
            key.length <= 400 && typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1,
        )
        .slice(-MAX_ZONES),
    );
  } catch {
    return {};
  }
}

/** Preserve topology; spread zones through the lane, pushing neighbors aside without overlap. */
export function positionRow(
  base: RowLayout,
  available: number,
  positions: RowPositions,
  moving?: { key: string; x: number } | null,
): RowLayout {
  const width = Math.max(base.width, Number.isFinite(available) ? available : 0);
  const gap = base.zones.length > 1 ? base.zones[1].x - base.zones[0].x - base.zones[0].width : 0;
  const zones = base.zones
    .map((zone, order) => {
      const saved = Object.hasOwn(positions, zone.key) ? positions[zone.key] : undefined;
      const wanted =
        moving?.key === zone.key
          ? moving.x
          : typeof saved === 'number' && Number.isFinite(saved)
            ? clamp(saved) * (width - zone.width)
            : zone.x + (width - base.width) / 2;
      return { ...zone, x: clamp(wanted, width - zone.width), order };
    })
    .sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2) || a.order - b.order);
  let edge = 0;
  for (const zone of zones) {
    zone.x = Math.max(zone.x, edge);
    edge = zone.x + zone.width + gap;
  }
  edge = width;
  for (const zone of [...zones].reverse()) {
    zone.x = Math.min(zone.x, edge - zone.width);
    edge = zone.x - gap;
  }
  // Moving a captured node in the DOM releases pointer capture in Chromium. Keep the
  // source order stable; absolute coordinates alone determine the visual order.
  return {
    ...base,
    width,
    zones: zones.sort((a, b) => a.order - b.order).map(({ order: _order, ...zone }) => zone),
  };
}

/** Remember resolved positions, including displaced neighbors; retain temporarily hidden zones. */
export function rememberRowPositions(previous: RowPositions, layout: RowLayout): RowPositions {
  const saved = new Map(Object.entries(previous));
  for (const zone of layout.zones) {
    saved.delete(zone.key);
    saved.set(
      zone.key,
      layout.width > zone.width ? clamp(zone.x / (layout.width - zone.width)) : 0,
    );
  }
  return Object.fromEntries([...saved].slice(-MAX_ZONES));
}
