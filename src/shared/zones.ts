import type { Session, ZoneRule } from './types';
import { nativeProjectKey, projectKey } from './office';

export const ZONE_MATCH_LABELS: Record<ZoneRule['match'], string> = {
  worktree: '같은 워크트리',
  path: '이 폴더 하위',
  branch: '브랜치',
  session: '이 세션만',
};
// Narrower evidence wins, so one session or worktree can be pulled out of a broader rule.
const RANK: Record<ZoneRule['match'], number> = { session: 0, worktree: 1, path: 2, branch: 3 };
const trimSlash = (p: string) => p.replace(/\/+$/, '') || '/';
const within = (child: string | null | undefined, parent: string) => {
  if (!child) return false;
  const c = trimSlash(child),
    p = trimSlash(parent);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
};
export const sessionBranch = (s: Session) => s.branch ?? s.workspace?.git?.branch ?? null;
export const branchMatches = (branch: string | null, pattern: string) =>
  !!branch &&
  (pattern.endsWith('*') ? branch.startsWith(pattern.slice(0, -1)) : branch === pattern);

export function ruleMatches(s: Session, rule: ZoneRule): boolean {
  if (rule.repo && s.workspace?.key !== rule.repo) return false;
  switch (rule.match) {
    case 'session':
      return s.id === rule.value;
    case 'worktree':
      return !!s.workspace?.worktree && trimSlash(s.workspace.worktree) === trimSlash(rule.value);
    case 'path':
      return within(s.cwd, rule.value);
    case 'branch':
      return branchMatches(sessionBranch(s), rule.value);
  }
}
/** Most specific rule wins: session, worktree, deepest folder, then longest branch pattern. */
export function matchZone(s: Session, rules: ZoneRule[] = []): ZoneRule | undefined {
  return rules
    .filter((r) => ruleMatches(s, r))
    .sort((a, b) => RANK[a.match] - RANK[b.match] || b.value.length - a.value.length)[0];
}
export const ruleZoneKey = (r: Pick<ZoneRule, 'name' | 'target'>) => r.target ?? `area:${r.name}`;
export const isCustomZone = (key: string) => key.startsWith('area:');
export function applyZone(s: Session, rules?: ZoneRule[]): Session {
  const rule = matchZone(s, rules);
  // A rule that points back at the session's own project is an override, not an area.
  const own = rule?.target === nativeProjectKey({ ...s, area: undefined });
  return {
    ...s,
    area:
      rule && !own
        ? { key: ruleZoneKey(rule), name: rule.name, ruleId: rule.id, match: rule.match }
        : undefined,
  };
}
export const zoneLabel = (s: Session) => s.area?.name ?? s.project;
/** Scopes the inspector can offer for this session, most useful first. */
export function zoneCandidates(s: Session): Omit<ZoneRule, 'id' | 'name'>[] {
  const repo = s.workspace?.evidence === 'git-common-dir' ? s.workspace.key : undefined;
  const branch = sessionBranch(s);
  const worktree = s.workspace?.worktree;
  return [
    ...(worktree ? [{ match: 'worktree' as const, value: worktree, repo }] : []),
    ...(s.cwd && s.cwd !== worktree ? [{ match: 'path' as const, value: s.cwd, repo }] : []),
    ...(branch ? [{ match: 'branch' as const, value: branch, repo }] : []),
    { match: 'session' as const, value: s.id },
  ];
}

export interface ZoneOption {
  key: string;
  name: string;
  custom: boolean;
  /** Primary colleagues currently seated there. */
  count: number;
}
/** Every zone a colleague could be sent to: custom areas first, then project zones. */
export function zoneOptions(sessions: Session[], rules: ZoneRule[] = []): ZoneOption[] {
  const zones = new Map<string, ZoneOption>();
  for (const r of rules)
    if (!r.target)
      zones.set(ruleZoneKey(r), { key: ruleZoneKey(r), name: r.name, custom: true, count: 0 });
  for (const s of sessions) {
    const key = projectKey(s);
    if (key.startsWith('unknown:')) continue;
    const zone = zones.get(key) ?? {
      key,
      name: zoneLabel(s),
      custom: isCustomZone(key),
      count: 0,
    };
    if (s.zone === 'office' && !s.attachedTo) zone.count++;
    zones.set(key, zone);
  }
  return [...zones.values()].sort(
    (a, b) => Number(b.custom) - Number(a.custom) || a.name.localeCompare(b.name),
  );
}
type Target = Omit<ZoneRule, 'id' | 'name' | 'target'>;
const sameTarget = (a: Target, b: Target) =>
  a.match === b.match && a.value === b.value && (a.repo ?? '') === (b.repo ?? '');
/**
 * Rules after sending `s` (by `scope`) to `zone`. Returning to its own project drops the
 * same-scope rule and only adds an override if a broader rule would still hold it elsewhere.
 */
export function sendToZone(
  s: Session,
  rules: ZoneRule[],
  scope: Target,
  zone: { key: string; name: string },
  id: () => string = () => crypto.randomUUID(),
): ZoneRule[] {
  const native = nativeProjectKey({ ...s, area: undefined });
  const existing = rules.find((r) => sameTarget(r, scope));
  const rest = rules.filter((r) => r !== existing);
  const custom = isCustomZone(zone.key);
  if (zone.key === native) {
    const still = matchZone(s, rest);
    return still && still.target !== native
      ? [...rest, { id: existing?.id ?? id(), name: zone.name, ...scope, target: native }]
      : rest;
  }
  const rule: ZoneRule = {
    id: existing?.id ?? id(),
    name: custom ? zone.key.slice('area:'.length) : zone.name,
    ...scope,
    ...(custom ? {} : { target: zone.key }),
  };
  return existing ? rules.map((r) => (r === existing ? rule : r)) : [...rules, rule];
}
