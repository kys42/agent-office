import type { ComposerDraftView, TerminalTarget } from '../shared/types';

/**
 * The work card's preview of what sits in the colleague's terminal input box: pure rules shared
 * by the hook (`useTerminalDraft`) and its tests. Views only draw what these decide.
 */

/** How often the box is read while the card shows: soon after a change, slower while it rests. */
export const DRAFT_POLL = {
  /** Right after opening, a change, a send, or the window coming back. */
  base: 2500,
  /** Unchanged text: the person is probably not typing there right now. */
  draft: 6000,
  /** Unchanged empty box. */
  empty: 8000,
  /** Not readable (a dialog, not taking input, no terminal): checked rarely. */
  unknown: 15_000,
} as const;

/**
 * The preview reads only a box a send could reach: a verified Orca or tmux terminal that takes
 * input now. Queues (Codex CLI), Codex Desktop, a bare Orca tab and other offices have none.
 */
export function previewsTarget(target: TerminalTarget | null | undefined): boolean {
  return (
    !!target &&
    target.canSend &&
    (target.kind === 'orca' || target.kind === 'tmux') &&
    !target.queues &&
    !target.desktop &&
    !target.tabOnly &&
    !target.remoteOffice
  );
}

/** Two reads show the same thing (nothing new to draw, the poll may slow down). */
export function sameDraftView(a: ComposerDraftView | null, b: ComposerDraftView | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'draft' && b.kind === 'draft')
    return (
      a.text === b.text &&
      a.logical === b.logical &&
      a.agent === b.agent &&
      a.submittable === b.submittable &&
      !!a.partial === !!b.partial &&
      !!a.maybeSuggestion === !!b.maybeSuggestion
    );
  if (a.kind === 'unknown' && b.kind === 'unknown') return a.reason === b.reason;
  return true;
}

/** The wait before the next read: back to `base` on a change, else 1.5× up to the kind's cap. */
export function nextDraftDelay(
  previous: number,
  changed: boolean,
  view: ComposerDraftView,
): number {
  if (changed) return DRAFT_POLL.base;
  const cap = DRAFT_POLL[view.kind === 'draft' ? 'draft' : view.kind];
  return Math.min(cap, Math.max(DRAFT_POLL.base, Math.round(previous * 1.5)));
}

/** Long enough to clamp in the preview (with a toggle to show all). */
export const draftIsLong = (text: string) => text.split('\n').length > 3 || text.length > 180;

/**
 * The card's text after taking the box's text in to edit: the box's text alone in an empty card;
 * after what was already written otherwise (never lost), once.
 */
export function importDraft(current: string, draft: string): string {
  if (!current.trim()) return draft;
  if (current.includes(draft)) return current;
  return `${current.replace(/\s+$/, '')}\n\n${draft}`;
}
