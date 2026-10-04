import type { CSSProperties } from 'react';
import type { Mood, Provider } from '../shared/types';
const rows: Record<Mood, number> = {
  idle: 0,
  work: 1,
  think: 2,
  call: 3,
  done: 4,
  error: 5,
  sleep: 6,
  leave: 7,
};
export function Sprite({
  provider,
  mood = 'idle',
  size = 48,
  walking = false,
  direction = 'down',
  flip = false,
}: {
  provider: Provider;
  mood?: Mood;
  size?: number;
  walking?: boolean;
  direction?: 'down' | 'up' | 'side';
  flip?: boolean;
}) {
  return (
    <span className="sprite-window" style={{ width: size, height: size }} aria-hidden="true">
      <span
        className={`sprite ${walking ? 'walking' : ''} mood-${mood}`}
        style={
          {
            '--size': `${size}px`,
            '--row': walking ? { down: 0, up: 1, side: 2 }[direction] : rows[mood],
            backgroundImage: `url(./sprites/${provider}${walking ? '_walk' : ''}.png)`,
            transform: flip ? 'scaleX(-1)' : undefined,
          } as CSSProperties
        }
      />
    </span>
  );
}
