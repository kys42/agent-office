/**
 * Widths of the big office's left menu and right column, as the person dragged them, fitted to
 * the window as it is now: the office keeps its room however the window or the menu changes.
 * The defaults follow tokens.css (wide windows and ≤1180px ones).
 */
export const PANEL = {
  sideMin: 180,
  sideMax: 360,
  dockMin: 300,
  dockMax: 760,
  /** Room the office keeps between the columns. */
  stageMin: 480,
  /** Narrower windows float the card over the office (and phones stack): no dragged widths. */
  resizeFrom: 1101,
} as const;

export interface PanelWidths {
  side?: number;
  dock?: number;
}

/** Where the big office keeps the dragged widths (with `at`, when they were last dragged). */
export const PANEL_WIDTHS_KEY = 'office:panel-widths';

/** When the saved widths were dragged (0: unknown, saved before #228). */
export function readWidthsAt(raw: string | null): number {
  try {
    const at = (JSON.parse(raw ?? '{}') as { at?: unknown } | null)?.at;
    return typeof at === 'number' && Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** Saved widths, with anything that is not a sensible number left out. */
export function readWidths(raw: string | null): PanelWidths {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '{}');
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const { side, dock } = value as Record<string, unknown>;
  const ok = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) ? clamp(n, min, max) : undefined;
  const out: PanelWidths = {};
  const s = ok(side, PANEL.sideMin, PANEL.sideMax);
  const d = ok(dock, PANEL.dockMin, PANEL.dockMax);
  if (s !== undefined) out.side = s;
  if (d !== undefined) out.dock = d;
  return out;
}

export function defaultSide(viewport: number) {
  return viewport <= 1180 ? 200 : 224;
}
export function defaultDock(viewport: number) {
  return viewport <= 1180 ? 330 : Math.round(clamp(viewport * 0.25, 330, 380));
}

/**
 * The widths to draw: the saved ones (or the defaults) shrunk until the office keeps its room.
 * `sidebar`/`dock` say whether those columns are shown now. `css` holds only what overrides the
 * stylesheet: nothing below `resizeFrom`, where the responsive layout takes over.
 */
export function fitPanels(
  saved: PanelWidths,
  viewport: number,
  shown: { sidebar: boolean; dock: boolean },
) {
  const side0 = shown.sidebar
    ? clamp(saved.side ?? defaultSide(viewport), PANEL.sideMin, PANEL.sideMax)
    : 0;
  const dock0 = shown.dock
    ? clamp(saved.dock ?? defaultDock(viewport), PANEL.dockMin, PANEL.dockMax)
    : 0;
  const dockMax = Math.max(
    PANEL.dockMin,
    Math.min(PANEL.dockMax, viewport - side0 - PANEL.stageMin),
  );
  const dock = Math.min(dock0, dockMax);
  const sideMax = Math.max(
    PANEL.sideMin,
    Math.min(PANEL.sideMax, viewport - dock - PANEL.stageMin),
  );
  const side = Math.min(side0, sideMax);
  const css: PanelWidths = {};
  if (viewport >= PANEL.resizeFrom) {
    if (saved.side !== undefined && shown.sidebar) css.side = side;
    if (saved.dock !== undefined && shown.dock) css.dock = dock;
  }
  return { side, dock, sideMax, dockMax, css };
}

function clamp(n: number, min: number, max: number) {
  return Math.round(Math.min(Math.max(n, min), max));
}
