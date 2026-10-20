import net from 'node:net';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanInput, TerminalInputError } from './terminals.js';
import { m } from '../src/shared/i18n/index.js';

// Observed Desktop IPC contract, not the public app-server protocol. Versioned requests fail
// closed on incompatible apps. Never start a router, resume a thread, or answer approvals.
const versions = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-read-model-settings': 1,
  'thread-follower-start-turn': 2,
} as const;
const MAX_FRAME = 8 << 20;
type Method = keyof typeof versions;
type Frame = Record<string, any>;
export const remoteCodexHost = (host: string) =>
  /^(?:remote-control|ssh):[A-Za-z0-9._:-]{1,240}$/.test(host);

class DesktopIPC {
  private buffer: Buffer = Buffer.alloc(0);
  private clientId = 'initializing-client';
  private pending = new Map<
    string,
    {
      method: Method;
      resolve: (m: Frame) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private constructor(private socket: net.Socket) {
    socket.on('data', (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE();
          if (!size || size > MAX_FRAME) throw Error('invalid-frame');
          if (this.buffer.length < 4 + size) break;
          const frame = JSON.parse(this.buffer.subarray(4, 4 + size).toString('utf8'));
          this.buffer = this.buffer.subarray(4 + size);
          this.receive(frame);
        }
      } catch {
        this.close();
      }
    });
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }
  static async connect(home: string, timeout: number) {
    const directory = path.join(home, 'ipc');
    const endpoint = path.join(directory, 'ipc.sock');
    const uid = process.getuid?.();
    if (uid === undefined) throw Error('unsupported-platform');
    // Do not repair/chmod an app-owned endpoint or follow a replacement symlink.
    const [dir, file] = await Promise.all([lstat(directory), lstat(endpoint)]);
    if (
      !dir.isDirectory() ||
      !file.isSocket() ||
      dir.uid !== uid ||
      file.uid !== uid ||
      (dir.mode & 0o077) !== 0 ||
      (file.mode & 0o077) !== 0
    )
      throw Error('unsafe-endpoint');
    const ipc = new DesktopIPC(net.createConnection(endpoint));
    try {
      const reply = await ipc.request('initialize', { clientType: 'agent-office' }, timeout);
      if (typeof reply.result?.clientId !== 'string' || !reply.result.clientId)
        throw Error('invalid-initialize');
      ipc.clientId = reply.result.clientId;
      return ipc;
    } catch (e) {
      ipc.close();
      throw e;
    }
  }
  private write(frame: Frame) {
    const payload = Buffer.from(JSON.stringify(frame));
    if (payload.length > MAX_FRAME) throw Error('oversized-request');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([prefix, payload]));
  }
  private receive(frame: Frame) {
    if (!frame || typeof frame !== 'object') throw Error('invalid-frame');
    if (frame.type === 'client-discovery-request' && typeof frame.requestId === 'string') {
      this.write({
        type: 'client-discovery-response',
        requestId: frame.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (frame.type !== 'response') return; // Never claim ownership or process app broadcasts.
    const entry = this.pending.get(frame.requestId);
    if (!entry) return;
    this.pending.delete(frame.requestId);
    clearTimeout(entry.timer);
    if (
      frame.resultType !== 'success' ||
      frame.method !== entry.method ||
      typeof frame.handledByClientId !== 'string'
    )
      entry.reject(Error('desktop-request-failed'));
    else entry.resolve(frame);
  }
  request(
    method: Method,
    params: Frame,
    timeout: number,
    targetClientId?: string,
    hostId?: string,
  ): Promise<Frame> {
    if (this.socket.destroyed) return Promise.reject(Error('disconnected'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Error('timeout'));
      }, timeout);
      this.pending.set(requestId, { method, resolve, reject, timer });
      try {
        this.write({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          method,
          version: versions[method] + (hostId && method.startsWith('thread-follower-') ? 1 : 0),
          ...(hostId ? { hostId } : {}),
          params,
          targetClientId,
          timeoutMs: timeout,
        });
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(Error('write-failed'));
      }
    });
  }
  close() {
    this.socket.destroy();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('disconnected'));
    }
    this.pending.clear();
  }
}

async function owner(ipc: DesktopIPC, threadId: string, timeout: number, hostId?: string) {
  if (hostId !== undefined && !remoteCodexHost(hostId)) throw Error('unsupported-host');
  const discovery = await ipc.request(
    'thread-owner-discovery',
    { hostId: hostId ?? 'local', conversationId: threadId },
    timeout,
  );
  const id = discovery.handledByClientId;
  const reply = await ipc.request(
    'thread-follower-read-model-settings',
    { conversationId: threadId },
    timeout,
    id,
    hostId,
  );
  const settings = reply.result?.settings;
  // Only already resumed, ordinary user conversations. No headless/subagent/cloud admission.
  if (
    reply.handledByClientId !== id ||
    settings?.resumeState !== 'resumed' ||
    settings.mode !== 'default' ||
    settings.threadSource !== 'user'
  )
    throw Error('unsupported-thread');
  return id as string;
}

/** Read-only availability; callers must separately validate rollout origin and identity. */
export async function desktopOwnsThread(
  home: string,
  threadId: string,
  timeout = 1500,
  hostId?: string,
) {
  let ipc: DesktopIPC | undefined;
  try {
    ipc = await DesktopIPC.connect(home, timeout);
    await owner(ipc, threadId, timeout, hostId);
    return true;
  } catch {
    return false;
  } finally {
    ipc?.close();
  }
}

/** Re-discover on the same connection used to send. Never retry an uncertain delivery. */
export async function sendToCodexDesktop(
  home: string,
  threadId: string,
  input: unknown,
  timeout = 15000,
  beforeSend: () => void | Promise<void> = () => {},
  hostId?: string,
) {
  const text = cleanInput(input);
  let ipc: DesktopIPC | undefined;
  let dispatched = false;
  try {
    ipc = await DesktopIPC.connect(home, 1500);
    const targetClientId = await owner(ipc, threadId, hostId ? 5000 : 3000, hostId);
    await beforeSend();
    dispatched = true;
    const reply = await ipc.request(
      'thread-follower-start-turn',
      {
        conversationId: threadId,
        turnStart: {
          request: {
            threadId,
            input: [{ type: 'text', text, text_elements: [] }],
            clientUserMessageId: randomUUID(),
          },
          context: { inheritThreadSettings: true },
        },
      },
      timeout,
      targetClientId,
      hostId,
    );
    if (
      reply.handledByClientId !== targetClientId ||
      typeof reply.result?.result?.turn?.id !== 'string' ||
      !reply.result.result.turn.id
    )
      throw Error('unconfirmed');
    return m().desktop.terminal.codexDesktopSent;
  } catch {
    throw new TerminalInputError(
      dispatched
        ? m().desktop.terminal.codexDesktopUnconfirmed
        : m().desktop.terminal.codexDesktopUnavailable,
    );
  } finally {
    ipc?.close();
  }
}
