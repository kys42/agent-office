import { EyeOff } from 'lucide-react';
import { VEIL_HINT } from '../shared/veil';

/** Hover control on a desk: hide this colleague until their next conversation. */
export function VeilButton({ name, onVeil }: { name: string; onVeil: () => void }) {
  return (
    <button
      className="veil-button"
      data-solid
      aria-label={`${name} 가리기`}
      onClick={(e) => {
        e.stopPropagation();
        onVeil();
      }}
    >
      <EyeOff size={13} strokeWidth={2.4} />
      <span className="veil-tip" role="tooltip">
        <b>가리기</b>
        {VEIL_HINT}
      </span>
    </button>
  );
}
