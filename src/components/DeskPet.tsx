import { useRef } from 'react';
import { Expand, Flag, X } from 'lucide-react';
import { api } from '../lib/api';
import type { ReceiptAction } from '../lib/useOffice';
import { MOODS, type NoticeReceipt } from '../shared/types';
import { petSummary, residentLabel, type OfficeModel } from '../shared/office-model';
import { branchInfo } from '../shared/branch';
import { PET_SIZE } from '../shared/dock-geometry';
import { stationSpeech } from '../shared/speech';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { PetArrival } from './DeskEffects';

const DRAG_SLOP = 4;

/**
 * The collapsed dock: the colleague who most needs the person, as a small desktop pet.
 * A just-arrived result or question turns the pet into that colleague, speaking it.
 */
export function DeskPet({
  model,
  status,
  privacy,
  onReceipt,
  onExpand,
  onFloor,
}: {
  model: OfficeModel;
  /** Shown instead of the summary until the first snapshot arrives (or fails). */
  status: string | null;
  privacy: boolean;
  onReceipt: (receipts: NoticeReceipt[], action: ReceiptAction) => void;
  /** Unfold in the last used look (office row or floor desks). */
  onExpand: () => void;
  /** Unfold the floor desks: desks on the screen's bottom edge, zones marked by flags. */
  onFloor: () => void;
}) {
  const pet = petSummary(model);
  const total = model.seats.length;
  const label = status ?? pet.label;
  const count = !status && pet.group !== 'resting' ? pet.count : null;
  const speaker = status ? undefined : pet.speaker;
  const speech = speaker
    ? stationSpeech(
        speaker.view.session,
        model.notices,
        model.bubbleHours,
        model.now,
        speaker.notice,
      )
    : undefined;
  const bubble = speech?.bubble;
  const who = speaker && residentLabel(speaker.view.session, privacy);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const endDrag = () => {
    if (!press.current) return;
    dragged.current = press.current.moved;
    press.current = null;
    void api.dock?.('drag-end');
  };
  return (
    <div className="desk-pet-stage" style={PET_SIZE}>
      <div className="dock-pet-anchor">
        {speaker && speech && bubble && (
          <div className="dock-pet-speech" data-solid>
            <SpeechBubble
              session={speaker.view.session}
              speech={speech}
              privacy={privacy}
              onOpen={() => {
                if (!privacy) onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                void api.window('main', bubble.sessionId);
              }}
              onDismiss={() => onReceipt([{ id: bubble.id, version: bubble.version }], 'dismiss')}
              detail={
                who && (
                  <>
                    <span>
                      <strong>{who.name}</strong> · {MOODS[speaker.view.session.status].label}
                    </span>
                    {!privacy && (
                      <span>
                        {who.project} · {branchInfo(speaker.view.session).label}
                      </span>
                    )}
                    <span>
                      {speaker.view.unread.length > 1
                        ? `읽지 않은 소식 ${speaker.view.unread.length}건 · `
                        : ''}
                      누르면 큰 사무실에서 열려요
                    </span>
                  </>
                )
              }
            />
          </div>
        )}
        {/* Someone just got a request: papers land beside the pet (it stays who it is). */}
        {!status && pet.arrival && (
          <PetArrival
            key={pet.arrival.id}
            receivedAt={pet.arrival.receivedAt}
            count={pet.arrivals}
          />
        )}
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
            aria-label="바닥 책상 펼치기"
            title="바닥 책상 · 화면 맨 아래에 책상만, 구역은 깃발"
            onClick={onFloor}
          >
            <Flag size={12} />
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
          className={`desk-pet tone-${status ? 'resting' : pet.group} ${speaker ? 'is-speaking' : ''}`}
          data-solid
          aria-label={`데스크 펫 · ${label}${count ? ` ${count}명` : ''} · 눌러서 펼치기`}
          title={`우리 사무실 · 동료 ${total}명\n누르면 마지막에 쓴 모습(책상 줄·바닥 책상)으로 펼쳐지고, 끌어서 옮길 수 있어요`}
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
          {/* While another colleague speaks, the pill still says who is waiting. */}
          {pet.calling && !speaker && <span className="dock-pet-bang">!</span>}
          {/* Re-keyed per notice so a new arrival replays the hop. */}
          <span className="dock-pet-body" key={speaker?.notice.id ?? 'pet'}>
            <Sprite
              provider={pet.lead?.session.provider ?? 'claude'}
              mood={status ? 'think' : (pet.lead?.pose.mood ?? 'idle')}
              size={72}
            />
          </span>
          <span className="dock-pet-shadow" />
          {who && (
            <span className="dock-pet-name" title={privacy ? undefined : who.detail}>
              {who.name}
            </span>
          )}
          <span className="dock-pet-pill">
            <i />
            {label}
            {count !== null && <b>{count}</b>}
          </span>
        </button>
      </div>
    </div>
  );
}
