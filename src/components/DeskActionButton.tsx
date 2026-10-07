import { useId, type ReactNode } from 'react';

/**
 * A desk hover control in the same column as hide and pin: one icon, a short explanation on
 * hover. The desk row uses it for "open the card" and "go to the terminal".
 */
export function DeskActionButton({
  className,
  label,
  title,
  hint,
  icon,
  onClick,
}: {
  className: string;
  label: string;
  title: string;
  hint: string;
  icon: ReactNode;
  onClick: (button: HTMLButtonElement) => void;
}) {
  const tip = useId();
  return (
    <button
      className={`desk-hover-btn ${className}`}
      data-solid
      aria-label={label}
      aria-describedby={tip}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e.currentTarget);
      }}
    >
      {icon}
      <span className="veil-tip" role="tooltip" id={tip}>
        <b>{title}</b>
        {hint}
      </span>
    </button>
  );
}
