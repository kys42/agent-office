import type { TerminalTarget } from './types';

/** Navigation describes the screen, independently of where follow-ups are delivered. */
export function focusLocation(target: TerminalTarget) {
  return (
    target.focus ??
    (target.kind === 'codex'
      ? null
      : {
          kind: target.kind,
          label: target.label,
        })
  );
}

export function focusName(target: TerminalTarget): string {
  const focus = focusLocation(target);
  return focus?.kind === 'orca' ? 'Orca' : focus?.kind === 'tmux' ? 'tmux' : '';
}

export function focusLine(target: TerminalTarget, privacy: boolean): string {
  const name = focusName(target);
  const label = focusLocation(target)?.label;
  return privacy || !label ? name : `${name} · ${label}`;
}
