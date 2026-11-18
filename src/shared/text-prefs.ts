import type { Preferences, ReadingFont, TextSize } from './types';

/**
 * #246: how reading text looks — work card conversation and news, speech bubbles, the roster
 * and inbox, the settings page. The pixel scene (desks, tiny desks, name plates, badges) and the
 * dock's window sizes never follow these. A missing value is the look from before.
 */
export const TEXT_SIZE_CHOICES: readonly TextSize[] = ['small', 'normal', 'large', 'larger'];
export const READING_FONT_CHOICES: readonly ReadingFont[] = ['system', 'pretendard', 'mono'];

/** The multiplier reading-text font sizes take (`calc(<px> * var(--read-scale))`). */
export const TEXT_SCALE: Record<TextSize, number> = {
  small: 0.92,
  normal: 1,
  large: 1.12,
  larger: 1.25,
};

/**
 * The font stack behind each choice. `system` is the app's own stack from before (`--font-ui`:
 * the system font first, Pretendard where there is none), so leaving the choice alone changes
 * nothing; `pretendard` puts the bundled Pretendard first.
 */
export const READING_FONT_STACK: Record<ReadingFont, string> = {
  system: 'var(--font-ui)',
  pretendard: "'Pretendard Variable', Pretendard, var(--font-ui)",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, 'D2Coding', 'JetBrains Mono', 'Apple SD Gothic Neo', 'Malgun Gothic', monospace",
};

export interface TextPrefs {
  size: TextSize;
  font: ReadingFont;
  scale: number;
  fontStack: string;
}

export function textPrefs(p?: Pick<Preferences, 'textSize' | 'readingFont'> | null): TextPrefs {
  const size = TEXT_SIZE_CHOICES.includes(p?.textSize as TextSize) ? p!.textSize! : 'normal';
  const font = READING_FONT_CHOICES.includes(p?.readingFont as ReadingFont)
    ? p!.readingFont!
    : 'system';
  return { size, font, scale: TEXT_SCALE[size], fontStack: READING_FONT_STACK[font] };
}
