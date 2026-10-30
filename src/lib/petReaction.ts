import { useEffect, useState } from 'react';

/**
 * A colleague's pet showing it is pleased: `pat` (petted, hearts) or `praise` (praised,
 * sparkles). One entry point for every way of pleasing a pet — rubbing it now, a praise button
 * later — and every view that draws that colleague (big office, dock row and floor, the desk
 * pet, a customizer preview) plays it from the same call. Within this window only.
 */
export type PetReactionKind = 'pat' | 'praise';
/** How long a reaction plays (hops, sparkles; the CSS durations fit inside). */
export const PET_REACTION_MS = 1600;

type Listener = (id: string, kind: PetReactionKind) => void;
const listeners = new Set<Listener>();

/** Pleases the pet of this colleague (a station or session id) in every view that draws it. */
export function reactPet(id: string, kind: PetReactionKind) {
  for (const listen of listeners) listen(id, kind);
}

export type PetReaction = { kind: PetReactionKind; key: number };

/**
 * The reactions playing in this view, by colleague. One subscription for a whole scene (its
 * desks are drawn in a loop, where hooks can't go). `key` changes with each reaction, so a
 * second pat while the first still plays starts the hops and hearts over.
 */
export function usePetReactions(): (id: string | undefined) => PetReaction | null {
  const [playing, setPlaying] = useState<ReadonlyMap<string, PetReaction>>(new Map());
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let count = 0;
    const listen: Listener = (id, kind) => {
      clearTimeout(timers.get(id));
      setPlaying((p) => new Map(p).set(id, { kind, key: ++count }));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setPlaying((p) => {
            const next = new Map(p);
            next.delete(id);
            return next;
          });
        }, PET_REACTION_MS),
      );
    };
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);
  return (id) => (id ? (playing.get(id) ?? null) : null);
}

/**
 * The pet's classes while it reacts. Two alternating names (by `key`) restart the hops when a
 * new reaction lands while one still plays: the same class would not replay its animation.
 */
export const joyClass = (joy: PetReaction | null) =>
  joy ? `reacting reacting-${joy.kind} joy-${joy.key % 2}` : '';
