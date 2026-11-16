// Picking a run of chat bubbles to copy at once or hand to another colleague (#377), like a
// messenger's "select from here": a start bubble, then an end bubble, and every bubble shown
// between them is in. Pure rules shared by the card and the big office's column;
// components/Conversation.tsx draws the marks, components/BubbleShareBar.tsx the bar that takes
// the composer's place, lib/useComposerDraft.ts keeps the other colleague's draft.
import type { OfficeEvent, Session } from './types';

/** The chosen run: where it starts, and where it ends (the start itself until an end is picked). */
export interface BubbleRange {
  start: string;
  end: string;
}

/** "Select from here": the run starts, and so far ends, at this bubble. */
export function startRange(id: string): BubbleRange {
  return { start: id, end: id };
}

/** A bubble picked while choosing: the run's end moves there (before the start works too). */
export function pickInRange(range: BubbleRange | null, id: string): BubbleRange {
  return range ? { start: range.start, end: id } : startRange(id);
}

/**
 * The run's bubbles in the order they are shown (`order`: the ids of the bubbles on screen).
 * Nothing while the start is not shown (another filter, a switch hid its kind); the start alone
 * while the end is not.
 */
export function rangeIds(order: readonly string[], range: BubbleRange | null): string[] {
  if (!range) return [];
  const from = order.indexOf(range.start);
  if (from < 0) return [];
  const found = order.indexOf(range.end);
  const to = found < 0 ? from : found;
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** What the bubbles call each side, in the active language. */
export interface SpeakerLabels {
  /** The person. */
  you: string;
  /** The colleague, as the office names it. */
  name: string;
  tool: string;
  result: string;
  /** Anything else in the work log (a session starting or ending). */
  other: string;
}

/** Who a bubble says spoke: the copy's speaker line reads exactly as the bubble's own. */
export function bubbleSpeaker(kind: OfficeEvent['kind'], labels: SpeakerLabels): string {
  return kind === 'user'
    ? labels.you
    : kind === 'assistant'
      ? labels.name
      : kind === 'tool'
        ? labels.tool
        : kind === 'result'
          ? labels.result
          : labels.other;
}

/** One picked bubble: who said it and its whole text (the Markdown source, never the folded view). */
export interface SharedBubble {
  speaker: string;
  text: string;
}

/**
 * As copied or handed on: each bubble its speaker line (`나:`, the colleague's name) and its
 * text below, a blank line between bubbles. A bubble with no text (an image-only request) adds
 * nothing.
 */
export function formatBubbles(bubbles: readonly SharedBubble[]): string {
  return bubbles
    .map((b) => ({ speaker: b.speaker, text: b.text.trim() }))
    .filter((b) => b.text)
    .map((b) => `${b.speaker}:\n${b.text}`)
    .join('\n\n');
}

/**
 * How much the card's chat box takes (its `maxLength`) and a send carries (desktop/terminals.ts
 * MAX_SEND_LENGTH): a hand-over never leaves a draft that could not go out.
 */
export const REPLY_MAX = 4000;

/** What goes to the other colleague: where it came from on one line, then the bubbles. */
export function handedText(fromLine: string, body: string): string {
  return `${fromLine}\n\n${body}`;
}

/**
 * The other colleague's draft with the handed text after what it already holds — never in its
 * place, never sent. Null when the two together would not fit the chat box.
 */
export function addToDraft(draft: string, handed: string, max = REPLY_MAX): string | null {
  const text = draft.trim() ? `${draft.trimEnd()}\n\n${handed}` : handed;
  return text.length > max ? null : text;
}

/**
 * Whether a colleague's card has the chat box a hand-over fills (Inspector's `locatable`): a
 * terminal can exist for it here, or its remote office takes messages.
 */
export function takesReplies(s: Session, demo: boolean): boolean {
  return (
    !demo &&
    (!s.remote || (!!s.remote.send && !s.remote.stale)) &&
    (s.provider === 'claude' || s.provider === 'codex')
  );
}

const ZONE_ORDER: Record<string, number> = { office: 0, waiting: 1, archive: 2 };

/**
 * Who the run can be handed to: the office's other colleagues whose card has a chat box (not the
 * one it comes from, nor a helper desk), the office first, then the lounge and the archive, the
 * most recently active first.
 */
export function handTargets(
  colleagues: readonly Session[],
  from: readonly string[],
  demo: boolean,
): Session[] {
  const own = new Set(from);
  return colleagues
    .filter(
      (s) =>
        !own.has(s.id) &&
        !(s.resident?.sessionIds ?? []).some((id) => own.has(id)) &&
        !s.attachedTo &&
        takesReplies(s, demo),
    )
    .sort(
      (a, b) =>
        (ZONE_ORDER[a.zone ?? 'office'] ?? 0) - (ZONE_ORDER[b.zone ?? 'office'] ?? 0) ||
        b.updatedAt - a.updatedAt,
    );
}
