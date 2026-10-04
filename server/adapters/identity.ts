import path from 'node:path';
import type { Provider, Session, SessionRelation } from '../../src/shared/types.js';
import { readCodexNonUserOrigin } from '../../vendor/orca/runtime/session-scanner-codex-non-user-origin.js';
import { asRecord, extractString } from '../../vendor/orca/runtime/values.js';

type RecordObject = Record<string, any>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Port of Agent Sessions ClaudeSessionParser.detectSubagentInfo (MIT).
// The LAST subagents segment also handles workflows/<workflow>/agent-*.jsonl.
export function claudeSubagentPath(sourcePath: string) {
  const parts = sourcePath.split(/[\\/]/);
  const i = parts.lastIndexOf('subagents');
  if (i < 1 || !uuid.test(parts[i - 1])) return null;
  return {
    parentId: parts[i - 1],
    agentId: parts
      .at(-1)!
      .replace(/\.jsonl$/, '')
      .replace(/^agent-/, ''),
  };
}

export function resolveIdentity(
  raw: RecordObject[],
  opt: {
    provider: Provider;
    sourcePath: string;
    nativeId?: string;
    agentName?: string;
  },
) {
  // Session header wins over filename AND inherited metadata later in a fork.
  // Agent Sessions and Orca both distinguish runtime identity from source paths.
  const ownerRecord =
    opt.provider === 'codex'
      ? raw.find((r) => r.type === 'session_meta' && (asRecord(r.payload) || r.id || r.session_id))
      : opt.provider === 'openclaw'
        ? raw.find((r) => r.type === 'session')
        : undefined;
  const owner = asRecord(ownerRecord?.payload) ?? ownerRecord ?? {};
  const origin = opt.provider === 'codex' ? readCodexNonUserOrigin(owner) : null;
  const child = opt.provider === 'claude' ? claudeSubagentPath(opt.sourcePath) : null;
  const filenameId = path.basename(opt.sourcePath).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1];
  const native =
    opt.nativeId ??
    (child
      ? // Claude agent IDs can be reused under different parents. Scope them to the parent.
        `subagent:${child.parentId}:${extractString(raw.find((r) => r.agentId)?.agentId) ?? child.agentId}`
      : opt.provider === 'claude'
        ? extractString(raw.find((r) => extractString(r.sessionId))?.sessionId)
        : (extractString(owner.id) ??
          extractString(owner.session_id) ??
          extractString(owner.thread_id)));
  const nativeId = native ?? filenameId ?? path.basename(opt.sourcePath, '.jsonl');
  const parentId =
    child?.parentId ??
    origin?.parentage?.parentThreadId ??
    extractString(owner.parent_thread_id) ??
    extractString(owner.forked_from_id);
  const relation: SessionRelation = {
    kind:
      child || origin ? 'subagent' : owner.forked_from_id ? 'fork' : parentId ? 'child' : 'root',
    parentNativeId: parentId,
    source: child
      ? 'Claude subagents path'
      : origin
        ? 'native non-user origin (Orca)'
        : 'native session',
    agentPath: origin?.parentage?.agentPath ?? undefined,
    role: origin?.parentage?.agentRole ?? origin?.kindLabel ?? origin?.kind ?? undefined,
  };
  const identity: NonNullable<Session['identity']> = {
    evidence: opt.nativeId
      ? 'database'
      : child
        ? 'subagent-path'
        : native
          ? 'native-header'
          : 'filename-fallback',
    transportId: filenameId ?? path.basename(opt.sourcePath),
  };
  return {
    nativeId,
    origin: {
      kind:
        origin &&
        (origin.source === 'internal' ||
          ['guardian', 'review', 'compact', 'memory_consolidation'].includes(
            origin.kind ?? origin.threadSource ?? '',
          ))
          ? ('internal' as const)
          : ('unknown' as const),
      source: origin ? 'native non-user origin (Orca)' : 'native session',
      role: origin?.kind ?? undefined,
    },
    owner,
    ownerRecord,
    relation,
    identity,
    title:
      origin?.parentage?.agentNickname ??
      extractString(owner.title) ??
      extractString(owner.thread_name) ??
      extractString(owner.threadName) ??
      extractString(owner.agent_nickname) ??
      origin?.parentage?.agentPath?.split('/').at(-1),
  };
}
