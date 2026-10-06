import { useId } from 'react';
import { Pin } from 'lucide-react';

export const PIN_HINT = '오래 지나도 이 자리에 남아요. 대기 라운지·보관으로 옮기지 않아요.';

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
  const tip = useId();
  return (
    <button
      className={`desk-hover-btn pin-button ${pinned ? 'is-pinned' : ''}`}
      data-solid
      aria-label={`${name} ${pinned ? '고정 풀기' : '고정'}`}
      aria-pressed={pinned}
      aria-describedby={tip}
      onClick={(e) => {
        e.stopPropagation();
        onPin();
      }}
    >
      <Pin size={13} strokeWidth={2.4} />
      <span className="veil-tip" role="tooltip" id={tip}>
        <b>{pinned ? '고정됨 · 누르면 풀어요' : '고정'}</b>
        {PIN_HINT}
      </span>
    </button>
  );
}
