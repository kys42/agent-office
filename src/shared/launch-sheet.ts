import { m } from './i18n';
import {
  LAUNCH_DESTINATIONS,
  launchMessageSchema,
  launchNameSchema,
  pendingNotice,
  type LaunchDestinationId,
  type LaunchIntent,
  type LaunchKind,
  type LaunchOptions,
  type LaunchResult,
} from './launch';
import { isBackground, isHelper } from './residents';
import { awayColleagues, resumeBlock, type AwayZone, type ResumeBlock } from './summon-existing';
import type { DuplicateCheck, LaunchPlace, OfficeZone, Session } from './types';

/**
 * The launch sheet's view model (#319), pure: what to start (new, resume, fork), where (the
 * launch core's destinations with their reasons) and what came of it. The sheet only draws
 * these answers; the hook (src/lib/useLaunch.ts) holds the state and calls the desktop API.
 * Nothing here branches on an agent: agents are data (`NEW_AGENTS`), destinations are the
 * core's list.
 */

export const LAUNCH_KINDS: readonly LaunchKind[] = ['new', 'resume', 'fork'];
/** The agents a new session can be started with from the office, as the sheet lists them. */
export const NEW_AGENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
] as const;
export type NewAgent = (typeof NEW_AGENTS)[number]['id'];
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  openclaw: 'OpenClaw',
};
/** An agent's product name, as a conversation row shows it. */
export const agentLabel = (provider: string) => AGENT_LABELS[provider] ?? provider;

/** What the person filled in so far. */
export interface LaunchDraft {
  kind: LaunchKind;
  /** new: a session of the project whose folder the new conversation starts in. */
  at: string;
  provider: NewAgent;
  /** new: the colleague's name. */
  name: string;
  /** fork: the new conversation's name (prefilled from the original's). */
  forkName: string;
  /** new / fork: the first message (optional). */
  message: string;
  /** resume / fork: the conversation. */
  session?: string;
}

/** Why a name cannot be used ('' when it can): the launch core's own rule. */
export function nameProblem(name: string): string {
  return launchNameSchema.safeParse(name).success ? '' : m().tmux.invalidName;
}

/** Why a first message cannot be sent ('' when it can). */
export function messageProblem(message: string): string {
  return launchMessageSchema.safeParse(message).success ? '' : m().tmux.invalidMessage;
}

const NAME_LIMIT = 40;
/**
 * A valid default name for a fork of `original` ("<name> fork"): characters the name rule
 * does not take become spaces, and the original is shortened so the whole stays within 40.
 */
export function forkDefaultName(original: string): string {
  const suffix = m().launchSheet.forkSuffix;
  const base = [
    ...original
      .normalize('NFC')
      .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ];
  const room = NAME_LIMIT - [...suffix].length - 1;
  const kept = base.slice(0, Math.max(0, room)).join('').trim();
  return kept ? `${kept} ${suffix}` : suffix;
}

/**
 * The intent of the draft, or null while it cannot be asked yet (no conversation picked, an
 * invalid name or message). `probe`: the intent asked for the options, without the message
 * (it does not change where a launch can go, only whether it is valid).
 */
export function draftIntent(draft: LaunchDraft, probe = false): LaunchIntent | null {
  const initialMessage = probe ? '' : draft.message;
  if (!probe && messageProblem(draft.message)) return null;
  if (draft.kind === 'new') {
    if (!draft.at || nameProblem(draft.name)) return null;
    return {
      kind: 'new',
      at: draft.at,
      provider: draft.provider,
      name: draft.name.trim(),
      initialMessage,
    };
  }
  if (!draft.session) return null;
  if (draft.kind === 'resume') return { kind: 'resume', session: draft.session };
  if (nameProblem(draft.forkName)) return null;
  return {
    kind: 'fork',
    session: draft.session,
    name: draft.forkName.trim(),
    initialMessage,
  };
}

/** One conversation the sheet can continue or fork. */
export interface ConversationChoice {
  session: Session;
  zone: OfficeZone;
  /** Why it cannot be continued from here (listed, disabled). */
  block?: ResumeBlock;
}

/**
 * The conversations a project "+" offers to continue or fork: this project's colleagues in
 * the office first (newest first), then those resting in the lounge or the archive (the
 * former "bring back a colleague"; at most `AWAY_LIMIT`, the rest counted in `hidden`).
 */
export function conversationChoices(
  zones: Pick<Record<OfficeZone, Session[]>, AwayZone> | undefined,
  projectSessions: Session[],
): { list: ConversationChoice[]; hidden: number } {
  const office = projectSessions
    .filter((s) => !s.attachedTo && !isHelper(s) && !isBackground(s))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map((s): ConversationChoice => ({ session: s, zone: 'office', block: resumeBlock(s) }));
  const seen = new Set(office.map((c) => c.session.id));
  const away = zones ? awayColleagues(zones, projectSessions) : { list: [], total: 0 };
  const rest = away.list.filter((c) => !seen.has(c.session.id));
  return { list: [...office, ...rest], hidden: away.total - away.list.length };
}

/** The first conversation that can be continued, for a sheet opened without one. */
export const firstResumable = (choices: ConversationChoice[]) =>
  choices.find((c) => !c.block)?.session.id;

/** Where a destination's launch runs, as the duplicate check names it (copy: nowhere). */
export const placeOf = (id: LaunchDestinationId): LaunchPlace | null =>
  id === 'orca' ? 'orca' : id === 'tmux' ? 'tmux' : id === 'terminalApp' ? 'other' : null;

/** How to get to where a conversation already is. */
export type GoThere =
  /** Its agent runs in a terminal: bring that terminal to the front (`jump`). */
  | 'jump'
  /** Its tab is open in Orca: switch to that tab, matched again in main. */
  | 'orca-tab'
  /** Its own tmux session is there: open it in a terminal. */
  | 'tmux';

/** What the duplicate check means for this sheet. */
export interface DuplicateView {
  /** What to say ('' for nothing). */
  notice: string;
  tone: 'none' | 'caution' | 'running' | 'pending';
  go?: GoThere;
  /** An unconfirmed Orca start: only bringing Orca to the front helps. */
  reveal?: boolean;
  /** It is in the app's own tmux session: its attach command, to copy (works everywhere). */
  copy?: string;
  /**
   * Nothing new may be started from here: it already runs (go there instead), or a start
   * of it was not confirmed (never suggest another place: it may start twice).
   */
  blocks: boolean;
}

/** Where `open` works when the platform's answer is not known (`LaunchSupport.opens`). */
const OPENS: readonly LaunchDestinationId[] = ['orca', 'tmux'];

/**
 * The app's own tmux session of this launch, when it runs: its attach command (the tmux
 * probe says `running` with the command to reconnect).
 */
export function ownTmuxCommand(options: LaunchOptions | null): string | undefined {
  const probe = options?.destinations.find((d) => d.id === 'tmux')?.probe;
  return probe?.available && probe.running ? probe.command : undefined;
}

/**
 * The duplicate check, as the sheet draws it. A resume checks the whole conversation; a new
 * session or a fork only the same launch still starting (the core decides which). `opens`:
 * the destinations whose own place can be brought to the front on this platform. `own`: the
 * attach command of the app's own tmux session of it, when that runs (`ownTmuxCommand`).
 *
 * In the app's own tmux session it runs detached: there is no terminal to jump to (Linux
 * has none to open either). It is opened in Terminal where `open` works, and its attach
 * command can always be copied.
 */
export function duplicateView(
  check: DuplicateCheck | undefined,
  opens: readonly LaunchDestinationId[] = OPENS,
  own?: string,
): DuplicateView {
  const t = m().tmux;
  if (!check || check.state === 'none') return { notice: '', tone: 'none', blocks: false };
  if (check.state === 'unknown') return { notice: t.unknownNotice, tone: 'caution', blocks: false };
  const place = t.place[check.where];
  const inOwnTmux = check.where === 'tmux' && !!own;
  const copy = inOwnTmux ? { copy: own } : {};
  const openTmux = opens.includes('tmux') ? ('tmux' as const) : undefined;
  if (check.state === 'running') {
    const go: GoThere | undefined = inOwnTmux ? openTmux : 'jump';
    return {
      notice: t.runningNotice(place),
      tone: 'running',
      ...(go && { go }),
      ...copy,
      blocks: true,
    };
  }
  if (check.pending && !check.starting)
    return {
      notice: pendingNotice(check.where),
      tone: 'pending',
      reveal: check.where === 'orca',
      blocks: true,
    };
  const go: GoThere | undefined =
    check.where === 'orca' && opens.includes('orca')
      ? 'orca-tab'
      : check.where === 'tmux'
        ? openTmux
        : undefined;
  return {
    notice: check.starting
      ? pendingNotice(check.where, true)
      : `${t.openNotice(place)} ${t.openHint}`,
    tone: 'caution',
    ...(go && { go }),
    ...copy,
    blocks: false,
  };
}

/** One row of "where". */
export interface DestinationRow {
  id: LaunchDestinationId;
  label: string;
  /** What it is, in a few words. */
  hint: string;
  available: boolean;
  /** Its badge: available, already running, checking, or not available. */
  badge: string;
  /** Why it cannot take the launch ('' when it can). */
  reason: string;
  /** tmux: this launch's own session already runs there (starting opens it, nothing new). */
  running: boolean;
  remembered: boolean;
}

export function destinationRows(options: LaunchOptions | null): DestinationRow[] {
  const l = m().launch;
  const s = m().launchSheet;
  if (!options)
    return LAUNCH_DESTINATIONS.map((id) => ({
      id,
      label: l.destination[id],
      hint: s.destinationHint[id],
      available: false,
      badge: s.checking,
      reason: '',
      running: false,
      remembered: false,
    }));
  return options.destinations.map(({ id, probe }) => ({
    id,
    label: l.destination[id],
    hint: s.destinationHint[id],
    available: probe.available,
    badge: !probe.available ? s.unavailable : probe.running ? s.runningBadge : s.available,
    reason: probe.available ? '' : (probe.reason ?? ''),
    running: !!probe.running,
    remembered: options.remembered === id,
  }));
}

/**
 * The destination to show chosen: the person's pick while it is still available, else the
 * core's default (a fork: where its original runs; else the remembered one, Orca, tmux).
 */
export function chosenDestination(
  options: LaunchOptions | null,
  picked: LaunchDestinationId | null,
): LaunchDestinationId | null {
  if (!options) return picked;
  const available = (id: LaunchDestinationId | null) =>
    !!id && options.destinations.some((d) => d.id === id && d.probe.available);
  return available(picked) ? picked : options.default;
}

/** The start button's words for a destination. */
export function startLabel(id: LaunchDestinationId, anyway = false): string {
  const s = m().launchSheet;
  if (id === 'copy') return s.startCopy;
  const place = m().launch.destination[id];
  return anyway ? s.forceStart(place) : m().launch.start(place);
}

/** What the sheet offers after a result. */
export type ResultAction =
  | { kind: 'reveal' }
  | { kind: 'go'; go: GoThere }
  | { kind: 'open-terminal' }
  | { kind: 'copy-command'; command: string }
  | { kind: 'suggest'; destination: LaunchDestinationId };

export type ResultView =
  /** Done: close the sheet and say so. */
  | { close: true; toast: string }
  /** Stay: say what happened and offer only these. */
  | { close: false; tone: 'info' | 'error'; text: string; actions: ResultAction[] };

/**
 * What a start's result means for the sheet. `options`: read again after a refusal, so a
 * destination that failed its re-check can suggest the others still available.
 * - launched, copied, opened: done (main already copied a copied command). Except a tmux
 *   start that nothing opened (`open` not offered here, or turned off): it runs out of sight,
 *   so its reconnect controls stay, as the old tmux sheet had them.
 * - running: its tmux session already runs: open it in a terminal (or copy its command).
 * `opens`: the destinations whose own place `open` can bring to the front on this platform.
 * - uncertain: maybe started; only "Open Orca" when it waits in Orca, else the place's hint.
 *   Never another destination: it could start twice.
 * - refused because it runs or is open: go there. Refused otherwise: the other destinations.
 * - cancelled: back to the form (null).
 */
export function resultView(
  result: LaunchResult,
  options: LaunchOptions | null = null,
  opens: readonly LaunchDestinationId[] = OPENS,
): ResultView | null {
  const s = m().launchSheet;
  /** A tmux session runs in the background: the ways back into it. */
  const reconnect = (command?: string): ResultAction[] =>
    result.destination !== 'tmux'
      ? []
      : [
          ...(opens.includes('tmux') ? [{ kind: 'open-terminal' } as const] : []),
          ...(command ? [{ kind: 'copy-command', command } as const] : []),
        ];
  switch (result.state) {
    case 'probed':
    case 'cancelled':
      return null;
    case 'launched': {
      const toast = result.message || s.launched(placeName(result.destination));
      const actions = reconnect(result.command);
      return actions.length
        ? { close: false, tone: 'info', text: toast, actions }
        : { close: true, toast };
    }
    case 'opened':
      return { close: true, toast: result.message || s.launched(placeName(result.destination)) };
    case 'copied':
      return { close: true, toast: result.message || m().launch.copied };
    case 'running':
      return {
        close: false,
        tone: 'info',
        text: result.message || m().launch.tmuxRunning,
        actions: reconnect(result.command),
      };
    case 'uncertain': {
      const where = placeOf(result.destination) ?? 'other';
      return {
        close: false,
        tone: 'info',
        text: result.message || pendingNotice(where),
        actions: where === 'orca' ? [{ kind: 'reveal' }] : [],
      };
    }
    case 'refused': {
      if (result.duplicate && result.duplicate.state !== 'none') {
        const view = duplicateView(result.duplicate, opens, ownTmuxCommand(options));
        return {
          close: false,
          tone: 'error',
          text: result.reason,
          actions: view.reveal ? [{ kind: 'reveal' }] : duplicateActions(view),
        };
      }
      const others = (options?.destinations ?? []).filter(
        (d) => d.id !== result.destination && d.probe.available && !d.probe.running,
      );
      return {
        close: false,
        tone: 'error',
        text: result.reason,
        actions: others.map((d) => ({ kind: 'suggest', destination: d.id })),
      };
    }
  }
}

/**
 * Whether "where" stays on screen under a result: only beside suggestions of other places
 * (with the reasons read again). After an unconfirmed start, a running tmux session or a
 * refusal that points to where it is, the list would read as an offer to start it again.
 */
export const keepsDestinations = (view: ResultView | null) =>
  !view || view.close || view.actions.some((a) => a.kind === 'suggest');

const placeName = (id: LaunchDestinationId) => m().launch.destination[id];

/** The ways to where it already is: going there, and its own tmux session's attach command. */
export const duplicateActions = (view: DuplicateView): ResultAction[] => [
  ...(view.go ? [{ kind: 'go', go: view.go } as const] : []),
  ...(view.copy ? [{ kind: 'copy-command', command: view.copy } as const] : []),
];

/**
 * Whether a result put the conversation somewhere a person can work in it: an away colleague
 * picked from the "+" list then comes back to the office (a copied command opened nothing).
 */
export const broughtUp = (result: LaunchResult) =>
  ['launched', 'uncertain', 'running', 'opened'].includes(result.state);
