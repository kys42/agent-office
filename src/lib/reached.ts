/**
 * A colleague the person just reached outside its card: a message sent to it, or its terminal
 * brought to the front. Whatever it last said has been seen there, so the window's office core
 * reads its results (`useOffice`) the way opening the card does.
 */
type Listener = (sessionId: string) => void;
const listeners = new Set<Listener>();

export function reached(sessionId: string) {
  for (const listener of listeners) listener(sessionId);
}
export function onReached(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
