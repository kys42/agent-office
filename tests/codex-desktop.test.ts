import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, chmod, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopOwnsThread, sendToCodexDesktop } from '../desktop/codex-desktop.js';
import {
  findCodexDestination,
  codexDestinationTarget,
  sendToCodex,
} from '../desktop/codex-send.js';
import { defaultTerminalDeps } from '../desktop/terminals.js';
import { setLocale } from '../src/shared/i18n/index.js';
setLocale('en');
const THREAD = '11111111-2222-3333-4444-555555555555';
const OWNER = 'desktop-owner';
type Frame = Record<string, any>;
async function fixture(
  options: {
    absent?: boolean;
    mode?: string;
    lost?: boolean;
    malformedAck?: boolean;
    wrongOwner?: boolean;
    oversized?: boolean;
  } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ao-ipc-'));
  const dir = path.join(home, 'ipc');
  await mkdir(dir, { mode: 0o700 });
  const endpoint = path.join(dir, 'ipc.sock');
  const calls: Frame[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    function send(m: Frame) {
      const body = Buffer.from(JSON.stringify(m)),
        prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(body.length);
      // Real framing, including a split length prefix and coalesced JSON payload.
      socket.write(prefix.subarray(0, 2));
      socket.write(Buffer.concat([prefix.subarray(2), body]));
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const n = buffer.readUInt32LE();
        const req = JSON.parse(buffer.subarray(4, 4 + n).toString());
        buffer = buffer.subarray(4 + n);
        calls.push(req);
        if (req.type !== 'request') continue;
        if (options.oversized) {
          const h = Buffer.alloc(4);
          h.writeUInt32LE(0xffffffff);
          socket.write(h);
          continue;
        }
        let result: Frame = {};
        if (req.method === 'initialize') result = { clientId: 'office-client' };
        else if (req.method === 'thread-owner-discovery') {
          if (options.absent) {
            send({
              type: 'response',
              requestId: req.requestId,
              resultType: 'error',
              error: 'no-client-found',
            });
            continue;
          }
          send({
            type: 'client-discovery-request',
            requestId: 'never-own',
            request: { method: 'thread-owner-discovery' },
          });
          result = { supportsUntrustedAppInput: true };
        } else if (req.method === 'thread-follower-read-model-settings') {
          result = {
            settings: {
              resumeState: 'resumed',
              mode: options.mode ?? 'default',
              threadSource: 'user',
            },
          };
        } else if (req.method === 'thread-follower-start-turn') {
          if (options.lost) {
            socket.destroy();
            continue;
          }
          result = options.malformedAck ? {} : { result: { turn: { id: 'synthetic-turn' } } };
        }
        send({
          type: 'response',
          requestId: req.requestId,
          method: req.method,
          resultType: 'success',
          handledByClientId:
            options.wrongOwner && req.method !== 'thread-owner-discovery'
              ? 'different-owner'
              : OWNER,
          result,
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  await chmod(endpoint, 0o600);
  const rollout = path.join(home, 'rollout.jsonl');
  const meta = async (originator = 'Codex Desktop', source: unknown = 'vscode') =>
    writeFile(
      rollout,
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD, originator, source } }) + '\n',
    );
  await meta();
  const deps = {
    ...defaultTerminalDeps(),
    codexHome: home,
    run: async () => {
      throw Error('CLI must not run');
    },
  };
  return {
    home,
    endpoint,
    dir,
    calls,
    rollout,
    meta,
    deps,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('Desktop discovery is read-only; sending targets the fresh owner and inherits settings', async () => {
  const f = await fixture();
  try {
    const destination = await findCodexDestination(THREAD, f.rollout, { deps: f.deps });
    assert.deepEqual(destination, { threadId: THREAD, transport: 'desktop' });
    assert.equal(
      f.calls.some((c) => c.method === 'thread-follower-start-turn'),
      false,
    );
    assert.deepEqual(codexDestinationTarget(destination), {
      kind: 'codex',
      label: 'Codex Desktop',
      status: 'desktop',
      canSend: true,
      canFocus: false,
      desktop: true,
      queues: false,
    });
    assert.match(
      await sendToCodex(destination!, '한글\n--literal $(test)', f.deps),
      /Codex Desktop/,
    );
    const sends = f.calls.filter((c) => c.method === 'thread-follower-start-turn');
    assert.equal(sends.length, 1);
    const send = sends[0];
    assert.equal(send.version, 2);
    assert.equal(send.targetClientId, OWNER);
    assert.equal(send.sourceClientId, 'office-client');
    assert.deepEqual(send.params.turnStart.context, { inheritThreadSettings: true });
    assert.deepEqual(send.params.turnStart.request.input, [
      { type: 'text', text: '한글\n--literal $(test)', text_elements: [] },
    ]);
    assert.equal(send.params.conversationId, THREAD);
    assert.equal(send.params.turnStart.request.threadId, THREAD);
    assert.equal(f.calls.filter((c) => c.method === 'thread-owner-discovery').length, 2);
    assert.ok(
      f.calls.some((c) => c.type === 'client-discovery-response' && c.response.canHandle === false),
    );
  } finally {
    await f.close();
  }
});
for (const option of [
  { absent: true },
  { mode: 'durable' },
  { wrongOwner: true },
  { oversized: true },
]) {
  test(`Unsupported owner/protocol never dispatches: ${JSON.stringify(option)}`, async () => {
    const f = await fixture(option);
    try {
      assert.equal(await desktopOwnsThread(f.home, THREAD, 100), false);
      await assert.rejects(sendToCodexDesktop(f.home, THREAD, 'hello', 100), /Nothing was sent/);
      assert.equal(
        f.calls.some((c) => c.method === 'thread-follower-start-turn'),
        false,
      );
    } finally {
      await f.close();
    }
  });
}
for (const option of [{ lost: true }, { malformedAck: true }]) {
  test(`Uncertain send is never retried: ${JSON.stringify(option)}`, async () => {
    const f = await fixture(option);
    try {
      await assert.rejects(
        sendToCodexDesktop(f.home, THREAD, 'hello', 100),
        /Check the conversation before sending again/,
      );
      assert.equal(f.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
    } finally {
      await f.close();
    }
  });
}
test('Rollout origin, subagents and native ID gate the Desktop transport', async () => {
  const f = await fixture();
  try {
    for (const [origin, source] of [
      ['codex_exec', 'cli'],
      ['Codex Desktop', { subagent: {} }],
    ] as const) {
      await f.meta(origin, source);
      assert.equal(await findCodexDestination(THREAD, f.rollout, { deps: f.deps }), null);
    }
    await f.meta();
    assert.equal(await findCodexDestination('bad-id', f.rollout, { deps: f.deps }), null);
    assert.equal(await findCodexDestination(THREAD, undefined, { deps: f.deps }), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('Insecure directory/socket, missing endpoint, and symlink are never connected', async () => {
  const f = await fixture();
  try {
    await chmod(f.dir, 0o755);
    assert.equal(await desktopOwnsThread(f.home, THREAD), false);
    await chmod(f.dir, 0o700);
    await chmod(f.endpoint, 0o666);
    assert.equal(await desktopOwnsThread(f.home, THREAD), false);
    const alias = path.join(f.home, 'alias');
    await mkdir(alias);
    await symlink(f.dir, path.join(alias, 'ipc'));
    assert.equal(await desktopOwnsThread(alias, THREAD), false);
    assert.equal(await desktopOwnsThread(path.join(f.home, 'absent'), THREAD), false);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('Empty input is rejected before IPC', async () => {
  const f = await fixture();
  try {
    await assert.rejects(sendToCodexDesktop(f.home, THREAD, '  '));
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('Authorization can be revoked during owner discovery; no turn is dispatched', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      sendToCodexDesktop(f.home, THREAD, 'hello', 100, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw Error('revoked');
      }),
      /Nothing was sent/,
    );
    assert.equal(
      f.calls.some((c) => c.method === 'thread-follower-start-turn'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('CLI routing still uses the native queue and never connects to Desktop', async () => {
  const f = await fixture();
  try {
    await f.meta('codex-tui', 'cli');
    await mkdir(path.join(f.home, 'thread-writer-locks'));
    const commands: string[][] = [];
    const deps = {
      ...f.deps,
      run: async (_: string, args: string[]) => {
        commands.push(args);
        if (args[0] === 'queue') return `queued for thread ${THREAD}`;
        return `p42\nccodex\nn${f.home}/thread-writer-locks/${THREAD}.lock`;
      },
    };
    const destination = await findCodexDestination(THREAD, f.rollout, { deps });
    assert.equal(destination?.transport, 'queue');
    await sendToCodex(destination!, 'CLI reply', deps);
    assert.equal(commands.filter((a) => a[0] === 'queue').length, 1);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('Remote Desktop follows the explicit host with versioned envelopes; local is unchanged', async () => {
  const f = await fixture();
  const host = 'remote-control:env_test';
  try {
    assert.equal(await desktopOwnsThread(f.home, THREAD, 1000, host), true);
    await sendToCodexDesktop(f.home, THREAD, 'remote literal', 1000, () => {}, host);
    const discovery = f.calls.find((c) => c.method === 'thread-owner-discovery');
    assert.ok(discovery);
    assert.equal(discovery.version, 1);
    assert.equal(discovery.params.hostId, host);
    assert.equal(discovery.hostId, undefined);
    const read = f.calls.find((c) => c.method === 'thread-follower-read-model-settings');
    assert.ok(read);
    assert.equal(read.version, 2);
    assert.equal(read.hostId, host);
    const send = f.calls.find((c) => c.method === 'thread-follower-start-turn');
    assert.ok(send);
    assert.equal(send.version, 3);
    assert.equal(send.hostId, host);
    assert.equal(send.targetClientId, OWNER);
    assert.equal(f.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
  } finally {
    await f.close();
  }
});

test('Remote unsupported hosts, lost owners and unknown acknowledgements never fall back', async () => {
  for (const option of [{ absent: true }, { wrongOwner: true }, { lost: true }]) {
    const f = await fixture(option);
    try {
      await assert.rejects(
        sendToCodexDesktop(f.home, THREAD, 'hello', 100, () => {}, 'remote-control:env_test'),
      );
      assert.ok(f.calls.filter((c) => c.method === 'thread-follower-start-turn').length <= 1);
      assert.ok(
        f.calls
          .filter((c) => c.method === 'thread-owner-discovery')
          .every((c) => c.params.hostId === 'remote-control:env_test'),
      );
    } finally {
      await f.close();
    }
  }
});
