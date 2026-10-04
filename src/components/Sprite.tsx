import type { CSSProperties } from 'react';
import type { Mood, Provider } from '../shared/types';
import { SPRITE_ASSETS, SPRITE_ROWS } from '../shared/office-assets';
export function Sprite({
  provider,
  mood = 'idle',
  size = 48,
  walking = false,
  direction = 'down',
  flip = false,
  hue = 0,
}: {
  provider: Provider;
  mood?: Mood;
  size?: number;
  walking?: boolean;
  direction?: 'down' | 'up' | 'side';
  flip?: boolean;
  hue?: number;
}) {
  return (
    <span
      className="sprite-window"
      data-asset-id={SPRITE_ASSETS[provider].id}
      style={{ width: size, height: size, filter: hue ? `hue-rotate(${hue}deg)` : undefined }}
      aria-hidden="true"
    >
      <span
        className={`sprite ${walking ? 'walking' : ''} mood-${mood}`}
        style={
          {
            '--size': `${size}px`,
            '--row': walking ? { down: 0, up: 1, side: 2 }[direction] : SPRITE_ROWS[mood],
            backgroundImage: `url(${walking ? SPRITE_ASSETS[provider].walk : SPRITE_ASSETS[provider].sheet})`,
            transform: flip ? 'scaleX(-1)' : undefined,
          } as CSSProperties
        }
      />
    </span>
  );
}
