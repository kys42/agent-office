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
    transform: flip ? 'scaleX(-1)' : undefined,
  } as CSSProperties;
  return (
    <span
      className="sprite-window"
      data-asset-id={assets.id}
      data-pet-color={look.color}
      data-pet-accessory={look.accessory}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className={`sprite ${walking ? 'walking' : ''} mood-${mood}`}
        style={{
          ...spriteStyle,
          backgroundImage: `url(${walking ? assets.walk : assets.sheet})`,
          filter: hue ? `hue-rotate(${hue}deg)` : undefined,
        }}
      />
      {/* Keep both timelines mounted, even with no accessory, so selecting a hat stays in sync. */}
      <span
        className={`sprite sprite-decoration ${walking ? 'walking' : ''} mood-${mood}`}
        style={{
          ...spriteStyle,
          backgroundImage: assets.decoration
            ? `url(${walking ? assets.decorationWalk : assets.decoration})`
            : 'none',
        }}
      />
    </span>
  );
}
