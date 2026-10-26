/**
 * Images attached to a follow-up from the app's composer. The renderer only ever holds bytes and
 * an opaque id: the desktop main process checks the bytes, writes the file into its own folder and
 * resolves ids to paths when sending. Paths never come from the renderer.
 */

/** The formats every delivery path takes (Claude Code and Codex read the same four). */
export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;
export type ImageExt = keyof typeof IMAGE_TYPES;
export const IMAGE_EXTS = Object.keys(IMAGE_TYPES) as ImageExt[];
/** For `<input accept>` and the renderer's quick pre-check; main checks the bytes again. */
export const IMAGE_MIME = Object.values(IMAGE_TYPES);

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 5;
/** Saved images are removed at startup once older than this. */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A saved image's id: a random UUID, nothing else (no path, no extension). */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isAttachmentId = (value: unknown): value is string =>
  typeof value === 'string' && ID.test(value);
/** A file in the attachments folder: `<id>.<ext>`. */
export const ATTACHMENT_FILE = /^([0-9a-f-]{36})\.(png|jpg|gif|webp)$/;

/** The image format by its first bytes (magic numbers), or null when it is none of the four. */
export function sniffImage(bytes: Uint8Array): ImageExt | null {
  const at = (offset: number, ...values: number[]) =>
    bytes.length >= offset + values.length && values.every((v, i) => bytes[offset + i] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  // GIF87a / GIF89a
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61))) return 'gif';
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return null;
}

/**
 * How a send target takes images: `attach` hands them over as images (Claude Code's own paste,
 * Codex Desktop's local image input); `path` only as file paths in the text (the Codex CLI queue,
 * which takes text alone). Absent: images cannot be sent there.
 */
export type ImageDelivery = 'attach' | 'path';

/** Why images cannot be attached here, or null when they can. Views show the reason as is. */
export type ImageBlock = 'desktop' | 'remote' | 'target';
export function imageBlock(
  target: { images?: ImageDelivery; remoteOffice?: string } | null | undefined,
  where: { desktop: boolean; demo?: boolean; remote?: boolean },
): ImageBlock | null {
  if (!where.desktop || where.demo) return 'desktop';
  if (where.remote || target?.remoteOffice) return 'remote';
  if (!target?.images) return 'target';
  return null;
}

/** The text a path-only target (the Codex queue) gets: the message, then one path per line. */
export function withImagePaths(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  return text ? `${text}\n\n${paths.join('\n')}` : paths.join('\n');
}
