import { useRef, useState } from 'react';
import { Expand, Flag, PanelRightOpen, RotateCw, X } from 'lucide-react';
import { api } from '../lib/api';
import { openColleague } from '../lib/dockCard';
import { useSendTargets } from '../lib/useSendTargets';
import { QuickReply } from './QuickReply';
import { targetLine } from './TerminalSend';
import type { ReceiptAction } from '../lib/useOffice';
import { MOODS, type NoticeReceipt } from '../shared/types';
import { petSummary, residentLabel, type OfficeModel } from '../shared/office-model';
import { branchInfo } from '../shared/branch';
import { PET_SIZE } from '../shared/dock-geometry';
import { stationSpeech } from '../shared/speech';
import { Sprite } from './Sprite';
import { SpeechBubble } from './SpeechBubble';
import { PetArrival } from './DeskEffects';
import { useI18n } from '../lib/i18n';

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
  onReply,
  onRefresh,
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
  /** Desktop opt-in: the speaking colleague can be answered right under its bubble. */
  onReply?: (sessionId: string, text: string) => Promise<void>;
  /** Look at the session records again now (and restart a stopped collector). */
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const d = t.dock.pet;
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
  // Clicking the bubble unfolds it here; a reply opens under it when the session can take one.
  // Both reset when the pet starts saying something else.
  const said = speaker?.notice.id ?? null;
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const expanded = !!said && unfolded === said;
  const replying = !!said && replyFor === said;
  const { targets, markSent } = useSendTargets(bubble ? [bubble.sessionId] : [], {
    enabled: !!onReply && !privacy,
    pollBusy: false,
  });
  const target = bubble ? targets[bubble.sessionId] : undefined;
  const canReply = !!onReply && !privacy && !!target?.canSend;
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
              // Shown with the details when the pet is hovered (dock.css).
              quote
              expanded={expanded}
              onExpandedChange={(on) => setUnfolded(on ? said : null)}
              onOpen={() => {
                if (!privacy && !expanded)
                  onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                setUnfolded(expanded ? null : said);
              }}
              reply={
                canReply
                  ? {
                      title: t.terminal.replyTitle(targetLine(target!, false)),
                      open: replying,
                      onClick: () => setReplyFor(replying ? null : said),
                    }
                  : undefined
              }
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
                      {speaker.view.unread.length > 1 ? d.unread(speaker.view.unread.length) : ''}
                      {d.detailHint}
                    </span>
                  </>
                )
              }
            />
            {canReply && replying && (
              <QuickReply
                key={said}
                target={target!}
                name={who?.name ?? d.someone}
                onClose={() => setReplyFor(null)}
                onSend={async (text) => {
                  await onReply!(bubble.sessionId, text);
                  markSent(bubble.sessionId);
                }}
              />
            )}
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
          {speaker && (
            <button
              className="icon-btn"
              aria-label={d.openCard}
              title={d.openCardTitle}
              onClick={(e) =>
                void openColleague(bubble?.sessionId ?? speaker.view.session.id, {
                  anchor: e.currentTarget.closest('.dock-pet-anchor'),
                  news: !!bubble,
                })
              }
            >
              <PanelRightOpen size={12} />
            </button>
          )}
          <button
            className="icon-btn"
            aria-label={d.expand}
            title={d.expandTitle}
            onClick={() => api.window('main')}
          >
            <Expand size={12} />
          </button>
          <button
            className="icon-btn"
            aria-label={d.refresh}
            title={d.refreshTitle}
            onClick={onRefresh}
          >
            <RotateCw size={12} />
          </button>
          <button className="icon-btn" aria-label={d.floor} title={d.floorTitle} onClick={onFloor}>
            <Flag size={12} />
          </button>
          <button
            className="icon-btn"
            aria-label={d.hide}
            title={d.hideTitle}
            onClick={() => api.window('hide')}
          >
            <X size={12} />
          </button>
        </div>
        <button
          className={`desk-pet tone-${status ? 'resting' : pet.group} ${speaker ? 'is-speaking' : ''}`}
          data-solid
          aria-label={d.aria(label, count)}
          title={d.title(total)}
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
              session={pet.lead?.session}
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
