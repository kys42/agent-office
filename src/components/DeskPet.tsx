import { focusLine } from '../shared/terminal-target';
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, PanelRightOpen, Terminal, X } from 'lucide-react';
import { DockViewMenu, type DockViewControls } from './DockViewMenu';
import { api } from '../lib/api';
import { jumpOrCopy } from '../lib/resume';
import { openColleague } from '../lib/dockCard';
import { TRIAGE_LABELS } from '../shared/triage';
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
import { joyClass, usePetReactions } from '../lib/petReaction';
import { usePetting } from '../lib/usePetting';
import { PetJoy } from './PetJoy';

const DRAG_SLOP = 4;

/**
 * The collapsed dock: the colleague who most needs the person, as a small desktop pet.
 * A just-arrived result or question turns the pet into that colleague, speaking it.
 */
/** The groups the pet's pill counts, in triage order (resting colleagues are not counted). */
const TALLY = ['attention', 'results', 'working', 'standby'] as const;

export function DeskPet({
  model,
  status,
  privacy,
  onReceipt,
  onExpand,
  onReply,
  view: viewMenu,
  notify,
  preview = false,
}: {
  model: OfficeModel;
  /** Shown instead of the summary until the first snapshot arrives (or fails). */
  status: string | null;
  privacy: boolean;
  onReceipt: (receipts: NoticeReceipt[], action: ReceiptAction) => void;
  /** Unfold in the last used look (office row or floor desks), from its own button. */
  onExpand: () => void;
  /** Desktop, with Send to terminal on: the speaking colleague can be answered right under its bubble. */
  onReply?: ReplySender;
  /** Says what a jump to the terminal did (or the resume command it copied). */
  notify?: (message: string) => void;
  /** The 보기 menu (looks, tiny, the big office, settings); absent in the settings preview. */
  view?: DockViewControls;
  /**
   * Drawn small in the settings (#324): the same pet, without anything that reaches outside it —
   * no window keys, terminal lookups, dock window calls or cards.
   */
  preview?: boolean;
}) {
  const { t } = useI18n();
  const reactionOf = usePetReactions((id) => model.view(id) !== undefined);
  const petting = usePetting();
  // What the person chose to see on the pet (#324); unset, the look from before.
  const show = model.display.views.pet;
  const pats = show.petting && !preview;
  const d = t.dock.pet;
  const pet = petSummary(model);
  const total = model.seats.length;
  const label = status ?? pet.label;
  const count = !status && pet.group !== 'resting' ? pet.count : null;
  // The office in numbers: waiting for the person, results to read, at work, standing by.
  // Nobody in the chosen groups: they show at 0 rather than falling back to a pill that names
  // a group the person left out.
  const picked = TALLY.filter((group) => show.tallyGroups.includes(group));
  const busy = picked.filter((group) => model.counts[group] > 0);
  const tally =
    status || !show.tally
      ? []
      : (busy.length ? busy : picked).map((group) => ({ group, count: model.counts[group] }));
  const tallyWords = tally.map((g) => `${TRIAGE_LABELS[g.group]} ${g.count}`).join(' · ');
  const speaker = status ? undefined : pet.speaker;
  // The pet stands for one colleague at a time, like one desk of the row: who just spoke (or
  // the lead), or the one the person picked with its arrows — until someone else speaks.
  const [chosen, setChosen] = useState<string | null>(null);
  const spoke = speaker?.notice.id ?? null;
  // Which way the pet turned to someone else (arrows); a new speaker just pops in.
  const [enter, setEnter] = useState<'next' | 'prev' | null>(null);
  useEffect(() => {
    if (!spoke) return;
    setChosen(null);
    setEnter(null);
  }, [spoke]);
  // Hovering a number in the pill lists who it counts; a name opens that colleague's card.
  const [listed, setListed] = useState<(typeof TALLY)[number] | null>(null);
  const unlist = useRef<ReturnType<typeof setTimeout>>(undefined);
  const list = (group: (typeof TALLY)[number] | null) => {
    clearTimeout(unlist.current);
    setListed(group);
  };
  // A pointer only passing over a number (or resting there as the pet appears) does not open
  // its list: it opens after a short stay, or at once on a click or Enter.
  const listSoon = (group: (typeof TALLY)[number]) => {
    clearTimeout(unlist.current);
    unlist.current = setTimeout(() => setListed(group), 250);
  };
  // Leaving the number for the list (or back) must not close it on the way.
  const listLater = () => {
    clearTimeout(unlist.current);
    unlist.current = setTimeout(() => setListed(null), 200);
  };
  useEffect(() => () => clearTimeout(unlist.current), []);
  // The pill counts every desk shown, helpers too (model.counts): list the same ones.
  const members = listed
    ? model.seats
        .filter((v) => !v.veiled)
        .flatMap((v) => [v, ...v.helpers.filter((h) => !h.veiled)])
        .filter((v) => v.group === listed)
    : [];
  // Laid out once per change of who is drawn (not per pointer move), as the row does.
  const counted = show.tally ? show.tallyGroups.join() : '';
  const all = useMemo(() => petChoices(model), [model.scene, show.tally, counted]);
  const choices = status ? [] : all;
  const shown = status ? { view: undefined, chosen: false } : petShown(choices, pet, chosen);
  const view = shown.view;
  const id = view?.session.id ?? null;
  // A helper speaking stands at its colleague's place among the arrows.
  const at = view?.session.attachedTo ?? id;
  const place = choices.findIndex((v) => v.session.id === at) + 1;
  // The arrows go somewhere: to another counted colleague, or to the only one counted when the
  // pet now shows someone outside the counted groups (the lead, a speaker).
  const canStep = choices.length > 1 || (choices.length === 1 && place === 0);
  const step = (by: -1 | 1) => {
    const next = petStep(choices, at ?? undefined, by);
    if (!next) return;
    setChosen(next.session.id);
    setEnter(by > 0 ? 'next' : 'prev');
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
  // A list open from the pill takes the view: no peeking bubble behind it.
  const pointing = (hover || expanded || replying) && !closed && !listed;
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
    enabled: !privacy && !preview,
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
    if (!canStep) return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  });
  useEffect(() => {
    if (preview) return;
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
  const joy = reactionOf(lead?.session.id);
  const dark = !status && !speaks && !!lead?.quota && dimsDesk(lead.session, lead.pose.working);
  // Like a desk of the row: its colleague's card pops up right here, on the conversation. The
  // row and the floor unfold from their own button; an office with nobody in it still unfolds.
  const activate = (from: Element) => {
    if (preview) return;
    if (view)
      void openColleague(bubble?.sessionId ?? view.session.id, {
        anchor: from.closest('.dock-pet-anchor'),
        conversation: !!bubble,
      });
    else onExpand();
  };
  const listId = useId();
  // The slide plays only for the person's own turn (arrows), never later on its own.
  const entering = show.turnEffect && enter && shown.chosen && !speaks ? enter : null;
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const endDrag = () => {
    if (!press.current) return;
    dragged.current = press.current.moved;
    press.current = null;
    if (!preview) void api.dock?.('drag-end');
  };
  return (
    <div className="desk-pet-stage" style={PET_SIZE}>
      <div
        className={`dock-pet-anchor ${listed ? 'is-listing' : ''}`}
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
                  conversation: true,
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
                    <span>{d.detailHint}</span>
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
                onSend={async (text, replaceDraft, allowPartialDraft, images) => {
                  const result = await onReply!(
                    replyId!,
                    text,
                    replaceDraft,
                    allowPartialDraft,
                    images,
                  );
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
              data-tip={d.openCardTitle}
              onClick={(e) =>
                // Like a desk's bubble: the card shows the conversation it speaks for.
                void openColleague(bubble?.sessionId ?? view.session.id, {
                  anchor: e.currentTarget.closest('.dock-pet-anchor'),
                  conversation: !!bubble,
                })
              }
            >
              <PanelRightOpen size={12} />
            </button>
            {deskTarget?.canFocus && api.jump && (
              <button
                className="icon-btn"
                aria-label={t.terminal.jumpToTerminal(who?.name ?? d.someone)}
                data-tip={t.terminal.jumpHint(focusLine(deskTarget, privacy))}
                onClick={() => jump(view.session.id)}
              >
                <Terminal size={12} />
              </button>
            )}
          </div>
        )}
        {/* Two doors, as on the row's pill: 보기 (the looks, tiny, the big office, settings) and
            hide. They stay up while the menu is open (dock.css). */}
        <div className="dock-pet-tools" data-solid>
          <DockViewMenu controls={viewMenu} label={false} size={12} />
          <button
            className="icon-btn"
            aria-label={d.hide}
            data-tip={t.dock.tips.hide}
            onClick={() => api.window('hide')}
          >
            <X size={12} />
          </button>
        </div>
        {/* Who the pet stands for: the colleague before or after, as the row's arrows. */}
        {canStep && (
          <div className="dock-pet-nav" data-solid>
            <button
              className="dock-pet-step is-prev"
              aria-label={d.previous}
              data-tip={d.previousTitle}
              onClick={() => step(-1)}
            >
              <ChevronLeft size={14} strokeWidth={2.6} />
            </button>
            <button
              className="dock-pet-step is-next"
              aria-label={d.next}
              data-tip={d.nextTitle}
              onClick={() => step(1)}
            >
              <ChevronRight size={14} strokeWidth={2.6} />
            </button>
          </div>
        )}
        {/* The colleague it stands for used up its tool's limit: a dim pet with the badge. */}
        {!status && lead?.quota && <QuotaBadge quota={lead.quota} className="dock-pet-quota" />}
        <button
          className={`desk-pet tone-${status ? 'resting' : pet.group} ${speaks ? 'is-speaking' : ''} ${dark ? 'lights-out' : ''} ${pats ? '' : 'no-petting'}`}
          data-solid
          // Screen readers hear the same tally the pill draws, in words.
          aria-label={tally.length ? d.aria(tallyWords, null) : d.aria(label, count)}
          title={d.title(total)}
          onPointerDown={(e) => {
            if (e.button !== 0 || preview) return;
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
          // Rubbing the pet pets the colleague it stands for (a drag holds the button).
          {...(pats ? petting(lead?.session.id) : {})}
          onClick={(e) => {
            // A drag that ends on the pet is a move, not a request to open anything.
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            activate(e.currentTarget);
          }}
        >
          {/* While another colleague speaks, the pill still says who is waiting. */}
          {pet.calling && !speaks && <span className="dock-pet-bang">!</span>}
          {/* Re-keyed per notice so a new arrival replays the hop. */}
          {/* A quick puff when the person turns the pet to someone, or a new colleague speaks. */}
          {show.turnEffect && (entering || speaks) && (
            <span
              className="pet-swap-puff"
              key={`puff:${speaks ? speaker.notice.id : id}`}
              aria-hidden="true"
            >
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          <span
            className={`dock-pet-body joy-host ${entering ? `enter-${entering}` : ''} ${joyClass(joy)}`}
            key={speaks ? speaker.notice.id : (id ?? 'pet')}
          >
            <Sprite
              session={lead?.session}
              provider={lead?.session.provider ?? 'claude'}
              mood={status ? 'think' : joy ? 'idle' : (lead?.pose.mood ?? 'idle')}
              size={72}
            />
            {joy && <PetJoy key={joy.key} reaction={joy} />}
          </span>
          <span className="dock-pet-shadow" />
          {who &&
            (show.name === 'always' ||
              (show.name === 'speaking' && (speaks || shown.chosen || hover))) && (
              <span className="dock-pet-name" title={privacy ? undefined : who.detail}>
                {who.name}
              </span>
            )}
          {hover && place > 0 && choices.length > 1 && (
            <span className="dock-pet-place">{d.place(place, choices.length)}</span>
          )}
        </button>
        {/* Who is doing what at a glance: a coloured dot and a number per group (none at 0).
            Its own controls under the pet, outside the pet's button (which drags and opens the
            card): each number is a button that lists who it counts, by mouse or keyboard. */}
        <div
          className={`dock-pet-pillbar tone-${status ? 'resting' : pet.group}`}
          data-solid
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setListed(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !listed) return;
            // Close the list first; the dock folds only on an Esc with nothing open.
            e.preventDefault();
            e.stopPropagation();
            setListed(null);
            e.currentTarget.querySelector<HTMLElement>(`.tally-${listed}`)?.focus();
          }}
        >
          {listed && members.length > 0 && (
            <div
              className={`dock-pet-list tally-${listed}`}
              id={listId}
              role="group"
              aria-label={`${TRIAGE_LABELS[listed]} ${members.length}`}
              onMouseEnter={() => list(listed)}
              onMouseLeave={listLater}
            >
              <b>
                <i />
                {TRIAGE_LABELS[listed]} {members.length}
              </b>
              {members.map((v) => {
                const name = residentLabel(v.session, privacy);
                return (
                  <button
                    key={v.session.id}
                    type="button"
                    aria-label={d.openCardOf(name.name)}
                    onClick={(e) => {
                      void openColleague(v.session.id, {
                        anchor: e.currentTarget.closest('.dock-pet-anchor'),
                      });
                      // The pet turns to that colleague too, when it can stand for it.
                      if (choices.some((c) => c.session.id === v.session.id)) {
                        setChosen(v.session.id);
                        setEnter(null);
                      }
                      setListed(null);
                    }}
                  >
                    <Sprite
                      session={v.session}
                      provider={v.session.provider}
                      mood={v.pose.mood}
                      size={22}
                    />
                    <span className="pet-list-name">{name.name}</span>
                    <small>{MOODS[v.session.status].label}</small>
                  </button>
                );
              })}
            </div>
          )}
          {tally.length ? (
            <div className="dock-pet-pill dock-pet-tally" role="group" aria-label={tallyWords}>
              {tally.map((g) => (
                <button
                  key={g.group}
                  type="button"
                  className={listed === g.group ? `tally-${g.group} is-listed` : `tally-${g.group}`}
                  title={`${TRIAGE_LABELS[g.group]} ${g.count}`}
                  aria-label={d.listOf(TRIAGE_LABELS[g.group], g.count)}
                  aria-expanded={listed === g.group}
                  aria-controls={listed === g.group ? listId : undefined}
                  onMouseEnter={() => (listed ? list(g.group) : listSoon(g.group))}
                  onMouseLeave={listLater}
                  // Opens (a hover may already have): Esc, leaving or another number closes it.
                  onClick={() => list(g.group)}
                >
                  <i />
                  {g.count}
                </button>
              ))}
            </div>
          ) : (
            // Nobody counted (still loading, or all resting): the pill does what the pet does.
            <button
              type="button"
              className="dock-pet-pill"
              aria-label={d.aria(label, count)}
              onClick={(e) => activate(e.currentTarget)}
            >
              <i />
              {label}
              {count !== null && <b>{count}</b>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
