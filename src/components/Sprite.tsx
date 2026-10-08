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
  const look = validPetLook(appearance) ? appearance : petLook(provider, customization, session);
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
    </span>
  );
}
