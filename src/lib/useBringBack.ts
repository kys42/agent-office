import { useState, type RefObject } from 'react';

/**
 * A list's per-row "bring back to the office" (the big office's lounge and archive lists, the
 * dock's ＋ 데려오기): repeat presses wait until the move settles, and a keyboard user whose row
 * leaves the list lands on the next row's button (or `fallback`, the search box) to continue.
 * Each row's button carries `data-bring-id` with its session id.
 */
export function useBringBack(
  onAct: ((id: string) => unknown) | undefined,
  root: RefObject<HTMLElement | null>,
  fallback?: RefObject<HTMLElement | null>,
) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const buttonOf = (id: string) =>
    root.current?.querySelector<HTMLElement>(`[data-bring-id="${CSS.escape(id)}"]`) ?? null;
  const act = (id: string) => {
    if (!onAct || busy.has(id)) return;
    const buttons = [...(root.current?.querySelectorAll<HTMLElement>('[data-bring-id]') ?? [])];
    const at = buttons.findIndex((b) => b.dataset.bringId === id);
    const focused = at >= 0 && document.activeElement === buttons[at];
    const neighbor = (buttons[at + 1] ?? buttons[at - 1])?.dataset.bringId;
    setBusy((b) => new Set(b).add(id));
    void Promise.resolve(onAct(id))
      .catch(() => undefined)
      .finally(() => {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        });
        if (!focused) return;
        // The row leaves the list; keep keyboard users on the next one so they can continue.
        requestAnimationFrame(() => {
          if (!root.current || buttonOf(id)) return;
          ((neighbor && buttonOf(neighbor)) || fallback?.current)?.focus();
        });
      });
  };
  return { busy, act };
}
