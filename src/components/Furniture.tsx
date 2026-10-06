import type { CSSProperties } from 'react';
import { FURNITURE_ASSETS, OFFICE_PALETTES, type OfficeAppearance } from '../shared/office-assets';

export function appearanceStyle(appearance: OfficeAppearance = {}): CSSProperties {
  const p = OFFICE_PALETTES[appearance.palette ?? 'oak'];
  return {
    '--asset-top': p.top,
    '--asset-wood': p.wood,
    '--asset-edge': p.edge,
    '--asset-fabric': p.fabric,
    '--asset-light': p.light,
  } as CSSProperties;
}
/** Furniture owns its appearance; the scene supplies coordinates and interaction. */
export function Furniture({
  kind,
  style,
  shared = false,
  appearance = {},
  assetKey,
}: {
  kind: keyof typeof FURNITURE_ASSETS;
  style?: CSSProperties;
  shared?: boolean;
  appearance?: OfficeAppearance;
  assetKey?: string;
}) {
  const className = {
    desk: `team-bench ${shared ? 'shared-bench' : ''}`,
    chair: 'office-chair',
    equipment: 'desk-equipment',
    helper: 'helper-table',
    sofa: 'rest-furniture rest-sofa',
    bed: 'rest-furniture rest-bed',
  }[kind];
  return (
    <div
      className={className}
      data-asset-id={FURNITURE_ASSETS[kind]}
      data-furniture={kind === 'helper' ? 'helper-desk' : kind}
      data-bench-key={assetKey}
      style={{ ...appearanceStyle(appearance), ...style }}
      aria-hidden="true"
    >
      {kind === 'desk' && <span className="bench-surface" />}
      {kind === 'equipment' && (
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
