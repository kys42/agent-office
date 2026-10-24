import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  trustedCodexPipeOwner,
  verifiedWindowsPipe,
  windowsCodexPipe,
  type WindowsPipeOwner,
} from '../desktop/codex-windows-pipe.js';

const location = path.win32.join(
  process.env.ProgramFiles || 'C:\\Program Files',
  'WindowsApps',
  'OpenAI.Codex_test',
);
const trusted: WindowsPipeOwner = {
  processId: 123,
  ownerIsCurrentUser: true,
  executable: path.win32.join(location, 'app', 'ChatGPT.exe'),
  installLocation: location,
  packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0',
  signatureStatus: 'Valid',
  signer: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco',
};
test('Windows pipe requires the current user and the signed, installed Codex package', () => {
  assert.equal(trustedCodexPipeOwner(trusted), true);
  for (const change of [
    { ownerIsCurrentUser: false },
    { ownerIsCurrentUser: 'true' },
    { processId: 0 },
    { packageFamilyName: 'OpenAI.Codex_forged' },
    { signatureStatus: 'NotSigned' },
    { signer: 'CN=Attacker, O=Not OpenAI' },
    { executable: 'C:\\Users\\x\\ChatGPT.exe' },
    { installLocation: 'C:\\Users\\x' },
    { installLocation: location + '\\..\\..\\evil' },
    { installLocation: undefined },
  ])
    assert.equal(trustedCodexPipeOwner({ ...trusted, ...change } as WindowsPipeOwner), false);
});

test('An isolated Codex home cannot reach the real Windows app pipe', () => {
  assert.throws(
    () => windowsCodexPipe(path.join(os.tmpdir(), randomUUID())),
    /unsupported-desktop-home/,
  );
});

async function pipeFixture() {
  const name = `agent-office-test-${randomUUID()}`;
  const sockets = new Set<net.Socket>();
  let received = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      received += chunk.length;
      socket.write(chunk);
    });
  });
  server.listen(`\\\\.\\pipe\\${name}`);
  await once(server, 'listening');
  return {
    name,
    get received() {
      return received;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  'Verified handle relays split/coalesced binary frames and closes with its parent stream',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async () => {
    const f = await pipeFixture();
    let bridge;
    try {
      // Only this synthetic server is admitted; the production function always uses the
      // fixed Codex endpoint and the stricter signed-package validator above.
      bridge = await verifiedWindowsPipe(
        f.name,
        (owner) => owner.processId === process.pid && owner.ownerIsCurrentUser,
      );
      const payload = Buffer.from(JSON.stringify({ input: '한글 $(literal)\n'.repeat(6000) }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(payload.length);
      const frame = Buffer.concat([prefix, payload]);
      const returned = new Promise<Buffer>((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => reject(Error('relay timeout')), 4000);
      bridge!.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= frame.length) {
            clearTimeout(timer);
            resolve(buffer);
          }
        });
        bridge!.once('error', reject);
      });
      bridge.write(frame.subarray(0, 2));
      bridge.write(frame.subarray(2));
      assert.deepEqual(await returned, frame);
      assert.equal(f.received, frame.length);
    } finally {
      bridge?.destroy();
      await f.close();
    }
  },
);

test(
  'Rejected pipe identity receives no protocol bytes',
  { skip: process.platform !== 'win32', timeout: 10000 },
  async () => {
    const f = await pipeFixture();
    try {
      await assert.rejects(
        verifiedWindowsPipe(f.name, () => false),
        /pipe-verification/,
      );
      assert.equal(f.received, 0);
    } finally {
      await f.close();
    }
  },
);
