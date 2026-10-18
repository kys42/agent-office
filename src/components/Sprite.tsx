import { MANAGER_ID } from '../shared/manager';
import type { CSSProperties } from 'react';
import type { Mood, Provider, Session } from '../shared/types';
import { SPRITE_ROWS } from '../shared/office-assets';
import { petLook, petAssets, validPetLook, type PetLook } from '../shared/pets';
import { usePetAppearance } from './PetAppearanceContext';
export function Sprite({
  provider,
  mood = 'idle',
  size = 48,
  walking = false,
  direction = 'down',
  flip = false,
  hue = 0,
  session,
  appearance,
}: {
  provider: Provider;
  mood?: Mood;
  size?: number;
  walking?: boolean;
  direction?: 'down' | 'up' | 'side';
  flip?: boolean;
  hue?: number;
  session?: Pick<Session, 'id' | 'actor'>;
  appearance?: PetLook;
}) {
  const customization = usePetAppearance();
  const manager = session?.id === MANAGER_ID;
  const look = validPetLook(appearance)
    ? appearance
    : manager && !customization?.colleagues[MANAGER_ID]
      ? { character: 'retrobot' as const, color: 'butter' as const, accessory: 'none' as const }
      : petLook(provider, customization, session);
  const assets = petAssets(look);
  const spriteStyle = {
    '--size': `${size}px`,
    '--row': walking ? { down: 0, up: 1, side: 2 }[direction] : SPRITE_ROWS[mood],
  } as CSSProperties;
  return (
    <span
      className="sprite-window"
      data-asset-id={assets.id}
      data-pet-color={look.color}
      data-pet-accessory={look.accessory}
      // The flip lives on the window: the sheet's own transform is its frame animation.
      style={{ width: size, height: size, scale: flip ? '-1 1' : undefined }}
      data-office-role={manager ? 'manager' : undefined}
      aria-hidden="true"
    >
      {/*
        One sheet, one animation: the accessory is a second background over the body, so the two
        can never drift apart and a pet without one costs nothing extra.
      */}
      <span
        className={`sprite ${walking ? 'walking' : ''} mood-${mood}`}
        data-decorated={assets.decoration ? 'true' : undefined}
        style={{
          ...spriteStyle,
          backgroundImage: [
            assets.decoration && `url(${walking ? assets.decorationWalk : assets.decoration})`,
            `url(${walking ? assets.walk : assets.sheet})`,
          ]
            .filter(Boolean)
            .join(', '),
          filter: hue ? `hue-rotate(${hue}deg)` : undefined,
        }}
      />
      {manager && (
        <svg
          className="manager-armband"
          data-asset-id="office-manager-armband-v1"
          viewBox="0 0 12 10"
          shapeRendering="crispEdges"
          aria-hidden="true"
        >
          <path fill="#663e27" d="M2 0h8v1h2v8h-2v1H2V9H0V1h2z" />
          <path fill="#f6b84d" d="M2 1h8v1h1v6h-1v1H2V8H1V2h1z" />
          <path fill="#fff5d4" d="M6 1l1 3h3L8 6l1 3-3-2-3 2 1-3-2-2h3z" />
        </svg>
      )}
    </span>
  );
}
