import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeCodeTabs,
  codexTabs,
  findOrcaTab,
  matchOrcaTab,
  orcaTabTarget,
  orcaTabsFor,
} from '../desktop/orca-tabs.js';
import type { TerminalHostDeps } from '../desktop/terminal-host.js';

const CWD = '/projects/office';
const CODEX_ID = '01a15d10-2a38-75b3-af5d-e7e6b1234567';
const claude = {
  provider: 'claude' as const,
  nativeId: '4f1c2a3b-0000-4000-8000-000000000001',
  cwd: CWD,
  title: '기능 담당',
  nativeTitle: true,
};
const codex = { provider: 'codex' as const, nativeId: CODEX_ID, cwd: CWD, title: 'whatever' };

/** Fabricated `orca terminal list --json` rows (field shapes as Orca 1.4.216 prints them). */
const row = (over: Record<string, unknown> = {}) => ({
  handle: 'term_11111111-1111-4111-8111-111111111111',
  ptyId: 'repo::/projects/office@@aaaa',
  orphaned: false,
  worktreeId: 'repo::/projects/office',
  worktreePath: CWD,
  tabId: 'tab-1',
  title: '✳ 기능 담당',
  connected: true,
  writable: true,
  lastOutputAt: null,
  executionHostId: 'local',
  preview: 'never read by the matcher',
  ...over,
});

test('exactly one tab in the same folder whose title names the conversation is a jump target', () => {
  const tab = matchOrcaTab(
    [row(), row({ handle: 'term_other', title: 'Terminal 3', tabId: 'tab-2' })],
    claude,
  );
  assert.deepEqual(tab, {
    kind: 'orca',
    handle: 'term_11111111-1111-4111-8111-111111111111',
    title: '✳ 기능 담당',
  });
  const target = orcaTabTarget(tab!);
  // Jump only: never typed into.
  assert.equal(target.canSend, false);
  assert.equal(target.canFocus, true);
  assert.equal(target.tabOnly, true);
  assert.deepEqual(target.focus, { kind: 'orca', label: '✳ 기능 담당' });
  assert.equal(JSON.stringify(target).includes('term_'), false);
});

test('two matching tabs are ambiguous: no fallback', () => {
  assert.equal(matchOrcaTab([row(), row({ handle: 'term_two', tabId: 'tab-2' })], claude), null);
  assert.equal(matchOrcaTab([], claude), null);
});

test('another folder, a subfolder or a remote host never matches', () => {
  assert.equal(matchOrcaTab([row({ worktreePath: '/projects/other' })], claude), null);
  assert.equal(matchOrcaTab([row({ worktreePath: '/projects' })], claude), null);
  assert.equal(matchOrcaTab([row({ worktreePath: 'projects/office' })], claude), null);
  assert.equal(matchOrcaTab([row({ executionHostId: 'ssh-box' })], claude), null);
  assert.equal(matchOrcaTab([row()], { ...claude, cwd: null }), null);
  // Trailing slash and `..` resolve to the same folder.
  assert.ok(matchOrcaTab([row({ worktreePath: '/projects/x/../office/' })], claude));
});

test('connected=false (sleeping, restored) still counts; orphaned or tab-less does not', () => {
  assert.ok(matchOrcaTab([row({ connected: false, writable: false })], claude));
  assert.equal(matchOrcaTab([row({ orphaned: true })], claude), null);
  assert.equal(matchOrcaTab([row({ tabId: undefined })], claude), null);
  // An orphaned duplicate does not make a single attached tab ambiguous.
  assert.ok(matchOrcaTab([row(), row({ handle: 'term_ghost', orphaned: true })], claude));
});

test('a tab Orca marks as another agent is skipped; malformed handles are ignored', () => {
  assert.equal(matchOrcaTab([row({ agentIdentity: 'codex' })], claude), null);
  assert.ok(matchOrcaTab([row({ agentIdentity: 'claude' })], claude));
  assert.equal(matchOrcaTab([row({ handle: 'term_bad handle' })], claude), null);
  assert.equal(matchOrcaTab([row({ handle: 42 })], claude), null);
});

test('Claude: the ✳ mark (or a spinner frame) and Claude’s own title are both required', () => {
  const names = (title: string, s = claude) => claudeCodeTabs.names(title, s);
  assert.equal(names('✳ 기능 담당'), true);
  assert.equal(names('⠂ 기능 담당'), true);
  assert.equal(names('[ ! ] Action Required | ✳ 기능 담당'), true);
  assert.equal(names('기능 담당'), false);
  assert.equal(names('✳ 기능 담당 2'), false);
  assert.equal(names('✳ 기능'), false);
  // A title made from the first prompt is no evidence of what Claude shows.
  assert.equal(names('✳ 기능 담당', { ...claude, nativeTitle: false }), false);
  assert.equal(names('✳ Claude Code', { ...claude, title: 'Claude Code' }), false);
});

test('Codex: the thread id first, full or as Codex’s 32-character abbreviation', () => {
  const names = (title: string) => codexTabs.names(title, codex);
  assert.equal(names(`${CODEX_ID} | agent`), true);
  assert.equal(names(`${CODEX_ID.slice(0, 29)}... | agent`), true);
  assert.equal(names(`[ ! ] Action Required | ${CODEX_ID.slice(0, 29)}...`), true);
  assert.equal(names(`01a15d10-2a38-75b3-af5d-ffffffffffff | agent`), false);
  assert.equal(names(`agent | ${CODEX_ID}`), false);
  assert.ok(matchOrcaTab([row({ title: `${CODEX_ID.slice(0, 29)}... | agent` })], codex));
  // A Claude-titled tab is no Codex evidence, and vice versa.
  assert.equal(matchOrcaTab([row()], codex), null);
});

test('agents without an adapter never get a fallback', () => {
  assert.equal(orcaTabsFor('openclaw'), null);
  assert.equal(matchOrcaTab([row()], { ...claude, provider: 'openclaw' }), null);
});

test('the lookup lists Orca once per 5 s (shared cache) and only reads', async () => {
  const calls: string[][] = [];
  const deps: TerminalHostDeps = {
    bin: (name) => `/bin/${name}`,
    run: async (_file, args) => {
      calls.push(args);
      return JSON.stringify({ ok: true, result: { terminals: [row()] } });
    },
  };
  assert.ok(await findOrcaTab(claude, deps));
  assert.ok(await findOrcaTab(claude, deps));
  assert.deepEqual(calls, [['terminal', 'list', '--json']]);
  assert.ok(await findOrcaTab(claude, deps, true));
  assert.equal(calls.length, 2);
  assert.equal(await findOrcaTab({ ...claude, provider: 'openclaw' }, deps), null);
  assert.equal(calls.length, 2);
});

test('Orca not running: no fallback, no error', async () => {
  const deps: TerminalHostDeps = {
    bin: (name) => `/bin/${name}`,
    run: async () => {
      throw new Error('ENOENT');
    },
  };
  assert.equal(await findOrcaTab(claude, deps), null);
});

test('a tab that also fits another known conversation in the folder is not this one’s', () => {
  const twin = { ...claude, nativeId: '4f1c2a3b-0000-4000-8000-000000000002' };
  assert.equal(matchOrcaTab([row()], claude, [claude, twin]), null);
  // Others elsewhere, of another agent, or with another title do not matter; neither does itself.
  assert.ok(
    matchOrcaTab([row()], claude, [
      claude,
      { ...twin, cwd: '/projects/other' },
      { ...twin, provider: 'codex' },
      { ...twin, title: '다른 일' },
      { ...twin, nativeTitle: false },
    ]),
  );
  // Codex: an abbreviation two known threads share names neither.
  const shared = `${CODEX_ID.slice(0, 29)}... | agent`;
  const sibling = { ...codex, nativeId: `${CODEX_ID.slice(0, 29)}9999999` };
  assert.equal(matchOrcaTab([row({ title: shared })], codex, [sibling]), null);
  assert.ok(matchOrcaTab([row({ title: `${CODEX_ID} | agent` })], codex, [sibling]));
});

test('findOrcaTab applies the same uniqueness check', async () => {
  const deps: TerminalHostDeps = {
    bin: (name) => `/bin/${name}`,
    run: async () => JSON.stringify({ ok: true, result: { terminals: [row()] } }),
  };
  const twin = { ...claude, nativeId: '4f1c2a3b-0000-4000-8000-000000000002' };
  assert.equal(await findOrcaTab(claude, deps, false, [twin]), null);
  assert.ok(await findOrcaTab(claude, deps, false, [claude]));
});
