import { useId } from 'react';
import { EyeOff } from 'lucide-react';
import { VEIL_HINT } from '../shared/veil';

/** Hover control on a desk: hide this colleague until their next conversation. */
export function VeilButton({ name, onVeil }: { name: string; onVeil: () => void }) {
  const tip = useId();
  return (
    <button
      className="desk-hover-btn veil-button"
      data-solid
      aria-label={`${name} 가리기`}
      aria-describedby={tip}
      onClick={(e) => {
        e.stopPropagation();
        onVeil();
      }}
    >
      <EyeOff size={13} strokeWidth={2.4} />
      <span className="veil-tip" role="tooltip" id={tip}>
        <b>가리기</b>
        {VEIL_HINT}
      </span>
    </button>
  );
}
