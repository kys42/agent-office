import { useId, type CSSProperties } from 'react';
import { EyeOff } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/**
 * Hover control on a desk: hide this colleague until their next conversation. `zone` makes it
 * the zone sign's control, hiding everyone in that project at once.
 */
export function VeilButton({
  name,
  onVeil,
  zone = false,
  className = '',
  style,
}: {
  name: string;
  onVeil: () => void;
  zone?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const v = t.desk.veil;
  const tip = useId();
  return (
    <button
      className={`desk-hover-btn veil-button ${zone ? 'zone-veil' : ''} ${className}`}
      style={style}
      data-solid
      aria-label={zone ? v.zoneLabel(name) : v.label(name)}
      aria-describedby={tip}
      onClick={(e) => {
        e.stopPropagation();
        onVeil();
      }}
    >
      <EyeOff size={zone ? 12 : 13} strokeWidth={2.4} />
      <span className="veil-tip" role="tooltip" id={tip}>
        <b>{zone ? v.zoneTitle : v.title}</b>
        {zone ? v.zoneHint : v.hint}
      </span>
    </button>
  );
}
