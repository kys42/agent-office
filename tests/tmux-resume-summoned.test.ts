import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TmuxResume, summonSession, type ResumeDeps } from '../desktop/tmux-resume.js';

/**
 * A summoned agent keeps its summon's tmux session after the office knows its conversation by
 * id: status, resume, open and the duplicate check (which reads `status`) find that session.
 */
const cwd = '/projects/psp';
const SOCKET = '/private/tmp/tmux-501/test-office';

interface Pane {
  id: string;
  dead: boolean;
  argv: string[];
}
/** An in-memory dedicated tmux server: sessions, their options and panes. */
function fakeTmux() {
  const sessions = new Map<string, { options: Record<string, string>; panes: Pane[] }>();
  const launches: string[][] = [];
  const opened: string[] = [];
  let panes = 0;
  const sessionOf = (target: string) => {
    for (const [name, s] of sessions)
      if (name === target || s.panes.some((p) => p.id === target)) return [name, s] as const;
    throw new Error("can't find session: " + target);
  };
  const render = (format: string, name: string) =>
    format.replace(/#\{([@\w]+)\}/g, (_, key: string) =>
      key === 'session_name'
        ? name
        : key === 'socket_path'
          ? SOCKET
          : (sessions.get(name)!.options[key] ?? ''),
    );
  const command = (words: string[]) => {
    const [verb, ...rest] = words;
    const flag = (f: string) => rest[rest.indexOf(f) + 1];
    if (verb === 'list-sessions') {
      if (!sessions.size) throw new Error('no server running on ' + SOCKET);
      return [...sessions.keys()].map((name) => render(flag('-F'), name)).join('\n') + '\n';
    }
    if (verb === 'list-panes') {
      const [, s] = sessionOf(flag('-t'));
      return s.panes.map((p) => `${p.id}\t${p.dead ? 1 : 0}`).join('\n') + '\n';
    }
    if (verb === 'display-message') return render(rest.at(-1)!, sessionOf(flag('-t'))[0]) + '\n';
    if (verb === 'set-option') {
      const [key, value] = rest.slice(-2);
      sessionOf(flag('-t'))[1].options[key] = value;
      return '';
    }
    if (verb === 'new-session') {
      const argv = rest.slice(rest.indexOf('-c') + 2);
      launches.push(argv);
      sessions.set(flag('-s'), { options: {}, panes: [{ id: `%${panes++}`, dead: false, argv }] });
      return '';
    }
    if (verb === 'respawn-pane') {
      const pane = sessionOf(flag('-t'))[1].panes.find((p) => p.id === flag('-t'))!;
      pane.argv = rest.slice(rest.indexOf('-c') + 2);
      pane.dead = false;
      launches.push(pane.argv);
      return '';
    }
    throw new Error('unexpected tmux command ' + verb);
  };
  const deps: ResumeDeps = {
    platform: 'darwin',
    server: 'test-office',
    binary: async (name) => '/bin/' + name,
    directory: async () => true,
    run: async (file, args) => {
      if (file === '/usr/bin/osascript') {
        opened.push(args.at(-1)!);
        return '';
      }
      assert.equal(file, '/bin/tmux');
      assert.deepEqual(args.slice(0, 2), ['-L', 'test-office'], 'only the dedicated server');
      let words = args.slice(2);
      if (words[0] === '-f') words = words.slice(2);
      const commands: string[][] = [[]];
      for (const word of words) word === ';' ? commands.push([]) : commands.at(-1)!.push(word);
      let out = '';
      for (const c of commands) out = command(c) || out;
      return out;
    },
  };
  return { deps, sessions, launches, opened, manager: new TmuxResume(deps) };
}
const agentArgs = (argv: string[], provider: string) =>
  argv.slice(argv.indexOf('/bin/' + provider) + 1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('a Claude summon chooses its conversation id up front and records it on the session', async () => {
  const f = fakeTmux();
  const info = await f.manager.start(
    summonSession(cwd, 'claude', 'psp_pm', 'hi'),
    async () => true,
  );
  const args = agentArgs(f.launches[0], 'claude');
  assert.equal(args[0], '--session-id');
  assert.match(args[1], UUID);
  assert.deepEqual(args.slice(2), ['--', 'hi']);
  assert.equal(f.sessions.get(info.name)!.options['@agent_office_native'], 'claude:' + args[1]);

  // Once the office knows the conversation by that id, it is the same running session.
  const conversation = { provider: 'claude' as const, nativeId: args[1], cwd };
  const found = await f.manager.status(conversation);
  assert.equal(found.running, true);
  assert.equal(found.name, info.name);
  assert.match(found.command, /attach-session -t '=psp_pm-claude-[0-9a-f]{8}'$/);
  assert.equal(
    (
      await f.manager.start(conversation, async () => {
        throw new Error('a running summon must not be launched again');
      })
    ).name,
    info.name,
  );
  assert.equal(f.launches.length, 1);
  await f.manager.open(conversation);
  assert.deepEqual(f.opened, [found.command]);
  // Every new summon (also a respawn of its ended pane) gets a new id.
  f.sessions.get(info.name)!.panes[0].dead = true;
  await f.manager.start(summonSession(cwd, 'claude', 'psp_pm'), async () => true);
  const again = agentArgs(f.launches[1], 'claude');
  assert.notEqual(again[1], args[1]);
  assert.equal(f.sessions.get(info.name)!.options['@agent_office_native'], 'claude:' + again[1]);
});

test('Codex summons carry no id until adoption; the tag is cleared on a fresh respawn', async () => {
  const f = fakeTmux();
  const info = await f.manager.start(summonSession(cwd, 'codex', 'rev'), async () => true);
  assert.deepEqual(agentArgs(f.launches[0], 'codex'), []);
  assert.equal(f.sessions.get(info.name)!.options['@agent_office_native'], '');
  const pane = f.sessions.get(info.name)!.panes[0].id;
  const thread = '019a0000-1111-7222-8333-444455556666';
  const host = { kind: 'tmux' as const, socket: SOCKET, pane, label: info.name + ':0.0' };
  assert.equal(
    (await f.manager.status({ provider: 'codex', nativeId: thread, cwd })).running,
    false,
  );
  assert.equal(await f.manager.adopt(host, 'codex', thread), true);
  const found = await f.manager.status({ provider: 'codex', nativeId: thread, cwd });
  assert.equal(found.running, true);
  assert.equal(found.name, info.name);
  f.sessions.get(info.name)!.panes[0].dead = true;
  await f.manager.start(summonSession(cwd, 'codex', 'rev'), async () => true);
  assert.equal(f.sessions.get(info.name)!.options['@agent_office_native'], '');
});

test('resuming a summoned conversation whose agent ended respawns it in place, keeping its name', async () => {
  const f = fakeTmux();
  const info = await f.manager.start(summonSession(cwd, 'claude', 'psp pm'), async () => true);
  const id = agentArgs(f.launches[0], 'claude')[1];
  const session = f.sessions.get(info.name)!;
  const { '@agent_office_resume': token, '@agent_office_alias': alias } = session.options;
  session.panes[0].dead = true;
  const conversation = { provider: 'claude' as const, nativeId: id, cwd };
  const before = await f.manager.status(conversation);
  assert.equal(before.running, false);
  assert.equal(before.name, info.name);
  const after = await f.manager.start(conversation, async () => true);
  assert.equal(after.running, true);
  assert.equal(after.name, info.name);
  assert.equal(f.sessions.size, 1, 'no second session for the same conversation');
  assert.deepEqual(agentArgs(f.launches[1], 'claude'), ['--resume', id]);
  assert.equal(session.options['@agent_office_resume'], token);
  assert.equal(session.options['@agent_office_alias'], alias);
  assert.equal(session.options['@agent_office_native'], 'claude:' + id);
});

test('a tag on a session that is not exactly one of our summons is ignored', async () => {
  const f = fakeTmux();
  const info = await f.manager.start(summonSession(cwd, 'claude', 'psp_pm'), async () => true);
  const options = f.sessions.get(info.name)!.options;
  const conversation = { provider: 'claude' as const, nativeId: 'abc-123', cwd };
  options['@agent_office_native'] = 'claude:abc-123';
  assert.equal((await f.manager.status(conversation)).running, true);
  for (const [key, value] of [
    ['@agent_office_resume', 'f'.repeat(64)],
    ['@agent_office_alias', Buffer.from('other').toString('base64')],
    ['@agent_office_cwd', Buffer.from('/elsewhere').toString('base64')],
  ]) {
    const saved = options[key];
    options[key] = value;
    const status = await f.manager.status(conversation);
    assert.equal(status.running, false, key);
    assert.match(status.name, /^office-claude-/);
    options[key] = saved;
  }
  // Another agent's conversation with the same id is not this one.
  assert.equal((await f.manager.status({ ...conversation, provider: 'codex' })).running, false);
});

test('adoption tags only an owned summon pane of our server, and only when it changed', async () => {
  const f = fakeTmux();
  const info = await f.manager.start(summonSession(cwd, 'claude', 'psp_pm'), async () => true);
  const resume = await f.manager.start(
    { provider: 'claude', nativeId: 'resumed-1', cwd },
    async () => true,
  );
  const pane = (name: string) => f.sessions.get(name)!.panes[0].id;
  const host = { kind: 'tmux' as const, socket: SOCKET, pane: pane(info.name), label: '' };
  assert.equal(await f.manager.adopt({ ...host, socket: '/tmp/other' }, 'claude', 'x-1'), false);
  assert.equal(await f.manager.adopt({ ...host, pane: pane(resume.name) }, 'claude', 'x-1'), false);
  assert.equal(await f.manager.adopt(host, 'codex', 'x-1'), false, 'a Claude summon');
  assert.equal(await f.manager.adopt(host, 'claude', '--last'), false);
  assert.equal(
    await f.manager.adopt({ kind: 'orca', handle: 'term_1', title: '' }, 'claude', 'x-1'),
    false,
  );
  // A summon made before the tag existed (or after `/clear`) is tagged with what it runs now.
  assert.equal(await f.manager.adopt(host, 'claude', 'x-1'), true);
  assert.equal(f.sessions.get(info.name)!.options['@agent_office_native'], 'claude:x-1');
  const run = f.deps.run;
  f.deps.run = async (file, args, options) => {
    assert.ok(!args.includes('set-option'), 'an unchanged tag is not written again');
    return run(file, args, options);
  };
  assert.equal(await f.manager.adopt(host, 'claude', 'x-1'), true);
  assert.equal(
    (await f.manager.status({ provider: 'claude', nativeId: 'x-1', cwd })).name,
    info.name,
  );
});

test('the exact resume session wins over a tagged summon; a live one over an ended one', async () => {
  const f = fakeTmux();
  const conversation = { provider: 'claude' as const, nativeId: 'conv-1', cwd };
  const own = await f.manager.start(conversation, async () => true);
  const summon = await f.manager.start(summonSession(cwd, 'claude', 'psp_pm'), async () => true);
  f.sessions.get(summon.name)!.options['@agent_office_native'] = 'claude:conv-1';
  assert.equal((await f.manager.status(conversation)).name, own.name);
  f.sessions.get(own.name)!.panes[0].dead = true;
  assert.equal((await f.manager.status(conversation)).name, summon.name);
  f.sessions.get(summon.name)!.panes[0].dead = true;
  const ended = await f.manager.status(conversation);
  assert.equal(ended.name, own.name);
  assert.equal(ended.running, false);
});
