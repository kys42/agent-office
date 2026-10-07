import { useId } from 'react';
import { Pin } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/** Hover control on a desk: keep this colleague in the office however long it stays quiet. */
export function PinButton({
  name,
  pinned,
  onPin,
}: {
  name: string;
  pinned: boolean;
  onPin: () => void;
}) {
  const { t } = useI18n();
  const tip = useId();
  return (
    <button
      className={`desk-hover-btn pin-button ${pinned ? 'is-pinned' : ''}`}
      data-solid
      aria-label={pinned ? t.desk.pin.unpinLabel(name) : t.desk.pin.label(name)}
      aria-pressed={pinned}
      aria-describedby={tip}
      onClick={(e) => {
        e.stopPropagation();
        onPin();
      }}
    >
      <Pin size={13} strokeWidth={2.4} />
      <span className="veil-tip" role="tooltip" id={tip}>
        <b>{pinned ? t.desk.pin.pinnedTitle : t.desk.pin.title}</b>
        {t.desk.pin.hint}
      </span>
    </button>
  );
}
