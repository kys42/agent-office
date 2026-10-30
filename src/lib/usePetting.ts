import { useRef, type MouseEvent } from 'react';
import { reactPet } from './petReaction';

/** Side-to-side turns that make a rub, within this long. */
export const RUB_TURNS = 3;
export const RUB_WINDOW_MS = 1000;
/** After a pat, rubbing on does nothing for this long (no hearts flood). */
export const RUB_COOLDOWN_MS = 2000;
/** Moves smaller than this never count as a turn (a hand resting on the mouse). */
const RUB_STEP = 3;

/**
 * Tells a rub from a pass: the pointer goes back and forth over the pet, turning RUB_TURNS times
 * within RUB_WINDOW_MS, with no button held (a held button is a drag or a click). Pure, for
 * tests: feed it moves, it answers whether this one completes a rub.
 */
export function rubTracker() {
  let lastX: number | null = null;
  let direction = 0;
  let turns: number[] = [];
  let quietUntil = 0;
  return {
    move(x: number, at: number, buttons = 0): boolean {
      if (buttons !== 0) {
        lastX = null;
        direction = 0;
        turns = [];
        return false;
      }
      if (lastX === null) {
        lastX = x;
        return false;
      }
      const dx = x - lastX;
      if (Math.abs(dx) < RUB_STEP) return false;
      lastX = x;
      const next = Math.sign(dx);
      if (direction && next !== direction)
        turns = [...turns.filter((t) => at - t < RUB_WINDOW_MS), at];
      direction = next;
      if (at < quietUntil || turns.length < RUB_TURNS) return false;
      turns = [];
      quietUntil = at + RUB_COOLDOWN_MS;
      return true;
    },
    /** The pointer left the pet: the next pass starts afresh. */
    leave() {
      lastX = null;
      direction = 0;
      turns = [];
    },
  };
}

/**
 * Mouse handlers that pet a colleague when the person rubs its pet, one rub tracker per pet.
 * Mouse events, not pointer ones: the pet's drag handles (reorder, zone moves, the desk pet) own
 * its pointer handlers, and a rub never holds a button, so the two never meet.
 */
export function usePetting(): (id: string | undefined) => {
  onMouseMove?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: () => void;
} {
  const trackers = useRef(new Map<string, ReturnType<typeof rubTracker>>());
  return (id) => {
    if (!id) return {};
    const tracker = () => {
      let t = trackers.current.get(id);
      if (!t) trackers.current.set(id, (t = rubTracker()));
      return t;
    };
    return {
      onMouseMove: (e) => {
        if (tracker().move(e.clientX, e.timeStamp, e.buttons)) reactPet(id, 'pat');
      },
      onMouseLeave: () => tracker().leave(),
    };
  };
}
