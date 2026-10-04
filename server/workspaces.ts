import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Session, WorkspaceIdentity } from '../src/shared/types.js';
const exec = promisify(execFile);
const cache = new Map<string, { expires: number; value: Promise<WorkspaceIdentity> }>();
export async function resolveWorkspace(
  cwd: string | null,
  fallback: string,
): Promise<WorkspaceIdentity> {
  if (!cwd || !path.isAbsolute(cwd))
    return {
      key: `unknown:${fallback}`,
      name: fallback,
      root: null,
      worktree: null,
      evidence: 'unknown',
    };
  const existing = cache.get(cwd);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = (async (): Promise<WorkspaceIdentity> => {
    const canonical = await realpath(cwd).catch(() => path.normalize(cwd));
    try {
      const { stdout } = await exec(
        'git',
        [
          '-C',
          canonical,
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-common-dir',
        ],
        { timeout: 1800, maxBuffer: 8192, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      );
      const [worktree, common] = stdout.trim().split('\n');
      if (!path.isAbsolute(worktree) || !path.isAbsolute(common))
        throw new Error('unsupported git result');
      const key = await realpath(common).catch(() => common);
      const root = path.basename(key) === '.git' ? path.dirname(key) : worktree;
      const options = {
        timeout: 1800,
        maxBuffer: 8192,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      };
      const [branchResult, commitResult] = await Promise.allSettled([
        exec('git', ['-C', canonical, 'symbolic-ref', '--short', '-q', 'HEAD'], options),
        exec('git', ['-C', canonical, 'rev-parse', '--verify', 'HEAD'], options),
      ]);
      const branch =
        branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() || null : null;
      const commit =
        commitResult.status === 'fulfilled' ? commitResult.value.stdout.trim() || null : null;
      return {
        key: `git:${key}`,
        name: path.basename(root),
        root,
        worktree,
        evidence: 'git-common-dir',
        git: {
          branch,
          commit,
          state: branch ? (commit ? 'branch' : 'unborn') : commit ? 'detached' : 'unavailable',
          observedAt: Date.now(),
        },
      };
    } catch {
      return {
        key: `path:${canonical}`,
        name: path.basename(canonical),
        root: canonical,
        worktree: canonical,
        evidence: 'record-path',
      };
    }
  })();
  cache.set(cwd, { expires: Date.now() + 15_000, value });
  if (cache.size > 1500) cache.delete(cache.keys().next().value!);
  return value;
}
export async function enrichWorkspaces(sessions: Session[]) {
  // Bounded concurrency; never fetch remotes or reinterpret recorded branch as current HEAD.
  const result: Session[] = [];
  for (let i = 0; i < sessions.length; i += 8)
    result.push(
      ...(await Promise.all(
        sessions.slice(i, i + 8).map(async (s) => {
          const workspace = await resolveWorkspace(s.cwd, `${s.provider}:${s.project}`);
          return {
            ...s,
            workspace,
            project: workspace.evidence === 'unknown' ? s.project : workspace.name,
          };
        }),
      )),
    );
  return result;
}
