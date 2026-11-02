import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useLaunchSupport } from './useLaunchSupport';
import { copyText, jumpOrCopy } from './resume';
import { m } from '../shared/i18n';
import {
  chosenDestination,
  destinationRows,
  draftIntent,
  duplicateView,
  ownTmuxCommand,
  firstResumable,
  forkDefaultName,
  broughtUp,
  resultView,
  type ConversationChoice,
  type GoThere,
  type LaunchDraft,
  type ResultAction,
  type ResultView,
} from '../shared/launch-sheet';
import type {
  LaunchDestinationId,
  LaunchIntent,
  LaunchOptions,
  LaunchResult,
} from '../shared/launch';
import { sessionName } from '../shared/office';
import type { Session } from '../shared/types';

/** Where the sheet was opened from, and what it may offer. */
export type LaunchEntry =
  /** A work card: its own conversation, preselected. */
  | { from: 'card'; session: Session }
  /**
   * A project "+": a new session in one of its folders, or one of its conversations (the
   * office's, then the lounge's and the archive's: those come back to the office once open).
   */
  | { from: 'project'; projects: Session[]; choices: ConversationChoice[]; hidden: number };

export interface LaunchHooks {
  notify: (message: string) => void;
  /** Closes the sheet (after a launch that needs nothing more from it). */
  close: () => void;
  /** The existing "bring back to the office": true once stored. */
  onReturn?: (id: string) => unknown;
}

export type LaunchPhase = 'form' | 'starting' | 'result';
const OPEN_AFTER_KEY = 'office:launch:tmux-open';
const readOpenAfter = () => {
  try {
    return localStorage.getItem(OPEN_AFTER_KEY) !== 'off';
  } catch {
    return true;
  }
};

function initialDraft(entry: LaunchEntry): LaunchDraft {
  const base = { provider: 'claude' as const, name: m().tmux.summonDefault, message: '' };
  if (entry.from === 'card')
    return {
      ...base,
      kind: 'resume',
      at: entry.session.id,
      session: entry.session.id,
      forkName: forkDefaultName(sessionName(entry.session)),
    };
  const session = firstResumable(entry.choices);
  const original = entry.choices.find((c) => c.session.id === session)?.session;
  return {
    ...base,
    kind: 'new',
    at: entry.projects[0]?.id ?? '',
    session,
    forkName: original ? forkDefaultName(sessionName(original)) : '',
  };
}

/**
 * The launch sheet's state and actions (#319): the draft, the core's options for it (read
 * again as the draft changes), the chosen destination, and a start's progress and result.
 * The sheet only draws what this returns; every decision is in src/shared/launch-sheet.ts
 * and the main process (desktop/launch/).
 */
export function useLaunch(entry: LaunchEntry, hooks: LaunchHooks) {
  const [draft, setDraft] = useState<LaunchDraft>(() => initialDraft(entry));
  const [options, setOptions] = useState<{ key: string; value: LaunchOptions } | null>(null);
  const [checking, setChecking] = useState(false);
  const [picked, setPicked] = useState<LaunchDestinationId | null>(null);
  const [phase, setPhase] = useState<LaunchPhase>('form');
  const [result, setResult] = useState<ResultView | null>(null);
  const [error, setError] = useState('');
  /** A colleague brought up but whose return to the office was not stored: offered again. */
  const [unreturned, setUnreturned] = useState(false);
  const [openAfter, setOpenAfterState] = useState(readOpenAfter);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const optionsTicket = useRef(0);
  /**
   * The current action. Bumped by a draft change and by closing the sheet: an answer to an
   * older one then does nothing on screen (no Terminal opened, no close, no result) — the
   * sheet may be gone or another one open. Bringing an away colleague back is not on screen:
   * a launch that did start still brings them back.
   */
  const actionTicket = useRef(0);
  /** One action at a time: a second click before the first answers is ignored. */
  const inFlight = useRef(false);
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      actionTicket.current++;
      optionsTicket.current++;
    };
  }, []);
  const returned = useRef(new Set<string>());
  // Where `open` works on this platform (main's answer): tmux into Terminal, an Orca tab.
  const opens = useLaunchSupport()?.opens ?? [];
  const opensTmux = opens.includes('tmux');

  const choices = entry.from === 'project' ? entry.choices : [];
  const projects = entry.from === 'project' ? entry.projects : [entry.session];
  const conversation =
    entry.from === 'card'
      ? { session: entry.session, zone: 'office' as const }
      : choices.find((c) => c.session.id === draft.session);
  // A project's sessions can change under an open sheet: never launch in a stale folder.
  const projectIds = projects.map((p) => p.id).join('\n');
  const choiceIds = choices.map((c) => c.session.id).join('\n');
  useEffect(() => {
    if (entry.from !== 'project') return;
    const ids = projectIds ? projectIds.split('\n') : [];
    const resumable = choiceIds ? choiceIds.split('\n') : [];
    setDraft((d) => {
      let next = d;
      if (!ids.includes(d.at)) next = { ...next, at: ids[0] ?? '' };
      if (d.session && !resumable.includes(d.session))
        next = { ...next, session: firstResumable(entry.choices) };
      return next;
    });
  }, [projectIds, choiceIds, entry.from]);

  const probeIntent = useMemo(() => draftIntent(draft, true), [draft]);
  const key = probeIntent ? JSON.stringify(probeIntent) : '';
  const fetchOptions = useCallback(async (intent: LaunchIntent | null, intentKey: string) => {
    const ticket = ++optionsTicket.current;
    if (!intent || !api.launchOptions) {
      setChecking(false);
      return null;
    }
    setChecking(true);
    try {
      const value = await api.launchOptions(intent);
      if (ticket !== optionsTicket.current) return null;
      setOptions({ key: intentKey, value });
      return value;
    } catch (e) {
      if (ticket === optionsTicket.current) {
        setOptions(null);
        setError((e as Error).message);
      }
      return null;
    } finally {
      if (ticket === optionsTicket.current) setChecking(false);
    }
  }, []);
  // Read the options again whenever what is asked changes (typing a name waits a moment).
  const first = useRef(true);
  useEffect(() => {
    const wait = first.current ? 0 : 250;
    first.current = false;
    if (!key) {
      optionsTicket.current++;
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = setTimeout(() => void fetchOptions(probeIntent, key), wait);
    return () => clearTimeout(timer);
  }, [key, fetchOptions]);

  const current = options?.key === key && key ? options.value : null;
  // While the options are read again (a name typed, another kind), the last answer stays on
  // screen instead of flashing every row back to "checking"; only a fresh one can start.
  const shown = current ?? options?.value ?? null;
  const duplicate = duplicateView(current?.duplicate, opens, ownTmuxCommand(current));
  const rows = destinationRows(shown);
  const chosen = chosenDestination(shown, picked);
  const intent = draftIntent(draft);
  const starting = phase === 'starting';
  /** A start, an open, a jump or a copy is under way: every control waits for it. */
  const busy = starting || working;
  const canStart = !!intent && !!chosen && !!current && !duplicate.blocks && !busy && !checking;
  const away = !!conversation && conversation.zone !== 'office' && draft.kind === 'resume';

  /** Any change to the draft makes an earlier result moot. */
  const edit = (patch: Partial<LaunchDraft>) => {
    actionTicket.current++;
    setDraft((d) => ({ ...d, ...patch }));
    setResult(null);
    setError('');
    setUnreturned(false);
    setPhase('form');
  };
  const pickConversation = (id: string) => {
    const c = choices.find((x) => x.session.id === id);
    if (!c || c.block) return;
    edit({ session: id, forkName: forkDefaultName(sessionName(c.session)) });
  };
  const setKind = (kind: LaunchDraft['kind']) => {
    if (kind === draft.kind) return;
    const session = draft.session ?? firstResumable(choices);
    const original =
      choices.find((c) => c.session.id === session)?.session ?? conversation?.session;
    edit({
      kind,
      session,
      ...(!draft.forkName && original && { forkName: forkDefaultName(sessionName(original)) }),
    });
    setPicked(null);
  };
  const setOpenAfter = (on: boolean) => {
    setOpenAfterState(on);
    try {
      localStorage.setItem(OPEN_AFTER_KEY, on ? 'on' : 'off');
    } catch {
      // Remembering is a convenience.
    }
  };

  /** Brings an away colleague back once their conversation is open somewhere. */
  const bringBack = async (): Promise<boolean> => {
    const id = conversation?.session.id;
    if (!away || !id || !hooksRef.current.onReturn) return true;
    if (returned.current.has(id)) return true;
    try {
      if ((await hooksRef.current.onReturn(id)) !== true) return false;
    } catch {
      return false;
    }
    returned.current.add(id);
    return true;
  };
  /** Shows a finished view: closes on success unless the colleague did not come back. */
  const finish = async (ticket: number, view: ResultView, brought: boolean) => {
    const back = brought ? await bringBack() : true;
    if (ticket !== actionTicket.current) return;
    if (view.close && back) {
      hooksRef.current.notify(view.toast);
      hooksRef.current.close();
      return;
    }
    if (view.close) hooksRef.current.notify(view.toast);
    setUnreturned(!back);
    setResult(
      view.close
        ? { close: false, tone: 'info', text: view.toast, actions: [] }
        : (view as Exclude<ResultView, { close: true }>),
    );
    setPhase('result');
  };
  const run = async (work: (ticket: number) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    const ticket = ++actionTicket.current;
    setError('');
    try {
      await work(ticket);
    } catch (e) {
      if (ticket !== actionTicket.current) return;
      setError((e as Error).message);
      setPhase((p) => (p === 'starting' ? 'form' : p));
      void fetchOptions(probeIntent, key);
    } finally {
      inFlight.current = false;
      if (alive.current) setWorking(false);
    }
  };
  /**
   * An answer to an older action (the sheet closed or the draft changed meanwhile): nothing on
   * screen, but a colleague whose conversation did open still comes back to the office.
   */
  const stale = (ticket: number, answer?: LaunchResult | 'opened') => {
    if (ticket === actionTicket.current) return false;
    if (answer && (answer === 'opened' || broughtUp(answer))) void bringBack();
    return true;
  };
  /** An `open` of this launch's own place (tmux session, Orca tab). */
  const open = (destination: LaunchDestinationId, asked: LaunchIntent) =>
    api.launch!({ intent: asked, destination, action: 'open' });

  const start = (destination: LaunchDestinationId | null = chosen) =>
    run(async (ticket) => {
      if (!intent || !destination || !api.launch) return;
      setPicked(destination);
      setPhase('starting');
      setResult(null);
      setUnreturned(false);
      let answer: LaunchResult = await api.launch({ intent, destination, action: 'start' });
      if (stale(ticket, answer)) return;
      // tmux keeps it in the background: open it in a terminal right away unless turned off.
      if (answer.state === 'launched' && destination === 'tmux' && openAfter && opensTmux) {
        const started = answer;
        try {
          answer = await open('tmux', intent);
        } catch (e) {
          if (stale(ticket, started)) return;
          hooksRef.current.notify(started.message);
          // It runs in tmux all the same: an away colleague comes back.
          const back = await bringBack();
          if (ticket !== actionTicket.current) return;
          setUnreturned(!back);
          setResult({
            close: false,
            tone: 'error',
            text: (e as Error).message,
            actions: [
              { kind: 'open-terminal' },
              ...(started.command
                ? [{ kind: 'copy-command', command: started.command } as const]
                : []),
            ],
          });
          setPhase('result');
          return;
        }
      }
      // A refusal may change the duplicate state or what is available: read them again.
      const fresh = answer.state === 'refused' ? await fetchOptions(probeIntent, key) : current;
      if (stale(ticket, answer)) return;
      const view = resultView(answer, fresh, opens);
      if (!view) {
        setPhase('form');
        return;
      }
      await finish(ticket, view, broughtUp(answer));
    });

  const goThere = (go: GoThere) =>
    run(async (ticket) => {
      const id = conversation?.session.id;
      if (go === 'jump') {
        if (!id) return;
        // A vanished terminal only copies the resume command: nothing opened, nobody comes back.
        const how = await jumpOrCopy(id, hooksRef.current.notify);
        if (stale(ticket, how !== 'copy' ? 'opened' : undefined)) return;
        const back = how === 'copy' || (await bringBack());
        if (ticket !== actionTicket.current) return;
        if (!back) {
          setUnreturned(true);
          return;
        }
        hooksRef.current.close();
        return;
      }
      const asked =
        go === 'orca-tab' && id ? { kind: 'resume' as const, session: id } : probeIntent;
      if (!asked) return;
      const answer = await open(go === 'orca-tab' ? 'orca' : 'tmux', asked);
      if (stale(ticket, answer)) return;
      await finish(ticket, resultView(answer, null, opens)!, true);
    });

  const act = (action: ResultAction) => {
    switch (action.kind) {
      case 'reveal':
        return void run(async () => {
          await api.orcaReveal?.();
        });
      case 'go':
        return void goThere(action.go);
      case 'open-terminal':
        return void goThere('tmux');
      case 'copy-command':
        return void run(() => copyText(action.command, hooksRef.current.notify));
      case 'suggest':
        return void start(action.destination);
    }
  };
  const returnAgain = () =>
    run(async (ticket) => {
      const back = await bringBack();
      if (ticket !== actionTicket.current) return;
      setUnreturned(!back);
      if (back) hooksRef.current.close();
    });

  return {
    draft,
    edit,
    setKind,
    pickConversation,
    conversation,
    choices,
    hidden: entry.from === 'project' ? entry.hidden : 0,
    projects,
    options: current,
    checking: checking || (!!key && !current && !error),
    rows,
    /** The rows are the previous answer, being read again. */
    stale: !!shown && !current,
    chosen,
    pick: (id: LaunchDestinationId) => setPicked(id),
    duplicate,
    intent,
    canStart,
    busy,
    /** A start is under way (main's confirmation may be up). */
    starting,
    phase,
    result,
    error,
    away,
    unreturned,
    openAfter,
    setOpenAfter,
    canOpenAfter: opensTmux,
    start: () => void start(),
    goThere: (go: GoThere) => void goThere(go),
    act,
    returnAgain: () => void returnAgain(),
    refresh: () => {
      if (inFlight.current) return;
      setError('');
      setResult(null);
      setPhase('form');
      void fetchOptions(probeIntent, key);
    },
  };
}
