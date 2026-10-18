import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Session } from '../../src/shared/types.js';
import { parentSession } from '../../src/shared/office.js';

export const MAX_BYTES = 16 * 1024 * 1024;
export const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(4000);
const time = z.number().finite().nonnegative();
const nullableText = text.nullable();
export const wireId = (id: string) => createHash('sha256').update(id).digest('hex');
export const eventSchema = z
  .object({
    id: idSchema,
    at: time,
    kind: z.enum(['user', 'assistant', 'tool', 'result', 'lifecycle']),
    text: z.string().max(64000),
    excerpt: z.boolean(),
    tool: z.string().max(200).optional(),
    phase: z.enum(['commentary', 'final']).optional(),
  })
  .strict();
export const sessionSchema = z
  .object({
    id: idSchema,
    provider: z.enum(['claude', 'codex', 'openclaw']),
    title: text,
    project: text,
    model: nullableText,
    branch: nullableText,
    startedAt: time,
    updatedAt: time,
    observedAt: time,
    status: z.enum(['work', 'think', 'call', 'error', 'done', 'ready', 'idle', 'sleep', 'leave']),
    statusEvidence: z.enum(['observed', 'derived']),
    partial: z.boolean(),
    windowed: z.boolean(),
    workspace: z.object({ key: idSchema, name: text, worktree: idSchema.nullable() }).strict(),
    parentId: idSchema.nullable(),
    relation: z.enum(['root', 'subagent', 'fork', 'child', 'unknown']),
    actor: z.object({ id: idSchema, name: text }).strict().nullable(),
    origin: z.enum(['interactive', 'scheduled', 'internal', 'unknown']),
    events: z.array(eventSchema).max(180),
    activity: z
      .object({
        text: z.string().max(220),
        at: time,
        eventId: idSchema,
        kind: z.enum(['request', 'progress', 'reply', 'status']),
      })
      .strict()
      .nullable(),
    usage: z
      .object({
        input: time.nullable(),
        output: time.nullable(),
        cached: time.nullable(),
        total: time.nullable(),
        contextUsed: time.nullable(),
        contextWindow: time.nullable(),
        scope: z.enum(['session', 'sample']),
        source: text,
      })
      .strict(),
    revision: idSchema,
    zone: z.enum(['office', 'waiting', 'archive']),
    officeSeat: time.optional(),
  })
  .strict();
export type WireSession = z.infer<typeof sessionSchema>;
export const snapshotSchema = z
  .object({
    protocol: z.literal(1),
    officeId: z.uuid(),
    epoch: z.uuid(),
    version: z.number().int().nonnegative(),
    sampledAt: time,
    paused: z.boolean(),
    conversation: z.boolean(),
    sessions: z.array(sessionSchema).max(900),
  })
  .strict();
export type WireSnapshot = z.infer<typeof snapshotSchema>;
export const responseSchema = z.union([
  snapshotSchema,
  z
    .object({
      unchanged: z.literal(true),
      officeId: z.uuid(),
      epoch: z.uuid(),
      version: z.number().int().nonnegative(),
      sampledAt: time,
      paused: z.boolean(),
      conversation: z.boolean(),
    })
    .strict(),
]);
export const exportConfigSchema = z
  .object({
    enabled: z.boolean(),
    officeId: z.uuid(),
    host: z.string().min(1).max(253),
    port: z.number().int().min(0).max(65535),
    token: z.string().min(32).max(256),
    projects: z.array(z.string().max(4000)).max(100),
    conversation: z.boolean(),
    allowSend: z.boolean().default(false),
    sendToken: z.string().min(32).max(256).optional(),
    profileDir: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (c) => !c.sendToken || c.sendToken !== c.token,
    'Read and send credentials must be different',
  )
  .refine(
    (c) => !c.allowSend || !!c.profileDir,
    'Sending requires the owning desktop profile directory',
  );
export type ExportConfig = z.infer<typeof exportConfigSchema>;
export const peerSchema = z
  .object({
    officeId: z.uuid(),
    endpoint: z
      .string()
      .url()
      .max(1000)
      .refine((value) => {
        const u = new URL(value);
        return (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname === '/'
        );
      }, 'Use an HTTPS origin without a path or credentials'),
    fingerprint: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((s) => s.toLowerCase()),
    token: z.string().min(32).max(256),
    sendToken: z.string().min(32).max(256).optional(),
    label: z.string().trim().min(1).max(80),
    tags: z.array(z.string().trim().min(1).max(40)).max(12),
    projects: z
      .record(z.string().max(4000), z.string().min(1).max(4000))
      .refine((p) => Object.keys(p).length <= 100),
  })
  .strict();

/** Allowlist, never a spread of a stored Session. Paths/personal settings do not cross. */
export function exportSession(s: Session, peers: Session[], detail = false): WireSession {
  const parent = parentSession(s, peers);
  const limit = detail ? 180 : 4;
  const eventLimit = detail ? 64000 : 2000;
  const activityKinds = ['request', 'progress', 'reply', 'status'];
  // Summary synchronization carries what people said, not tool payloads.
  const events = detail
    ? s.events
    : s.events.filter((e) => e.kind === 'user' || e.kind === 'assistant');
  return sessionSchema.parse({
    id: wireId(s.id),
    provider: s.provider,
    title: s.title.slice(0, 4000),
    project: s.project.slice(0, 4000),
    model: s.model,
    branch: s.branch,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    observedAt: s.observedAt,
    status: s.status,
    statusEvidence: s.statusEvidence,
    partial:
      s.partial ||
      (detail && (s.events.length > limit || s.events.some((e) => e.text.length > eventLimit))),
    windowed: !!s.windowed,
    workspace: {
      key: wireId(s.workspace?.key ?? s.cwd ?? s.id),
      name: (s.workspace?.name ?? s.project).slice(0, 4000),
      worktree: s.workspace?.worktree ? wireId(s.workspace.worktree) : null,
    },
    parentId: parent ? wireId(parent.id) : null,
    relation: s.relation?.kind ?? 'root',
    actor: s.actor ? { id: wireId(s.actor.id), name: s.actor.name.slice(0, 4000) } : null,
    origin: s.origin?.kind ?? 'unknown',
    events: events.slice(-limit).map((e) => ({
      id: wireId(e.id),
      at: e.at,
      kind: e.kind,
      text: e.text.slice(0, eventLimit),
      excerpt: !detail || !!e.excerpt || e.text.length > eventLimit,
      ...(e.tool ? { tool: e.tool.slice(0, 200) } : {}),
      ...(e.phase ? { phase: e.phase } : {}),
    })),
    activity:
      s.activity && activityKinds.includes(s.activity.kind)
        ? {
            text: s.activity.text.slice(0, 220),
            at: s.activity.at,
            eventId: wireId(s.activity.eventId ?? s.id),
            kind: s.activity.kind,
          }
        : null,
    usage: {
      input: s.usage.input,
      output: s.usage.output,
      cached: s.usage.cached,
      total: s.usage.total,
      contextUsed: s.usage.contextUsed,
      contextWindow: s.usage.contextWindow,
      scope: s.usage.scope,
      source: 'remote observation',
    },
    revision: wireId(s.revision),
    zone: s.zone ?? 'office',
    officeSeat: s.officeSeat,
  });
}
