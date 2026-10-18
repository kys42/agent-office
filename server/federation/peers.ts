import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FederationState, PeerInput } from '../../src/shared/federation.js';
import { parseRemoteId, remoteId } from '../../src/shared/federation.js';
import type { Session, SessionDetail, TerminalTarget, SendResult } from '../../src/shared/types.js';
import {
  peerSchema,
  responseSchema,
  sessionSchema,
  wireId,
  type WireSnapshot,
  type WireSession,
} from './protocol.js';
import { targetResponseSchema, sendResponseSchema } from './command-protocol.js';
import { m } from '../../src/shared/i18n/index.js';
import { peerRequest, PeerError } from './transport.js';

const configSchema = z.object({ enabled: z.boolean(), peers: z.array(peerSchema).max(5) }).strict();
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z.object({ action: z.literal('enable'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('add'), peer: peerSchema }).strict(),
  peerSchema
    .pick({ officeId: true, label: true, tags: true, projects: true })
    .extend({ action: z.literal('update') })
    .strict(),
  z.object({ action: z.literal('remove'), officeId: z.uuid() }).strict(),
]);
interface Held {
  snapshot?: WireSnapshot;
  receivedAt: number | null;
  state: FederationState['peers'][number]['state'];
  error: string | null;
  failures: number;
  commandEpoch?: string;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}
export const linkedProjectKey = (name: string) => `federation-project:${wireId(name)}`;
export function importSession(
  s: WireSession,
  peer: PeerInput,
  receivedAt: number,
  stale: boolean,
  conversation = true,
): Session {
  const id = (value: string) => remoteId(peer.officeId, value);
  const linked = Object.hasOwn(peer.projects, s.project) ? peer.projects[s.project] : undefined;
  return {
    id: id(s.id),
    nativeId: id(s.id),
    provider: s.provider,
    title: s.title,
    alias: '',
    notes: '',
    pinned: false,
    archived: s.zone === 'archive',
    completed: false,
    project: s.project,
    cwd: null,
    model: s.model,
    branch: s.branch,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    observedAt: s.observedAt,
    status: s.status,
    observedStatus: s.status,
    statusEvidence: s.statusEvidence,
    statusReason: 'remote observation',
    action: s.activity?.text ?? '',
    activity: s.activity ? { ...s.activity, eventId: id(s.activity.eventId) } : undefined,
    sourcePath: '',
    sourceKind: 'jsonl',
    sourceVersion: 'office-peer-v1',
    partial: s.partial,
    windowed: s.windowed,
    workspace: {
      key: id(s.workspace.key),
      name: s.workspace.name,
      root: null,
      worktree: s.workspace.worktree ? id(s.workspace.worktree) : null,
      evidence: 'record-path',
    },
    parentId: s.parentId ? id(s.parentId) : null,
    relation: {
      kind: s.relation,
      parentNativeId: s.parentId ? id(s.parentId) : null,
      source: 'office-peer-v1',
    },
    actor: s.actor
      ? { id: id(s.actor.id), name: s.actor.name, source: 'office-peer-v1' }
      : undefined,
    origin: { kind: s.origin, source: 'office-peer-v1' },
    events: s.events.map((e) => ({ ...e, id: id(e.id), sourceRef: '' })),
    usage: s.usage,
    artifacts: [],
    revision: `${s.revision}:${stale}:${conversation}:${wireId(JSON.stringify([peer.label, peer.tags, peer.projects, !!peer.sendToken]))}`,
    zone: s.zone,
    officeSeat: s.officeSeat,
    area: {
      key: linked
        ? linkedProjectKey(linked)
        : `remote-project:${peer.officeId}:${wireId(s.project)}`,
      name: linked ?? s.project,
      ruleId: `remote:${peer.officeId}`,
      match: 'session',
    },
    remote: {
      officeId: peer.officeId,
      sessionId: s.id,
      label: peer.label,
      tags: peer.tags,
      receivedAt,
      stale,
      conversation,
      send: !!peer.sendToken,
    },
  };
}

/** Only peer configuration is persisted. Remote contents stay in bounded process memory. */
export class PeerManager extends EventEmitter {
  private config: z.infer<typeof configSchema> = { enabled: false, peers: [] };
  private held = new Map<string, Held>();
  private generation = 0;
  private details = new Set<AbortController>();
  private closed = false;
  configError: string | null = null;
  constructor(
    private dir: string,
    private request = peerRequest,
  ) {
    super();
    try {
      this.config = configSchema.parse(
        JSON.parse(readFileSync(path.join(dir, 'peers.json'), 'utf8')),
      );
      if (new Set(this.config.peers.map((p) => p.officeId)).size !== this.config.peers.length)
        throw new Error('duplicate');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.configError = 'Invalid beta peer configuration; connections disabled';
      this.config = { enabled: false, peers: [] };
    }
  }
  get enabled() {
    return this.config.enabled;
  }
  start() {
    if (this.enabled && !this.closed)
      for (const peer of this.config.peers) if (!this.held.has(peer.officeId)) this.launch(peer);
  }
  state(): FederationState {
    return {
      enabled: this.enabled,
      error: this.configError,
      peers: this.config.peers.map(({ token: _token, sendToken, ...peer }) => {
        const h = this.held.get(peer.officeId);
        return {
          ...peer,
          canSend: !!sendToken,
          state: h?.state ?? 'offline',
          count: h?.snapshot?.sessions.length ?? 0,
          receivedAt: h?.receivedAt ?? null,
          error: h?.error ?? null,
        };
      }),
    };
  }
  command(raw: unknown): FederationState {
    const command = commandSchema.parse(raw);
    if (command.action === 'state') return this.state();
    const next = structuredClone(this.config);
    if (command.action === 'enable') next.enabled = command.enabled;
    if (command.action === 'remove')
      next.peers = next.peers.filter((p) => p.officeId !== command.officeId);
    if (command.action === 'update')
      next.peers = next.peers.map((p) =>
        p.officeId === command.officeId
          ? { ...p, label: command.label, tags: command.tags, projects: command.projects }
          : p,
      );
    if (command.action === 'add') {
      if (!next.enabled) throw new Error('Enable the beta before adding a peer');
      next.peers = [
        ...next.peers.filter((p) => p.officeId !== command.peer.officeId),
        command.peer,
      ];
    }
    configSchema.parse(next);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, 'peers.json.tmp');
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, path.join(this.dir, 'peers.json'));
    this.cancel();
    this.config = next;
    this.configError = null;
    this.emit('change');
    this.start();
    return this.state();
  }
  private cancel() {
    this.generation++;
    for (const h of this.held.values()) {
      clearTimeout(h.timer);
      h.controller?.abort();
    }
    for (const c of this.details) c.abort();
    this.details.clear();
    this.held.clear();
  }
  close() {
    this.closed = true;
    this.cancel();
  }
  private launch(peer: PeerInput) {
    const h: Held = { state: 'connecting', error: null, receivedAt: null, failures: 0 };
    this.held.set(peer.officeId, h);
    const generation = this.generation;
    const current = () => this.enabled && !this.closed && this.generation === generation;
    const poll = async () => {
      if (!current()) return;
      h.controller = new AbortController();
      try {
        const cursor = h.snapshot ? `?epoch=${h.snapshot.epoch}&version=${h.snapshot.version}` : '';
        const response = responseSchema.parse(
          await this.request(peer, `/office/v1/snapshot${cursor}`, h.controller.signal),
        );
        if (!current()) return;
        if (response.officeId !== peer.officeId)
          throw new PeerError(403, 'Office identity mismatch');
        if ('unchanged' in response) {
          if (
            !h.snapshot ||
            response.epoch !== h.snapshot.epoch ||
            response.version !== h.snapshot.version
          )
            throw new PeerError(409, 'Invalid snapshot cursor');
          h.snapshot = {
            ...h.snapshot,
            sampledAt: response.sampledAt,
            paused: response.paused,
            conversation: response.conversation,
          };
        } else {
          if (h.snapshot?.epoch === response.epoch && response.version < h.snapshot.version)
            throw new PeerError(409, 'Snapshot moved backwards');
          if (new Set(response.sessions.map((s) => s.id)).size !== response.sessions.length)
            throw new PeerError(400, 'Duplicate session identities');
          h.snapshot = response;
        }
        h.state = 'connected';
        h.receivedAt = Date.now();
        h.error = null;
        h.failures = 0;
      } catch (e) {
        if (!current()) return;
        h.failures++;
        const denied = e instanceof PeerError && [401, 403, 404].includes(e.code);
        h.state = denied ? 'rejected' : 'offline';
        h.error = e instanceof PeerError ? e.message : 'Connection or protocol validation failed';
        // Fail closed on invalid responses too; never keep displaying a revoked scope.
        if (
          denied ||
          !(e instanceof PeerError) ||
          (e instanceof PeerError && [400, 409].includes(e.code))
        )
          h.snapshot = undefined;
        if (h.receivedAt && Date.now() - h.receivedAt > 86400_000) h.snapshot = undefined;
      }
      if (!current()) return;
      this.emit('change');
      const delay = h.failures ? Math.min(60000, 5000 * 2 ** Math.min(h.failures - 1, 4)) : 5000;
      h.timer = setTimeout(() => void poll(), delay);
      h.timer.unref();
    };
    void poll();
  }
  sessions(): Session[] {
    if (!this.enabled) return [];
    return this.config.peers.flatMap((p) => {
      const h = this.held.get(p.officeId);
      if (!h?.snapshot || !h.receivedAt) return [];
      const stale =
        h.state !== 'connected' || h.snapshot.paused || Date.now() - h.receivedAt > 15000;
      return h.snapshot.sessions.map((s) =>
        importSession(s, p, h.receivedAt!, stale, h.snapshot!.conversation),
      );
    });
  }
  linkedProjects() {
    return new Set(this.enabled ? this.config.peers.flatMap((p) => Object.values(p.projects)) : []);
  }
  async targets(ids: string[]): Promise<Record<string, TerminalTarget | null>> {
    const result: Record<string, TerminalTarget | null> = Object.fromEntries(
      ids.map((id) => [id, null]),
    );
    if (!this.enabled) return result;
    const generation = this.generation;
    for (const peer of this.config.peers) {
      const held = this.held.get(peer.officeId);
      if (!peer.sendToken || held?.state !== 'connected' || held.snapshot?.paused) continue;
      const selected = ids
        .map((id) => ({ id, ref: parseRemoteId(id) }))
        .filter(
          ({ ref }) =>
            ref.officeId === peer.officeId && held.snapshot?.sessions.some((s) => s.id === ref.id),
        );
      for (let i = 0; i < selected.length; i += 20) {
        const batch = selected.slice(i, i + 20);
        const controller = new AbortController();
        this.details.add(controller);
        try {
          const response = targetResponseSchema.parse(
            await this.request(
              { ...peer, token: peer.sendToken },
              '/office/v1/commands/targets',
              controller.signal,
              { body: { ids: batch.map((x) => x.ref.id) }, timeoutMs: 15000 },
            ),
          );
          if (generation !== this.generation || response.officeId !== peer.officeId) continue;
          held.commandEpoch = response.epoch;
          for (const { id, ref } of batch) {
            const target = response.targets[ref.id];
            if (target)
              result[id] = {
                ...target,
                desktop: target.kind === 'codex' && target.status === 'desktop',
                label: '',
                canFocus: false,
                remoteOffice: peer.label,
              };
          }
        } catch {
          held.commandEpoch = undefined;
        } finally {
          this.details.delete(controller);
        }
      }
    }
    return result;
  }
  async send(
    id: string,
    text: string,
    requestId: string,
    authorized?: () => Promise<void>,
  ): Promise<SendResult> {
    const ref = parseRemoteId(id),
      peer = this.config.peers.find((p) => p.officeId === ref.officeId);
    const held = this.held.get(ref.officeId);
    if (
      !this.enabled ||
      !peer?.sendToken ||
      held?.state !== 'connected' ||
      held.snapshot?.paused ||
      !held.snapshot?.sessions.some((s) => s.id === ref.id)
    )
      throw new Error(m().federation.sendUnavailable);
    const generation = this.generation;
    const target = (await this.targets([id]))[id];
    await authorized?.();
    if (generation !== this.generation || !target?.canSend || !held.commandEpoch)
      throw new Error(m().federation.sendUnavailable);
    const controller = new AbortController();
    this.details.add(controller);
    try {
      const result = sendResponseSchema.parse(
        await this.request(
          { ...peer, token: peer.sendToken },
          '/office/v1/commands/send',
          controller.signal,
          {
            body: { epoch: held.commandEpoch, requestId, id: ref.id, text },
            timeoutMs: 45000,
          },
        ),
      );
      if (
        result.officeId !== peer.officeId ||
        result.requestId !== requestId ||
        result.status !== 'sent'
      )
        throw new Error('uncertain');
      return { status: 'sent', message: m().federation.sent };
    } catch {
      throw new Error(m().federation.sendUncertain);
    } finally {
      this.details.delete(controller);
    }
  }
  async detail(id: string): Promise<SessionDetail> {
    const ref = parseRemoteId(id);
    const peer = this.config.peers.find((p) => p.officeId === ref.officeId);
    const held = this.held.get(ref.officeId);
    if (!this.enabled || !peer || !held?.snapshot?.sessions.some((s) => s.id === ref.id))
      throw new Error('Remote session unavailable');
    if (!held.snapshot.conversation) {
      const summary = this.sessions().find((s) => s.id === id)!;
      return { ...summary, partial: true, olderEvents: false, notices: [] };
    }
    const generation = this.generation;
    const epoch = held.snapshot.epoch;
    const controller = new AbortController();
    this.details.add(controller);
    try {
      const result = z
        .object({ officeId: z.uuid(), session: sessionSchema })
        .strict()
        .parse(await this.request(peer, `/office/v1/detail?id=${ref.id}`, controller.signal));
      if (
        generation !== this.generation ||
        !this.enabled ||
        held.snapshot?.epoch !== epoch ||
        !held.snapshot?.conversation ||
        !held.snapshot.sessions.some((s) => s.id === ref.id) ||
        result.officeId !== ref.officeId ||
        result.session.id !== ref.id
      )
        throw new Error('Remote session changed');
      // Recent bounded conversation only. Older paging is deliberately not advertised.
      return {
        ...importSession(result.session, peer, Date.now(), !!held.snapshot?.paused),
        olderEvents: false,
        notices: [],
      };
    } catch (e) {
      if (
        generation === this.generation &&
        e instanceof PeerError &&
        [401, 403, 404].includes(e.code)
      ) {
        held.snapshot = undefined;
        held.state = 'rejected';
        held.error = e.message;
        this.emit('change');
      }
      throw e;
    } finally {
      this.details.delete(controller);
    }
  }
}
