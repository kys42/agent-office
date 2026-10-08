import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import type { WorkingLocation } from '../../src/shared/types.js';
// Where a session works = where it launched, unless it leaves work evidence elsewhere: files it
// edits, or Git/PR state it writes (commit, push, new branch, PR). A cd to look around, a file it
// reads or a PR link in prose never moves it. Interpret only explicit tool fields; never execute
// transcript code. When the syntax can't be followed for sure, claim nothing.
const safe = (v: unknown): v is string =>
  typeof v === 'string' && v.length < 4096 && path.isAbsolute(v) && !/[\x00-\x1f$`]/.test(v);
const within = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
/**
 * Folders that support the work but are never where it is: agent homes (also when moved by
 * CLAUDE_CONFIG_DIR / CODEX_HOME / OPENCLAW_STATE_DIR) and temporary folders.
 */
export function isSupportFolder(p: string, home = os.homedir(), env = process.env) {
  const n = path.normalize(p);
  const roots = [
    ...['.claude', '.codex', '.openclaw'].map((d) => path.join(home, d)),
    env.CLAUDE_CONFIG_DIR,
    env.CODEX_HOME,
    env.OPENCLAW_STATE_DIR,
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/private/var/folders',
  ].filter((r): r is string => !!r && path.isAbsolute(r));
  return roots.some((root) => within(n, path.normalize(root)));
}
/** Evidence counts unless it is in a support folder — a session that launched there may come home. */
export const admissible = (
  location: WorkingLocation | undefined,
  launch: string | undefined,
): location is WorkingLocation =>
  !!location &&
  (!isSupportFolder(location.path) || (!!launch && within(location.path, path.normalize(launch))));
const evidence = (
  p: string | undefined,
  at: number,
  source: WorkingLocation['source'],
): WorkingLocation | undefined => (safe(p) ? { path: path.normalize(p), at, source } : undefined);
const unquote = (t: string) => t.replace(/^(["'])(.*)\1$/, '$2');
const tokens = (segment: string) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
/** A path relative to `dir`; unknown (undefined) when it can't be resolved literally. */
const resolveIn = (dir: string | undefined, target: string) =>
  /[$`~*]/.test(target) || target === '-'
    ? undefined
    : path.isAbsolute(target)
      ? target
      : dir
        ? path.resolve(dir, target)
        : undefined;
/**
 * A simple command of a command line. `piped` ones run in a pipeline's subshell; `list` numbers
 * the command list it belongs to, and `background` lists (ended by `&`) run in a subshell too.
 */
interface Segment {
  text: string;
  piped: boolean;
  list: number;
  background: boolean;
  /** After `||`: runs only if what came before failed — not established. */
  orElse: boolean;
}
/**
 * Simple commands of one command line, split on &&, ||, ;, | and newlines only at the top level.
 * Quoted text, command substitutions ($(…), `…`), comments and heredoc bodies are never read as
 * commands of this shell (a commit message, a script, an example).
 */
function segments(command: string): Segment[] | undefined {
  const out: Segment[] = [];
  const pending: { tag: string; strip: boolean }[] = [];
  // Nesting: quotes and substitutions; only the top level splits.
  const stack: string[] = [];
  let cur = '';
  let piped = false;
  let list = 0;
  let orElse = false;
  const push = (next = false, nextOrElse = false) => {
    const text = cur.trim();
    if (text) out.push({ text, piped: piped || next, list, background: false, orElse });
    cur = '';
    piped = next;
    orElse = nextOrElse || (orElse && !text);
  };
  /** End the current command list (`;`, newline, or `&` for a background one). */
  const end = (background = false) => {
    push();
    if (background) for (const seg of out) if (seg.list === list) seg.background = true;
    list++;
    orElse = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const ctx = stack.at(-1);
    if (ctx === "'") {
      if (c === "'") stack.pop();
      cur += c;
      continue;
    }
    if (c === '\\') {
      cur += c + (command[++i] ?? '');
      continue;
    }
    if (ctx === '"') {
      if (command.startsWith('$(', i)) {
        stack.push('$(');
        cur += '$(';
        i++;
        continue;
      }
      if (c === '"') stack.pop();
      else if (c === '`') stack.push('`');
      cur += c;
      continue;
    }
    if (ctx === '`') {
      if (c === '`') stack.pop();
      cur += c;
      continue;
    }
    // Top level or inside $( … ).
    if (c === "'" || c === '"' || c === '`') {
      stack.push(c);
      cur += c;
      continue;
    }
    if (command.startsWith('$(', i)) {
      stack.push('$(');
      cur += '$(';
      i++;
      continue;
    }
    if (ctx === '$(') {
      if (c === ')') stack.pop();
      cur += c;
      continue;
    }
    if (c === '#' && (!cur || /\s$/.test(cur))) {
      // A comment runs to the end of the line.
      const next = command.indexOf('\n', i);
      i = (next < 0 ? command.length : next) - 1;
    } else if (command.startsWith('<<', i) && command[i + 2] !== '<') {
      const tag = command.slice(i + 2).match(/^(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([\w.-]+))/);
      // A heredoc whose end can't be read would make its body look like commands: give up.
      if (!tag) return;
      pending.push({ tag: tag[2] ?? tag[3] ?? tag[4], strip: tag[1] === '-' });
      cur += command.slice(i, i + 2 + tag[0].length);
      i += 1 + tag[0].length;
    } else if (c === '\n') {
      end();
      // Skip each heredoc body up to its closing tag line.
      for (const { tag, strip } of pending.splice(0)) {
        while (i < command.length) {
          const next = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, next < 0 ? command.length : next);
          i = next < 0 ? command.length : next;
          if ((strip ? line.trim() : line) === tag) break;
        }
      }
    } else if ((c === '&' || c === '|') && command[i + 1] === c) {
      // Everything after `||` in this list runs only on failure: not established.
      push(false, c === '|' || orElse);
      i++;
    } else if (c === '|') push(true);
    else if (c === ';') end();
    else if (c === '&' && command[i + 1] !== '>' && command[i - 1] !== '>') end(true);
    else cur += c;
  }
  end();
  return out;
}
const CONTROL =
  /^(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b|^[({]|^[\w-]+\s*\(\s*\)/;
const GIT_WRITES = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert']);
/**
 * Where a command line wrote Git or PR state, if it did: `cd` moves the directory for the rest of
 * its list (not past a background list), and the write reports where it ran.
 */
export function commandWrite(
  command: string,
  base: string | undefined,
  at: number,
): WorkingLocation | undefined {
  const parts = segments(command);
  // Unreadable syntax, control flow and function definitions decide at run time what executes.
  if (!parts || parts.some(({ text }) => CONTROL.test(text))) return;
  // `export GIT_DIR=…` (or a bare assignment) points Git elsewhere for the rest of the line.
  let pointed: boolean = false;
  let dir = base;
  let list = -1;
  let before = dir;
  let background = false;
  let write: WorkingLocation | undefined;
  for (const { text: part, piped, list: id, background: bg, orElse } of parts) {
    if (id !== list) {
      // A background list ran in its own subshell: its cd never reached this shell.
      if (background) dir = before;
      list = id;
      before = dir;
      background = bg;
    }
    const words = tokens(part);
    // Assignments and wrappers before the command; GIT_DIR/GIT_WORK_TREE pick another repository.
    let override: boolean = pointed;
    if (words[0] === 'export') words.shift();
    while (words[0] && /^\w+=/.test(words[0])) {
      const assignment = words.shift()!;
      if (/^GIT_(?:DIR|WORK_TREE)=/.test(assignment)) override = true;
    }
    // Only assignments: they stay for the rest of the line.
    if (!words.length) {
      pointed = override;
      continue;
    }
    if (words[0] === 'rtk' && words[1] === 'proxy') words.splice(0, 2);
    else if (['rtk', 'command', 'time'].includes(words[0])) words.shift();
    const [head, ...rest] = words;
    if (orElse) {
      // Maybe ran, maybe not: a cd leaves the place unknown, a write is not claimed.
      if (head === 'cd' && !piped) dir = undefined;
      continue;
    }
    if (head === 'cd') {
      // A cd inside a pipeline changes only that pipeline's subshell.
      if (piped) continue;
      // Options before the directory: -L/-P/-e/-@ and --; anything else is unknown.
      let k = 0;
      while (/^-[LPe@]+$/.test(rest[k] ?? '')) k++;
      if (rest[k] === '--') k++;
      const target = rest[k];
      dir = target && !target.startsWith('-') ? resolveIn(dir, target) : undefined;
      continue;
    }
    if (head === 'gh' && rest[0] === 'pr' && ['create', 'merge'].includes(rest[1])) {
      // Another repository named (--repo, a PR URL) isn't necessarily this folder's.
      const elsewhere = rest.some((a) => /^(?:-R|--repo)(?:=|$)/.test(a) || /^https?:\/\//.test(a));
      if (!elsewhere && !rest.some((a) => ['--help', '-h', '--dry-run'].includes(a)))
        write = evidence(dir, at, 'git-write') ?? write;
      continue;
    }
    if (head !== 'git') continue;
    let where = dir;
    let i = 0;
    // Global options: -C <dir> runs elsewhere, -c <k=v> only configures; --git-dir/--work-tree
    // pick a repository this doesn't follow, so no place is claimed whatever comes after.
    while (rest[i]?.startsWith('-')) {
      // `git --help commit`, `git -h`, `git --version` only ask.
      if (['--help', '-h', '--version'].includes(rest[i])) override = true;
      else if (rest[i] === '-C' && rest[i + 1]) where = resolveIn(where, rest[++i]);
      else if (rest[i] === '-c') i++;
      else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(rest[i])) {
        override = true;
        if (!rest[i].includes('=')) i++;
      }
      i++;
    }
    if (override) continue;
    const sub = rest[i];
    const args = rest.slice(i + 1);
    // Asking (help, dry runs) changes nothing.
    if (
      args.some((a) => ['--help', '-h', '--dry-run'].includes(a)) ||
      (sub === 'push' && args.includes('-n'))
    )
      continue;
    const branching =
      (sub === 'switch' && args.some((a) => ['-c', '-C', '--create'].includes(a))) ||
      (sub === 'checkout' && args.some((a) => ['-b', '-B'].includes(a)));
    if (sub === 'worktree' && args[0] === 'add') {
      // The new worktree is where the work goes next (skipping options that take a value).
      const target = args
        .slice(1)
        .filter(
          (a, k, all) =>
            !a.startsWith('-') &&
            !['-b', '-B', '--reason'].includes(all[k]) &&
            !['-b', '-B', '--reason'].includes(all[k - 1]),
        )[0];
      write = evidence(target ? resolveIn(where, target) : undefined, at, 'git-write') ?? write;
    } else if (GIT_WRITES.has(sub) || branching) write = evidence(where, at, 'git-write') ?? write;
  }
  return write;
}
/** Where a file-editing tool wrote (Claude edit tools, Codex apply_patch). */
export function editLocation(
  name: string,
  raw: unknown,
  cwd: string | undefined,
  at: number,
): WorkingLocation | undefined {
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && raw && typeof raw === 'object') {
    const file = (raw as any).file_path ?? (raw as any).notebook_path;
    return safe(file) ? evidence(path.dirname(file), at, 'file-edit') : undefined;
  }
  if (/^(?:functions\.)?apply_patch$/.test(name)) {
    let input: any = raw;
    // function_call arguments arrive as JSON text: {"input": "*** Begin Patch…"}.
    if (typeof raw === 'string' && raw.trimStart().startsWith('{'))
      try {
        input = JSON.parse(raw);
      } catch {
        return;
      }
    const patch = typeof input === 'string' ? input : (input?.input ?? input?.patch);
    const file =
      typeof patch === 'string'
        ? patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1]?.trim()
        : undefined;
    const full = file ? resolveIn(cwd, file) : undefined;
    return full ? evidence(path.dirname(full), at, 'file-edit') : undefined;
  }
}
/**
 * A shell tool call: where it wrote Git/PR state, if it did. `start` is where the call began
 * (Claude records the shell's directory on every record; Codex runs in the turn's cwd); an
 * explicit workdir wins for the call.
 */
export function toolLocation(
  name: string,
  raw: unknown,
  at: number,
  start?: string,
): WorkingLocation | undefined {
  if (!/^(?:functions\.)?(?:exec_command|Bash|bash|exec|shell_command)$/.test(name)) return;
  let args: any = raw;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return;
    }
  }
  if (!args || typeof args !== 'object') return;
  const given = args.workdir ?? args.cwd;
  const command = args.cmd ?? args.command;
  if (typeof command !== 'string') return;
  // An explicit workdir wins; a relative one is read from where the call starts; one that can't
  // be read literally leaves the place unknown (never the default).
  const base =
    given === undefined || given === null
      ? start
      : safe(given)
        ? given
        : typeof given === 'string' && given && !/[$`~\x00-\x1f]/.test(given)
          ? resolveIn(start, given)
          : undefined;
  return commandWrite(command, base, at);
}
// Inspect syntax only; never evaluate log text. Dynamic expressions are unknown.
export function wrappedLocations(code: unknown, at: number, cwd?: string): WorkingLocation[] {
  if (typeof code !== 'string' || code.length > 200_000) return [];
  const out: WorkingLocation[] = [];
  try {
    const ast = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    });
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (
        [
          'FunctionDeclaration',
          'FunctionExpression',
          'ArrowFunctionExpression',
          'IfStatement',
          'ConditionalExpression',
          'LogicalExpression',
          'ForStatement',
          'WhileStatement',
          'ForOfStatement',
          'ForInStatement',
          'SwitchStatement',
        ].includes(node.type)
      )
        return;
      // Code mode's own edits: a literal patch passed to tools.apply_patch.
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object?.name === 'tools' &&
        node.callee.property?.name === 'apply_patch'
      ) {
        const arg = node.arguments[0];
        const patch =
          arg?.type === 'Literal' && typeof arg.value === 'string'
            ? arg.value
            : arg?.type === 'TemplateLiteral' && !arg.expressions.length
              ? arg.quasis[0]?.value.cooked
              : undefined;
        const value = patch ? editLocation('apply_patch', patch, cwd, at) : undefined;
        if (value) out.push(value);
      }
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object?.name === 'tools' &&
        node.callee.property?.name === 'exec_command'
      ) {
        const arg = node.arguments[0];
        if (arg?.type === 'ObjectExpression') {
          const fields: Record<string, string> = {};
          if (
            arg.properties.some(
              (p: any) =>
                p.type !== 'Property' ||
                p.computed ||
                (['workdir', 'cwd', 'cmd', 'command'].includes(p.key?.name ?? p.key?.value) &&
                  p.value?.type !== 'Literal'),
            )
          )
            return;
          for (const p of arg.properties) {
            const key = p.key?.name ?? p.key?.value;
            if (
              p.type === 'Property' &&
              !p.computed &&
              p.kind === 'init' &&
              p.value?.type === 'Literal' &&
              typeof p.value.value === 'string'
            )
              fields[key] = p.value.value;
          }
          const value = toolLocation('exec_command', fields, at, cwd);
          if (value) out.push(value);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast);
  } catch {
    return [];
  }
  return new Set(out.map((x) => x.path)).size === 1 ? out.slice(-1) : [];
}
