import type { CSSProperties } from 'react';
import { FURNITURE_ASSETS, OFFICE_PALETTES, type OfficeAppearance } from '../shared/office-assets';
import {
  DESK_BOXES,
  DESK_MONITORS,
  deskAssets,
  type DeskLook,
  type DeskRect,
} from '../shared/desks';

export function appearanceStyle(appearance: OfficeAppearance = {}): CSSProperties {
  const p = OFFICE_PALETTES[appearance.palette ?? 'oak'];
  return {
    '--asset-top': p.top,
    '--asset-wood': p.wood,
    '--asset-edge': p.edge,
    '--asset-fabric': p.fabric,
    '--asset-light': p.light,
    '--asset-rim': p.rim,
    '--asset-side': p.side,
    '--asset-leg': p.leg,
  } as CSSProperties;
}
const box = ([left, top, width, height]: DeskRect, image?: string): CSSProperties => ({
  left,
  top,
  width,
  height,
  ...(image ? { backgroundImage: `url(${image})` } : {}),
});
/**
 * Furniture owns its appearance; the scene supplies coordinates and interaction. A desk `look`
 * (desks.ts) draws the bench top, chair and equipment from the customizable layers; without one
 * they keep the plain CSS desk.
 */
export function Furniture({
  kind,
  style,
  shared = false,
  appearance = {},
  look,
  assetKey,
}: {
  kind: keyof typeof FURNITURE_ASSETS;
  style?: CSSProperties;
  shared?: boolean;
  appearance?: OfficeAppearance;
  look?: DeskLook;
  assetKey?: string;
}) {
  const className = {
    desk: `team-bench ${shared ? 'shared-bench' : ''}`,
    chair: `office-chair ${look ? 'is-sprite' : ''}`,
    equipment: 'desk-equipment',
    helper: 'helper-table',
    sofa: 'rest-furniture rest-sofa',
    bed: 'rest-furniture rest-bed',
  }[kind];
  const assets = look && deskAssets(look);
  const layers = look && {
    'data-desk-top': kind === 'desk' ? look.top : undefined,
    'data-desk-chair': kind === 'chair' ? look.chair : undefined,
    'data-desk-monitor': kind === 'equipment' ? look.monitor : undefined,
    'data-desk-items': kind === 'equipment' ? `${look.itemLeft},${look.itemRight}` : undefined,
  };
  return (
    <div
      className={className}
      data-asset-id={FURNITURE_ASSETS[kind]}
      data-furniture={kind === 'helper' ? 'helper-desk' : kind}
      data-bench-key={assetKey}
      {...layers}
      style={{
        ...appearanceStyle(look ? { ...appearance, palette: look.top } : appearance),
        ...(kind === 'chair' && assets ? box(DESK_BOXES.chair, assets.chair) : {}),
        ...style,
      }}
      aria-hidden="true"
    >
      {kind === 'desk' && <span className="bench-surface" />}
      {kind === 'equipment' && look && assets && (
        <>
          <i className="desk-monitor" style={box(DESK_BOXES.monitor, assets.monitor)} />
          {DESK_MONITORS[look.monitor].screens.map((rect, i) => (
            <i className="desk-screen" key={i} style={box(rect)} />
          ))}
          <i className="desk-keyboard" />
          {assets.itemLeft && (
            <i className="desk-item" style={box(DESK_BOXES.itemLeft, assets.itemLeft)} />
          )}
          {assets.itemRight && (
            <i className="desk-item" style={box(DESK_BOXES.itemRight, assets.itemRight)} />
          )}
        </>
      )}
      {kind === 'equipment' && !look && (
        <>
          <i className="desk-screen" />
          <i className="desk-keyboard" />
          {appearance.accessory !== 'none' && (
            <i className={appearance.accessory === 'plant' ? 'desk-plant' : 'desk-cup'} />
          )}
        </>
      )}
      {(kind === 'sofa' || kind === 'bed') && (
        <>
          <i className="rest-cushion" />
          <i className="rest-blanket" />
        </>
      )}
    </div>
  );
}
