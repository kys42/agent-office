import { Building2, Flag, Minimize2, PawPrint, Rows3 } from 'lucide-react';
import type { DockLook } from '../shared/dock-look';

/**
 * A dock look's icon, the same one the dock's 보기 menu uses: the pet, the desk row or the floor,
 * with a small shrink mark when the row/floor is tiny. Without a look (the settings preview) it is
 * the generic rows icon.
 */
export function DockLookIcon({
  look,
  size = 14,
  className = 'dock-view-current',
}: {
  look?: DockLook;
  size?: number;
  className?: string;
}) {
  const Icon = !look
    ? Rows3
    : look.mode === 'floor'
      ? Flag
      : look.mode === 'row'
        ? Building2
        : PawPrint;
  return (
    <span className={className} aria-hidden="true">
      <Icon size={size} />
      {look?.tiny && look.mode !== 'pet' && (
        <Minimize2
          className="dock-view-tiny-mark"
          size={Math.max(8, Math.round(size * 0.57))}
          strokeWidth={3}
        />
      )}
    </span>
  );
}
