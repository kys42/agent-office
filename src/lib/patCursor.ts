/**
 * The petting hand over a pet (#306): the system's own palm-down emoji (🫳), drawn once at start
 * into a small image — the platform's polished artwork, nothing shipped. Where the emoji cannot
 * be drawn (an older system, no colour emoji font) the hand drawn in effects.css stays.
 */
const HAND = '🫳';
const FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
/** The fingertips, where a pat lands, in the 32px cursor (the hand points right and down). */
const HOTSPOT = '26 20';

/** The emoji at `size` px, or null when nothing colourful came out (no emoji to draw). */
function drawHand(size: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  // The hand is wide and flat: size it to fill the width rather than the height.
  g.font = `${size}px ${FONT}`;
  const fit = Math.min(1.4, (size * 0.98) / Math.max(1, g.measureText(HAND).width));
  g.font = `${Math.round(size * fit)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(HAND, size / 2, size * 0.5);
  const px = g.getImageData(0, 0, size, size).data;
  // A missing glyph draws nothing, or a plain grey box: count pixels with real colour.
  let colour = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i + 3] > 128 && Math.abs(px[i] - px[i + 2]) > 40) colour++;
  return colour > size * size * 0.05 ? canvas.toDataURL('image/png') : null;
}

/** Puts the emoji hand in `--pat-cursor` on this window's root, when it can be drawn. */
export function bootPatCursor() {
  try {
    const one = drawHand(32);
    if (!one) return;
    const two = drawHand(64);
    const sharp = two && `image-set(url("${one}") 1x, url("${two}") 2x)`;
    const image =
      sharp && CSS.supports('cursor', `${sharp} ${HOTSPOT}, grab`) ? sharp : `url("${one}")`;
    document.documentElement.style.setProperty('--pat-cursor', `${image} ${HOTSPOT}, grab`);
  } catch {
    // Canvas or CSS unavailable: the drawn hand from effects.css stays.
  }
}
