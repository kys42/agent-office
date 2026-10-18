import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { MobileServer, mobileAddresses, type MobileBackend } from '../server/mobile/server.js';
import { demoSnapshot } from '../src/lib/demo.js';
import type { SendResult } from '../src/shared/types.js';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ao-mobile-'));
  const dir = path.join(root, 'profile'),
    assets = path.join(root, 'dist');
  await mkdir(assets);
  await writeFile(path.join(assets, 'mobile.html'), '<h1>Office</h1>');
  const s = demoSnapshot();
  let sends = 0,
    enabled = true;
  const backend: MobileBackend = {
    snapshot: async () => s,
    detail: async (id) => ({ ...s.sessions.find((a) => a.id === id)!, olderEvents: true }),
    targets: async (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            kind: 'codex',
            label: 'private handle',
            status: 'desktop',
            canSend: true,
            canFocus: false,
            desktop: true,
          },
        ]),
      ),
    sendEnabled: async () => enabled,
    send: async (_id, _text, authorized) => {
      await authorized();
      sends++;
      return { status: 'sent', message: 'ok' } as SendResult;
    },
  };
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  let addresses = ['127.0.0.1'];
  let server = new MobileServer(dir, assets, backend, () => addresses);
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  let cookie = '';
  const post = (route: string, value: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(url + '/mobile/api/' + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: url,
        'X-Agent-Office-Mobile': '1',
        Cookie: cookie,
        ...headers,
      },
      body: JSON.stringify(value),
    });
  const on = () =>
    server.command({ action: 'configure', enabled: true, address: '127.0.0.1', port });
  const login = async () => {
    const r = await post('login', { accessCode: server.state().accessCode });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    return r;
  };
  return {
    root,
    dir,
    s,
    backend,
    post,
    on,
    login,
    url,
    port,
    get server() {
      return server;
    },
    get sends() {
      return sends;
    },
    removeAddress() {
      addresses = [];
    },
    setEnabled(v: boolean) {
      enabled = v;
    },
    async restart() {
      await server.close();
      server = new MobileServer(dir, assets, backend, () => ['127.0.0.1']);
      await server.restore();
    },
  };
}
test('mobile is off by default, creates no config, rejects unsafe interfaces, restores opt-in and stops', async (t) => {
  const f = await fixture(t);
  await f.server.restore();
  assert.equal(f.server.state().enabled, false);
  assert.equal(f.server.state().running, false);
  await assert.rejects(stat(f.dir));
  assert.deepEqual(
    mobileAddresses()
      .filter((a) => a !== '127.0.0.1')
      .every((a) => a.startsWith('100.')),
    true,
  );
  await assert.rejects(
    f.server.command({ action: 'configure', enabled: true, address: '0.0.0.0', port: f.port }),
  );
  const state = await f.on();
  assert.equal(state.running, true);
  assert.equal((await stat(path.join(f.dir, 'mobile-web.json'))).mode & 0o777, 0o600);
  await f.restart();
  assert.equal(f.server.state().running, true);
  await f.server.command({
    action: 'configure',
    enabled: false,
    address: '127.0.0.1',
    port: f.port,
  });
  assert.equal(f.server.state().running, false);
  await assert.rejects(fetch(f.url));
});
test('a custom profile access code survives restart and authenticates exactly', async (t) => {
  const f = await fixture(t);
  await f.on();
  const file = path.join(f.dir, 'mobile-web.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...settings, accessCode: 'Example42!' }));
  await f.restart();
  assert.equal(f.server.state().running, true);
  assert.equal((await f.post('login', { accessCode: settings.accessCode })).status, 401);
  assert.equal((await f.post('login', { accessCode: 'example42!' })).status, 401);
  assert.equal((await f.post('login', { accessCode: 'Example42!' })).status, 200);
});
test('authentication, Host, Origin and route allowlist protect every private API', async (t) => {
  const f = await fixture(t);
  await f.on();
  assert.equal((await f.post('state')).status, 401);
  assert.equal((await f.post('login', { accessCode: 'wrong' })).status, 401);
  assert.equal(
    (
      await f.post(
        'login',
        { accessCode: f.server.state().accessCode },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request(f.url, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHost, 403);
  const response = await f.login();
  assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal((await f.post('state', {}, { 'X-Agent-Office-Mobile': '' })).status, 403);
  assert.equal(
    (await f.post('rpc', { method: 'preferences', args: [{ privacy: false }] })).status,
    404,
  );
  assert.equal((await fetch(f.url + '/mobile-web.json')).status, 404);
  assert.equal((await fetch(f.url)).status, 200);
  assert.match(
    (await fetch(f.url)).headers.get('content-security-policy')!,
    /frame-ancestors 'none'/,
  );
  await f.server.command({ action: 'rotate' });
  assert.equal((await f.post('state')).status, 401);
  await f.login();
  await f.post('logout');
  assert.equal((await f.post('state')).status, 401);
});
test('DTOs omit native paths and handles, respect privacy and project exclusions, and bound detail input', async (t) => {
  const f = await fixture(t);
  await f.on();
  await f.login();
  const agent = f.s.sessions[0];
  agent.sourcePath = '/secret/native-source';
  f.s.sessions.push({ ...agent, id: 'office:manager', builtin: 'manager' });
  const state = await (await f.post('state')).json();
  assert.ok(state.agents.length);
  assert.ok(!state.agents.some((a: { id: string }) => a.id === 'office:manager'));
  assert.equal((await f.post('detail', { id: 'office:manager' })).status, 403);
  assert.equal(
    (await f.post('send', { id: 'office:manager', text: 'move somebody', requestId: randomUUID() }))
      .status,
    403,
  );
  assert.ok(!JSON.stringify(state).includes('/secret'));
  const targets = await (await f.post('targets', { ids: [agent.id] })).json();
  assert.equal(targets[agent.id].canSend, true);
  assert.ok(!JSON.stringify(targets).includes('private handle'));
  const detail = await (await f.post('detail', { id: agent.id })).json();
  assert.equal(detail.older, true);
  assert.ok(!JSON.stringify(detail).includes('sourceRef'));
  assert.equal((await f.post('detail', { id: agent.id, limit: 999999 })).status, 400);
  f.s.preferences.excludedProjects.push(agent.project);
  assert.equal((await f.post('detail', { id: agent.id })).status, 403);
  f.s.preferences.privacy = true;
  assert.deepEqual((await (await f.post('state')).json()).agents, []);
  assert.equal((await f.post('targets', { ids: [agent.id] })).status, 403);
});
test('durable request IDs dispatch once, reject conflicting reuse and never replay uncertain outcomes', async (t) => {
  const f = await fixture(t);
  await f.on();
  await f.login();
  const input = {
    id: f.s.sessions[0].id,
    text: 'unique private mobile instruction',
    requestId: randomUUID(),
  };
  assert.equal((await (await f.post('send', input)).json()).status, 'sent');
  assert.equal((await (await f.post('send', input)).json()).status, 'sent');
  assert.equal(f.sends, 1);
  assert.equal((await f.post('send', { ...input, text: 'other' })).status, 409);
  await f.restart();
  await f.login();
  assert.equal((await (await f.post('send', input)).json()).status, 'sent');
  assert.equal(f.sends, 1);
  assert.equal(
    (await (await f.post('receipt', { requestId: input.requestId })).json()).status,
    'sent',
  );
  assert.ok(
    !(await readFile(path.join(f.dir, 'mobile-commands.sqlite'))).includes(Buffer.from(input.text)),
  );
  let attempts = 0;
  f.backend.send = async () => {
    attempts++;
    throw new Error('private native error');
  };
  const uncertain = { ...input, requestId: randomUUID() };
  assert.equal((await (await f.post('send', uncertain)).json()).status, 'uncertain');
  assert.equal((await (await f.post('send', uncertain)).json()).status, 'uncertain');
  assert.equal(attempts, 1);
  f.setEnabled(false);
  assert.equal((await f.post('send', { ...input, requestId: randomUUID() })).status, 403);
});
test('revoking access during target resolution prevents dispatch and occupied drafts are blocked', async (t) => {
  const f = await fixture(t);
  await f.on();
  await f.login();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r)),
    wait = new Promise<void>((r) => (release = r));
  let dispatched = false;
  f.backend.send = async (_id, _text, authorized) => {
    started();
    await wait;
    await authorized();
    dispatched = true;
    return { status: 'sent', message: 'ok' };
  };
  const input = { id: f.s.sessions[0].id, text: 'hold', requestId: randomUUID() };
  const send = f.post('send', input).catch(() => null);
  await ready;
  await f.server.command({ action: 'rotate' });
  release();
  await send;
  await f.login();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dispatched, false);
  assert.equal(
    (await (await f.post('receipt', { requestId: input.requestId })).json()).status,
    'uncertain',
  );
  f.backend.send = async () => ({
    status: 'needs-confirm',
    draft: 'private terminal text',
    agent: 'Claude',
  });
  const receipt = await (await f.post('send', { ...input, requestId: randomUUID() })).json();
  assert.equal(receipt.status, 'blocked');
  assert.ok(!JSON.stringify(receipt).includes('private terminal'));
});
test('login brute force is bounded', async (t) => {
  const f = await fixture(t);
  await f.on();
  for (let i = 0; i < 20; i++)
    assert.equal((await f.post('login', { accessCode: 'wrong' })).status, 401);
  assert.equal((await f.post('login', { accessCode: 'wrong' })).status, 429);
});

test('disabling a server still works after its interface disappears', async (t) => {
  const f = await fixture(t);
  await f.on();
  f.removeAddress();
  const state = await f.server.command({
    action: 'configure',
    enabled: false,
    address: '127.0.0.1',
    port: f.port,
  });
  assert.equal(state.running, false);
  assert.equal(state.enabled, false);
  assert.equal(
    JSON.parse(await readFile(path.join(f.dir, 'mobile-web.json'), 'utf8')).enabled,
    false,
  );
});
