import { useRef } from 'react';
import { Expand, X } from 'lucide-react';
import { api } from '../lib/api';
import { petSummary, type OfficeModel } from '../shared/office-model';
import { Sprite } from './Sprite';

const DRAG_SLOP = 4;

/** The collapsed dock: the colleague who most needs the person, as a small desktop pet. */
export function DeskPet({
  model,
  status,
  onExpand,
}: {
  model: OfficeModel;
  /** Shown instead of the summary until the first snapshot arrives (or fails). */
  status: string | null;
  onExpand: () => void;
}) {
  const pet = petSummary(model);
  const total = model.seats.length;
  const label = status ?? pet.label;
  const count = !status && pet.group !== 'resting' ? pet.count : null;
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const endDrag = () => {
    if (!press.current) return;
    dragged.current = press.current.moved;
    press.current = null;
    void api.dock?.('drag-end');
  };
  return (
    <div className="desk-pet-stage">
      <div className="dock-pet-tools" data-solid>
        <button
          className="icon-btn"
          aria-label="사무실 펼치기"
          title="큰 사무실 열기"
          onClick={() => api.window('main')}
        >
          <Expand size={12} />
        </button>
        <button
          className="icon-btn"
          aria-label="데스크 펫 숨기기"
          title="숨기기 · 트레이에서 다시 열 수 있어요"
          onClick={() => api.window('hide')}
        >
          <X size={12} />
        </button>
      </div>
      <button
        className={`desk-pet tone-${status ? 'resting' : pet.group}`}
        data-solid
        aria-label={`데스크 펫 · ${label}${count ? ` ${count}명` : ''} · 눌러서 책상 줄 펼치기`}
        title={`우리 사무실 · 동료 ${total}명\n누르면 책상 줄로 펼쳐지고, 끌어서 옮길 수 있어요`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          press.current = { x: e.screenX, y: e.screenY, moved: false };
          dragged.current = false;
          void api.dock?.('drag-start');
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && !p.moved && Math.hypot(e.screenX - p.x, e.screenY - p.y) > DRAG_SLOP)
            p.moved = true;
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onClick={() => {
          // A drag that ends on the pet is a move, not a request to open the row.
          if (dragged.current) dragged.current = false;
          else onExpand();
        }}
      >
        {pet.calling && <span className="dock-pet-bang">!</span>}
        <span className="dock-pet-body">
          <Sprite
            provider={pet.lead?.session.provider ?? 'claude'}
            mood={status ? 'think' : (pet.lead?.pose.mood ?? 'idle')}
            size={72}
          />
        </span>
        <span className="dock-pet-shadow" />
        <span className="dock-pet-pill">
          <i />
          {label}
          {count !== null && <b>{count}</b>}
        </span>
      </button>
    </div>
  );
}
