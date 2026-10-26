import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ATTACHMENT_FILE,
  ATTACHMENT_TTL_MS,
  IMAGE_EXTS,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  isAttachmentId,
  sniffImage,
} from '../src/shared/attachments.js';
import { m } from '../src/shared/i18n/index.js';

/** A refusal the person can act on (wrong format, too large, gone): shown as is. */
export class AttachmentError extends Error {}

/**
 * Images attached in the composer, kept in an app-owned folder (`<userData>/attachments`).
 * The renderer hands over bytes and gets an opaque id back; a send carries ids, resolved here to
 * absolute paths. A file is only ever one this store wrote: `<uuid>.<ext>`, a regular file (no
 * symlink), in this folder. Files are kept for a week, since the agent may read them later (the
 * Codex queue passes paths), and removed at the next startup after that.
 */
export class AttachmentStore {
  constructor(readonly dir: string) {}

  async save(bytes: unknown): Promise<{ id: string }> {
    const t = m().desktop.attachments;
    if (!(bytes instanceof Uint8Array)) throw new AttachmentError(t.notImage);
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new AttachmentError(t.tooLarge(MAX_IMAGE_BYTES));
    const ext = sniffImage(bytes);
    if (!ext) throw new AttachmentError(t.notImage);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    // `wx`: never over an existing file.
    await writeFile(path.join(this.dir, `${id}.${ext}`), bytes, { mode: 0o600, flag: 'wx' });
    return { id };
  }

  /** The absolute path of a saved image, or null when the id is malformed or the file is gone. */
  async resolve(id: unknown): Promise<string | null> {
    if (!isAttachmentId(id)) return null;
    for (const ext of IMAGE_EXTS) {
      const file = path.join(this.dir, `${id}.${ext}`);
      const info = await lstat(file).catch(() => null);
      if (info?.isFile()) return file;
    }
    return null;
  }

  /**
   * A saved image's bytes and type, to show its thumbnail again (a card window is recreated on
   * every open). Only this store's own files; null when the id is malformed or the file is gone,
   * too large, or no longer an image.
   */
  async preview(id: unknown): Promise<{ type: string; bytes: Uint8Array } | null> {
    const file = await this.resolve(id);
    if (!file) return null;
    const bytes = await readFile(file).catch(() => null);
    if (!bytes || bytes.byteLength > MAX_IMAGE_BYTES) return null;
    const ext = sniffImage(bytes);
    if (!ext || path.extname(file) !== `.${ext}`) return null;
    return { type: IMAGE_TYPES[ext], bytes: new Uint8Array(bytes) };
  }

  /** Every id, in order, as paths; any malformed, duplicate or missing one refuses the send. */
  async resolveAll(ids: unknown): Promise<string[]> {
    const t = m().desktop.attachments;
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES || new Set(ids).size !== ids.length)
      throw new AttachmentError(t.tooMany(MAX_IMAGES));
    const paths: string[] = [];
    for (const id of ids) {
      const file = await this.resolve(id);
      if (!file) throw new AttachmentError(t.missing);
      paths.push(file);
    }
    return paths;
  }

  /** Removes this store's files older than `maxAge`. Anything else in the folder is left alone. */
  async cleanup(maxAge = ATTACHMENT_TTL_MS, now = Date.now()): Promise<number> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!ATTACHMENT_FILE.test(name)) continue;
      const file = path.join(this.dir, name);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs < maxAge) continue;
      await rm(file, { force: true }).catch(() => undefined);
      removed++;
    }
    return removed;
  }
}
