import { useId } from 'react';
import { EyeOff } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/** Hover control on a desk: hide this colleague until their next conversation. */
export function VeilButton({ name, onVeil }: { name: string; onVeil: () => void }) {
  const { t } = useI18n();
  const tip = useId();
  return (
    <button
      className="desk-hover-btn veil-button"
      data-solid
      aria-label={t.desk.veil.label(name)}
      aria-describedby={tip}
      onClick={(e) => {
        e.stopPropagation();
        onVeil();
      }}
    >
      <EyeOff size={13} strokeWidth={2.4} />
      <span className="veil-tip" role="tooltip" id={tip}>
        <b>{t.desk.veil.title}</b>
        {t.desk.veil.hint}
      </span>
    </button>
  );
}
