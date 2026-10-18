import { createHash } from 'node:crypto';
import { MANAGER_ID, type ManagerState } from '../../src/shared/manager.js';
import type { OfficeEvent, Session } from '../../src/shared/types.js';
import { canonical } from '../../src/shared/canonical.js';

/** Adapt the owned runner to the same persisted session/event contract as every colleague. */
export function managerSession(state: ManagerState): Session {
  const t = canonical().manager;
  const events: OfficeEvent[] = state.jobs.flatMap((job) => {
    const sourceRef = `manager:${job.id}`;
    const result: OfficeEvent[] = [
      {
        id: `${job.id}:request`,
        kind: 'user',
        at: job.createdAt,
        text: job.kind === 'summary' ? t.summarize : job.text,
        sourceRef,
      },
    ];
    if (job.status === 'running')
      result.push({
        // A public draft becomes the final message in place; it must not survive as a second excerpt.
        id: `${job.id}:answer`,
        kind: 'assistant',
        phase: 'commentary',
        at: job.startedAt ?? job.createdAt,
        text: job.draftAnswer || (job.progress ? t.toolStatus(job.progress) : t.running),
        rich: job.cards,
        sourceRef,
      });
    if (job.finishedAt)
      result.push({
        id: `${job.id}:answer`,
        kind: 'assistant',
        phase: 'final',
        at: job.finishedAt,
        text: job.answer || job.error || t.failed,
        rich: job.cards,
        sourceRef,
      });
    return result;
  });
  const active =
    state.jobs.find((j) => j.status === 'running') ?? state.jobs.find((j) => j.status === 'queued');
  const last = state.jobs.at(-1);
  const updatedAt = Math.max(state.createdAt ?? 1, ...events.map((e) => e.at));
  const status = active
    ? 'work'
    : state.error || last?.status === 'failed'
      ? 'error'
      : state.running
        ? 'ready'
        : 'sleep';
  const reason = state.error || (active ? t.running : state.running ? t.ready : t.stopped);
  const revision = createHash('sha256')
    .update(JSON.stringify([state.settings.provider, state.sessionId, status, reason, events]))
    .digest('hex');
  return {
    id: MANAGER_ID,
    builtin: 'manager',
    nativeId: state.sessionId ?? MANAGER_ID,
    provider: state.settings.provider,
    title: t.title,
    alias: '',
    project: 'Office Manager',
    cwd: null,
    branch: null,
    model: null,
    startedAt: state.createdAt ?? state.jobs[0]?.createdAt ?? 1,
    updatedAt,
    observedAt: updatedAt,
    status,
    observedStatus: status,
    statusEvidence: 'observed',
    statusReason: reason,
    action: reason,
    runtime: {
      phase: active ? 'working' : status === 'error' ? 'error' : 'quiet',
      at: updatedAt,
      evidence: 'observed',
      reason,
    },
    sourcePath: 'office:manager',
    sourceKind: 'internal',
    sourceVersion: '1',
    partial: false,
    archived: false,
    pinned: true,
    parentId: null,
    workspace: {
      key: 'office:manager-project',
      name: t.title,
      root: null,
      worktree: null,
      evidence: 'record-path',
    },
    usage: {
      input: 0,
      output: 0,
      cached: 0,
      total: 0,
      contextUsed: 0,
      contextWindow: 0,
      scope: 'session',
      source: canonical().server.session.usageNotCollected,
    },
    events,
    artifacts: [],
    notes: '',
    revision,
    completed: false,
  };
}
