import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { chdirWord, orcaCreateArgs, shellCommand } from '../desktop/orca-launch.js';

/**
 * An Orca tab is a visible agent tab only when Orca classifies its `--command` as an interactive
 * agent (`shouldUseRendererBackedInteractiveTerminal`): it reads the leading words, drops
 * `NAME=value`, then `env` with its options (`-u X` two words, any other `-…` one word), and the
 * next word's file name must be `claude` or `codex`. A conversation in a folder inside a worktree
 * starts through `env … '-C<folder>'`, so every command we type must still pass that rule, and
 * the shell must read the same words. Nothing here runs an agent or touches Orca: Orca's own
 * classifier is a pure function read from the installed app when present, and the shell only
 * prints the words (or runs `/bin/pwd`).
 */

const ORCA_RULE =
  '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/codex-command-classification.js';

// A copy of Orca's rule (its tokenizer, `stripShellLaunchPrefix` and the agent names), so the
// check runs where Orca is not installed too.
function tokens(command: string, limit = 32): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        if (out.length >= limit) return out;
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current && out.length < limit) out.push(current);
  return out;
}
const assignment = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
const basename = (t: string) => t.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
function strip(words: string[]): string[] {
  const rest = [...words];
  while (rest[0] && assignment(rest[0])) rest.shift();
  if (rest[0] && basename(rest[0]) === 'env') {
    rest.shift();
    while (rest[0]) {
      const t = rest[0];
      if (assignment(t) || t.startsWith('--unset=')) rest.shift();
      else if (t === '-u' || t === '--unset') rest.splice(0, 2);
      else if (t.startsWith('-')) rest.shift();
      else break;
    }
  }
  return rest;
}
const CODEX_ONE_SHOT = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'apply', 'a']);
function interactiveCopy(command: string): boolean {
  const words = strip(tokens(command.trim()).filter(Boolean));
  const agent = words[0] ? basename(words[0]) : '';
  const flags = (t: string) => ['--help', '-h', '--version', '-V'].includes(t);
  if (agent === 'codex') {
    const sub = words.slice(1).find((t) => !t.startsWith('-'));
    return !words.slice(1).some(flags) && !(sub && CODEX_ONE_SHOT.has(sub.toLowerCase()));
  }
  if (agent === 'claude')
    return !words.slice(1).some((t) => flags(t) || /^(-p|--print)(=|$)/.test(t));
  return false;
}

const orcaRule: ((command: string) => boolean) | undefined = existsSync(ORCA_RULE)
  ? createRequire(import.meta.url)(ORCA_RULE).shouldUseRendererBackedInteractiveTerminal
  : undefined;

const ID = '4f1c2a3b-0000-4000-8000-000000000001';
const SID = '0b8e2f43-9c1d-4f6a-8b3e-2d7c5a1e9f00';
const CODEX_ID = '01a15d10-2a38-75b3-af5d-e7e6b';
const ROOT = "/Users/me/orca/workspaces/it's a repo";
const FOLDERS = [ROOT, `${ROOT}/ocr`, `${ROOT}/packages/a "b" c/d'e`];
const ENVS: NodeJS.ProcessEnv[] = [
  {},
  { CLAUDE_CONFIG_DIR: "/Users/me/agent homes/it's claude", CODEX_HOME: '/opt/codex home' },
];

function* launches() {
  for (const cwd of FOLDERS)
    for (const env of ENVS)
      for (const executable of [undefined, '/opt/homebrew/bin/claude'])
        for (const skipPermissions of [false, true]) {
          const base = { cwd, title: '포크', skipPermissions };
          yield { env, s: { ...base, provider: 'claude' as const, nativeId: ID, executable } };
          yield {
            env,
            s: {
              ...base,
              provider: 'claude' as const,
              nativeId: 'new',
              fresh: true,
              sessionId: SID,
              initialMessage: "it's -p --help; ok\n둘째 줄",
              executable,
            },
          };
          yield {
            env,
            s: {
              ...base,
              provider: 'claude' as const,
              nativeId: ID,
              fork: true,
              sessionId: SID,
              initialMessage: "'quoted' first",
              executable,
            },
          };
          const codex = executable?.replace(/claude$/, 'codex');
          yield {
            env,
            s: { ...base, provider: 'codex' as const, nativeId: CODEX_ID, executable: codex },
          };
          yield {
            env,
            s: {
              ...base,
              provider: 'codex' as const,
              nativeId: CODEX_ID,
              fork: true,
              initialMessage: 'exec review',
              executable: codex,
            },
          };
          yield {
            env,
            s: {
              ...base,
              provider: 'codex' as const,
              nativeId: 'new',
              fresh: true,
              executable: codex,
            },
          };
        }
}

const typed = (args: string[]) => args.find((a) => a.startsWith('--command='))!.slice(10);

test('every Orca command, at a worktree root or in a folder inside it, is an interactive agent to Orca', () => {
  let checked = 0;
  for (const { s, env } of launches()) {
    const command = typed(orcaCreateArgs(s, 'darwin', env, ROOT));
    assert.equal(interactiveCopy(command), true, command);
    if (orcaRule) assert.equal(orcaRule(command), true, command);
    // A folder inside the worktree: the agent starts there; at the root nothing changes.
    assert.equal(command.includes(chdirWord(path.resolve(s.cwd))), s.cwd !== ROOT, command);
    checked++;
  }
  assert.ok(checked > 100);
});

test(
  'Orca’s own classifier from the installed app agrees with the copy',
  { skip: !orcaRule },
  () => {
    for (const command of [
      "'/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' '-C/a b/c' 'claude' '--resume' 'x'",
      "'/usr/bin/env' '-C/a'\"'\"'b' 'CODEX_HOME=/x' 'codex' 'fork' 'y'",
      // The old `'\''` spelling hides the agent from Orca's tokenizer: why it is not used.
      "'/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' '-C/a'\\''b' 'claude' '--resume' 'x'",
      "cd '/a/b' && 'claude' '--resume' 'x'",
      "'/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' 'claude' '-p' 'hi'",
      "'/usr/bin/env' '-u' 'CODEX_HOME' 'codex' 'exec' 'hi'",
    ])
      assert.equal(orcaRule!(command), interactiveCopy(command), command);
    assert.equal(
      orcaRule!("'/usr/bin/env' '-u' 'CLAUDE_CONFIG_DIR' '-C/a'\\''b' 'claude' '--resume' 'x'"),
      false,
    );
    assert.equal(orcaRule!("cd '/a/b' && 'claude' '--resume' 'x'"), false);
  },
);

test('the shell reads the same words Orca does, and `env -C` starts in the folder', () => {
  const words = (shell: string, command: string) =>
    execFileSync(shell, ['-c', `printf '%s\\0' ${command}`], { encoding: 'utf8' })
      .split('\0')
      .slice(0, -1);
  for (const { s, env } of launches()) {
    const command = typed(orcaCreateArgs(s, 'darwin', env, ROOT));
    // Orca reads only the leading 32 words; a prompt's line break is one word to both.
    const read = tokens(command, 1000);
    for (const shell of ['/bin/sh', '/bin/zsh'].filter(existsSync))
      assert.deepEqual(words(shell, command), read, `${shell}: ${command}`);
  }
  // `/usr/bin/env -u … '-C<folder>' <program>` runs the program in that folder.
  const base = mkdtempSync(path.join(os.tmpdir(), 'orca-chdir-'));
  try {
    const folder = path.join(base, `a 'quoted' "b" folder`);
    mkdirSync(folder);
    for (const env of ENVS) {
      const command = shellCommand(
        { provider: 'codex', nativeId: 'new', fresh: true, executable: '/bin/pwd' },
        env,
        folder,
      );
      const out = execFileSync('/bin/sh', ['-c', command], { cwd: '/', encoding: 'utf8' });
      assert.equal(realpathSync(out.trim()), realpathSync(folder), command);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
