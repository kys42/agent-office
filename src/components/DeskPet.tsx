import { focusLine } from '../shared/terminal-target';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Expand,
  Flag,
  PanelRightOpen,
  RotateCw,
  Terminal,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { jumpOrCopy } from '../lib/resume';
import { openColleague } from '../lib/dockCard';
import { useSendTargets } from '../lib/useSendTargets';
import { QuickReply } from './QuickReply';
import { targetLine } from './TerminalSend';
import type { ReceiptAction } from '../lib/useOffice';
import { MOODS, type NoticeReceipt, type ReplySender } from '../shared/types';
import { QuotaBadge } from './QuotaBadge';
import { dimsDesk } from '../shared/quota';
import {
  petChoices,
  petShown,
  petStep,
  petSummary,
  residentLabel,
  type OfficeModel,
} from '../shared/office-model';
import { branchInfo } from '../shared/branch';
import { PET_SIZE } from '../shared/dock-geometry';
import { deskSpeech, shownSpeech, stationSpeech } from '../shared/speech';
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
  notify,
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
  /** Desktop, with Send to terminal on: the speaking colleague can be answered right under its bubble. */
  onReply?: ReplySender;
  /** Says what a jump to the terminal did (or the resume command it copied). */
  notify?: (message: string) => void;
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
  // The pet stands for one colleague at a time, like one desk of the row: who just spoke (or
  // the lead), or the one the person picked with its arrows — until someone else speaks.
  const [chosen, setChosen] = useState<string | null>(null);
  const spoke = speaker?.notice.id ?? null;
  useEffect(() => {
    if (spoke) setChosen(null);
  }, [spoke]);
  // Laid out once per change of who is drawn (not per pointer move), as the row does.
  const all = useMemo(() => petChoices(model), [model.scene]);
  const choices = status ? [] : all;
  const shown = status ? { view: undefined, chosen: false } : petShown(choices, pet, chosen);
  const view = shown.view;
  const id = view?.session.id ?? null;
  // A helper speaking stands at its colleague's place among the arrows.
  const at = view?.session.attachedTo ?? id;
  const place = choices.findIndex((v) => v.session.id === at) + 1;
  const step = (by: -1 | 1) => {
    const next = petStep(choices, at ?? undefined, by);
    if (next) setChosen(next.session.id);
  };
  const [hover, setHover] = useState(false);
  // A bubble closed while pointing stays closed until the pointer leaves (as on a desk), even
  // when the pet then stands for someone else.
  const [closed, setClosed] = useState(false);
  const speaks = !!speaker && !!view && speaker.view.session.id === id;
  const said = speaks
    ? stationSpeech(
        speaker.view.session,
        model.notices,
        model.bubbleHours,
        model.now,
        speaker.notice,
      )
    : view
      ? deskSpeech(view.session, model.notices, model.bubbleHours, model.now)
      : undefined;
  // Clicking the bubble unfolds it here; a reply opens under it when the session can take one.
  // Both belong to what is being said, and reset when the pet says something else.
  const key = said ? `${id}:${said.bubble?.id ?? ''}` : null;
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const expanded = !!key && unfolded === key;
  const replying = !!key && replyFor === key;
  // Pointing at the pet shows what its colleague says — or the last thing it said, as a desk
  // does; otherwise it speaks only what just arrived.
  // An unfolded or replying bubble (a peek too) stays without the pointer, as on a desk.
  const pointing = (hover || expanded || replying) && !closed;
  const reveal = pointing || expanded || replying;
  const speech =
    view && said
      ? reveal
        ? shownSpeech(
            view.session,
            model.notices,
            model.bubbleHours,
            model.now,
            said,
            true,
            pointing,
          )
        : speaks
          ? { speech: said, peek: false }
          : undefined
      : undefined;
  const bubble = speech?.speech.bubble;
  const who = view && residentLabel(view.session, privacy);
  const replyId = bubble?.sessionId ?? id;
  const { targets, markSent } = useSendTargets(privacy || !id ? [] : [...new Set([id, replyId!])], {
    enabled: !privacy,
    pollBusy: false,
  });
  const target = replyId ? targets[replyId] : undefined;
  const deskTarget = id ? targets[id] : undefined;
  const canReply = !!onReply && !privacy && !!(target?.canSend || target?.canPrepare);
  const jump = (sessionId: string) => {
    const say = notify ?? (() => {});
    jumpOrCopy(sessionId, say).catch((e) => say((e as Error).message));
  };
  // Left and right pick the colleague before or after, as the row's arrows do — never from a
  // reply being written (its form keeps focus after Esc) or with a modifier held.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.isComposing || e.defaultPrevented || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey)
      return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, .quick-reply'))
      return;
    if (choices.length < 2) return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey(e);
    // The pointer leaving the window fast may skip the anchor's own leave.
    const left = () => {
      setHover(false);
      setClosed(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('mouseleave', left);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('mouseleave', left);
    };
  }, []);
  const lead = view ?? pet.lead;
  const dark = !status && !speaks && !!lead?.quota && dimsDesk(lead.session, lead.pose.working);
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
      <div
        className="dock-pet-anchor"
        // Only what is drawn counts: the window's see-through edges let the pointer pass by.
        onMouseOver={(e) => {
          if (e.target instanceof Element && e.target.closest('[data-solid]')) setHover(true);
        }}
        onMouseLeave={() => {
          setHover(false);
          setClosed(false);
        }}
      >
        {view && speech && key && (
          <div className="dock-pet-speech" data-solid>
            <SpeechBubble
              session={view.session}
              speech={speech.speech}
              peek={speech.peek}
              privacy={privacy}
              // Shown with the details when the pet is hovered (dock.css).
              quote
              expanded={expanded}
              onExpandedChange={(on) => setUnfolded(on ? key : null)}
              onViewed={() => {
                if (bubble && !privacy)
                  onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
              }}
              onPopup={(el) =>
                void openColleague(replyId!, {
                  anchor: el.closest('.dock-pet-anchor'),
                  news: false,
                })
              }
              onOpen={() => {
                if (bubble && !privacy && !expanded)
                  onReceipt([{ id: bubble.id, version: bubble.version }], 'view');
                setUnfolded(expanded ? null : key);
              }}
              reply={
                canReply
                  ? {
                      title: t.terminal.replyTitle(targetLine(target!, false)),
                      open: replying,
                      onClick: () => setReplyFor(replying ? null : key),
                    }
                  : undefined
              }
              onDismiss={() => {
                setClosed(true);
                if (bubble) onReceipt([{ id: bubble.id, version: bubble.version }], 'dismiss');
              }}
              detail={
                who && (
                  <>
                    <span>
                      <strong>{who.name}</strong> · {MOODS[view.session.status].label}
                    </span>
                    {!privacy && (
                      <span>
                        {who.project} · {branchInfo(view.session).label}
                      </span>
                    )}
                    <span>
                      {view.unread.length > 1 ? d.unread(view.unread.length) : ''}
                      {d.detailHint}
                    </span>
                  </>
                )
              }
            />
            {canReply && replying && (
              <QuickReply
                key={key}
                target={target!}
                name={who?.name ?? d.someone}
                onClose={() => setReplyFor(null)}
                onJump={api.jump ? () => jump(replyId!) : undefined}
                onSend={async (text, replaceDraft, allowPartialDraft) => {
                  const result = await onReply!(replyId!, text, replaceDraft, allowPartialDraft);
                  if (result.status === 'sent') markSent(replyId!);
                  return result;
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
        {/* As beside a desk of the row: this colleague's card and terminal, left of the pet. */}
        {view && (
          <div className="dock-pet-actions" data-solid>
            <button
              className="icon-btn"
              aria-label={d.openCard}
              title={d.openCardTitle}
              onClick={(e) =>
                void openColleague(bubble?.sessionId ?? view.session.id, {
                  anchor: e.currentTarget.closest('.dock-pet-anchor'),
                  news: !!bubble,
                })
              }
            >
              <PanelRightOpen size={12} />
            </button>
            {deskTarget?.canFocus && api.jump && (
              <button
                className="icon-btn"
                aria-label={t.terminal.jumpToTerminal(who?.name ?? d.someone)}
                title={t.terminal.jumpHint(focusLine(deskTarget, privacy))}
                onClick={() => jump(view.session.id)}
              >
                <Terminal size={12} />
              </button>
            )}
          </div>
        )}
        <div className="dock-pet-tools" data-solid>
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
        {/* Who the pet stands for: the colleague before or after, as the row's arrows. */}
        {choices.length > 1 && (
          <div className="dock-pet-nav" data-solid>
            <button
              className="dock-pet-step is-prev"
              aria-label={d.previous}
              title={d.previousTitle}
              onClick={() => step(-1)}
            >
              <ChevronLeft size={14} strokeWidth={2.6} />
            </button>
            <button
              className="dock-pet-step is-next"
              aria-label={d.next}
              title={d.nextTitle}
              onClick={() => step(1)}
            >
              <ChevronRight size={14} strokeWidth={2.6} />
            </button>
          </div>
        )}
        {/* The colleague it stands for used up its tool's limit: a dim pet with the badge. */}
        {!status && lead?.quota && <QuotaBadge quota={lead.quota} className="dock-pet-quota" />}
        <button
          className={`desk-pet tone-${status ? 'resting' : pet.group} ${speaks ? 'is-speaking' : ''} ${dark ? 'lights-out' : ''}`}
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
          {pet.calling && !speaks && <span className="dock-pet-bang">!</span>}
          {/* Re-keyed per notice so a new arrival replays the hop. */}
          <span className="dock-pet-body" key={speaks ? speaker.notice.id : (id ?? 'pet')}>
            <Sprite
              session={lead?.session}
              provider={lead?.session.provider ?? 'claude'}
              mood={status ? 'think' : (lead?.pose.mood ?? 'idle')}
              size={72}
            />
          </span>
          <span className="dock-pet-shadow" />
          {who && (speaks || shown.chosen || hover) && (
            <span className="dock-pet-name" title={privacy ? undefined : who.detail}>
              {who.name}
            </span>
          )}
          {hover && place > 0 && choices.length > 1 && (
            <span className="dock-pet-place">{d.place(place, choices.length)}</span>
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
