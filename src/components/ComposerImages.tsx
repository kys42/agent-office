import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ImageIcon, ImagePlus, Loader, X } from 'lucide-react';
import { IMAGE_MIME, type ImageBlock } from '../shared/attachments';
import { useI18n } from '../lib/i18n';
import { imageFiles, type useComposerImages } from '../lib/useComposerImages';

type Attached = ReturnType<typeof useComposerImages>;

/**
 * Paste (⌘V) and drop for a composer form. Image files are attached; where images can't go
 * (`block`), the reason is shown instead and nothing is attached. A paste without image files
 * (plain text) is left to the text field.
 */
export function useImageInput(attached: Attached, block: ImageBlock | null) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const take = (files: File[]) => {
    if (block) attached.showError(t.terminal.images.blocked[block]);
    else void attached.add(files);
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return {
    over,
    onPaste: (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files);
      if (!files.length) return;
      // A copied image often comes with its name or a link as text: keep only the image.
      e.preventDefault();
      take(files);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = block ? 'none' : 'copy';
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      const files = imageFiles(e.dataTransfer?.files);
      if (files.length) take(files);
    },
  };
}

/** The attach button: shown only where images can be sent. */
export function ImageAttachButton({
  attached,
  block,
  asPaths,
  disabled,
  className = '',
}: {
  attached: Attached;
  block: ImageBlock | null;
  asPaths?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  if (block) return null;
  const tip = asPaths
    ? `${t.terminal.images.attachHint} · ${t.terminal.images.asPaths}`
    : t.terminal.images.attachHint;
  return (
    <>
      <button
        type="button"
        className={`composer-attach ${className}`}
        aria-label={t.terminal.images.attach}
        data-tip={tip}
        title={tip}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <ImagePlus size={13} />
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={IMAGE_MIME.join(',')}
        onChange={(e) => {
          const files = imageFiles(e.target.files);
          e.target.value = '';
          if (files.length) void attached.add(files);
        }}
      />
    </>
  );
}

/**
 * Thumbnails of the attached images, each with a remove button. With hidden screen content
 * (privacy) only a plain tile stands for each image. Errors (a refused file, images not taken
 * here) show below.
 */
export function ImageStrip({
  attached,
  privacy,
  block,
  asPaths,
}: {
  attached: Attached;
  privacy: boolean;
  block: ImageBlock | null;
  asPaths?: boolean;
}) {
  const { t } = useI18n();
  const { images, uploading, error } = attached;
  if (!images.length && !uploading && !error) return null;
  return (
    <div className="composer-images">
      {(images.length > 0 || uploading) && (
        <ul className="composer-image-list" aria-label={t.terminal.images.attach}>
          {images.map((image, i) => (
            <li key={image.id} className="composer-image">
              {privacy || !image.url ? (
                <span
                  className="composer-image-hidden"
                  aria-label={privacy ? t.terminal.images.hidden(i + 1) : image.name}
                >
                  <ImageIcon size={14} />
                </span>
              ) : (
                <img src={image.url} alt={image.name} draggable={false} />
              )}
              <button
                type="button"
                className="composer-image-remove"
                aria-label={t.terminal.images.remove(i + 1)}
                onClick={() => attached.remove(image.id)}
              >
                <X size={10} />
              </button>
            </li>
          ))}
          {uploading && (
            <li
              className="composer-image composer-image-busy"
              aria-label={t.terminal.images.uploading}
            >
              <Loader size={14} className="now-spin" />
            </li>
          )}
        </ul>
      )}
      {images.length > 0 && (block || asPaths) && (
        <small className="composer-images-note">
          {block ? t.terminal.images.blocked[block] : t.terminal.images.asPaths}
        </small>
      )}
      {error && (
        <small className="composer-images-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
