import type { CSSProperties } from 'react';
import type { PetReaction } from '../lib/petReaction';

const MARKS = { pat: ['♥', '♥', '♥'], praise: ['✦', '★', '✧'] } as const;

/**
 * What a pleased pet gives off, inside its pet box: blushing cheeks and a few marks that rise
 * and fade (hearts when petted, sparkles when praised). Re-keyed per reaction by the caller.
 */
export function PetJoy({ reaction }: { reaction: PetReaction }) {
  return (
    <span className={`pet-joy joy-${reaction.kind}`} aria-hidden="true">
      <i className="joy-cheek left" />
      <i className="joy-cheek right" />
      {MARKS[reaction.kind].map((mark, i) => (
        <b key={i} style={{ '--i': i } as CSSProperties}>
          {mark}
        </b>
      ))}
    </span>
  );
}
