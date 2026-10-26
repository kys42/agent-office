import { useEffect, useSyncExternalStore } from 'react';
import type { ShellTarget } from '../shared/mini-shell';

// One mini terminal panel per window: a card's or a zone's button points it at a folder, the
// panel (MiniShellDock) draws it. Closing only detaches; tmux keeps the shell.
let target: ShellTarget | null = null;
/** Mounted panels: buttons show only in windows that can draw one (not the pet/row dock). */
let hosts = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function openMiniShell(next: ShellTarget) {
  target = next;
  emit();
}
export function closeMiniShell() {
  if (!target) return;
  target = null;
  emit();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useMiniShellTarget = () =>
  useSyncExternalStore(
    subscribe,
    () => target,
    () => null,
  );
export const useMiniShellHosted = () =>
  useSyncExternalStore(
    subscribe,
    () => hosts > 0,
    () => false,
  );
/** Marks this window as able to show the panel while the caller is mounted. */
export function useMiniShellHost(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    hosts++;
    emit();
    return () => {
      hosts--;
      emit();
    };
  }, [enabled]);
}
