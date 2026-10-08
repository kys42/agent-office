import os from 'node:os';
import path from 'node:path';
import { parse } from 'acorn';
import type { WorkingLocation } from '../../src/shared/types.js';
// Where a session works = where it launched, unless it leaves work evidence elsewhere: files it
// edits, or Git/PR state it writes (commit, push, new branch, PR). A cd to look around, a file it
// reads or a PR link in prose never moves it. Interpret only explicit tool fields; never execute
// transcript code.
const safe = (v: unknown): v is string =>
  typeof v === 'string' && v.length < 4096 && path.isAbsolute(v) && !/[\x00-\x1f$`]/.test(v);
/** Agent homes and Claude scratch folders support the work; they are never where it is. */
export function isAgentHome(p: string, home = os.homedir()) {
  const n = path.normalize(p);
  const inside = (root: string) => n === root || n.startsWith(root + path.sep);
  return (
    ['.claude', '.codex', '.openclaw'].some((d) => inside(path.join(home, d))) ||
    /^\/(?:private\/)?tmp\/claude-[^/]+(?:\/|$)/.test(n)
  );
}
const evidence = (
  p: string | undefined,
  at: number,
  source: WorkingLocation['source'],
): WorkingLocation | undefined =>
  safe(p) && !isAgentHome(p) ? { path: path.normalize(p), at, source } : undefined;
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
/** A simple command of a command line; `piped` ones run in a pipeline's subshell. */
interface Segment {
  text: string;
  piped: boolean;
}
/**
 * Simple commands of one command line, split on &&, ||, ;, | and newlines only at the top level.
 * Quoted text, command substitutions ($(…), `…`), comments and heredoc bodies are never read as
 * commands of this shell (a commit message, a script, an example).
 */
function segments(command: string): Segment[] {
  const out: Segment[] = [];
  const pending: { tag: string; strip: boolean }[] = [];
  // Nesting: quotes and substitutions; only the top level splits.
  const stack: string[] = [];
  let cur = '';
  let piped = false;
  const push = (next = false) => {
    const text = cur.trim();
    if (text) out.push({ text, piped: piped || next });
    cur = '';
    piped = next;
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
      const tag = command.slice(i + 2).match(/^(-?)\s*(?:'([^']+)'|"([^"]+)"|([\w.-]+))/);
      if (tag) {
        pending.push({ tag: tag[2] ?? tag[3] ?? tag[4], strip: tag[1] === '-' });
        cur += command.slice(i, i + 2 + tag[0].length);
        i += 1 + tag[0].length;
      } else cur += c;
    } else if (c === '\n') {
      push();
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
      push();
      i++;
    } else if (c === '|') push(true);
    else if (c === ';') push();
    else cur += c;
  }
  push();
  return out;
}
const CONTROL =
  /^(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b|^[({]|^[\w-]+\s*\(\s*\)/;
const GIT_WRITES = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert']);
/**
 * Walk a command line: `cd` moves the directory for the rest of the line; a Git or PR write
 * reports where it ran. Returns the directory after the line and the last write's location.
 */
export function readCommand(command: string, base: string | undefined, at: number) {
  const parts = segments(command);
  // Any cd word at all (e.g. `then cd …`) counts when the effect can't be followed.
  const cds = parts.some(({ text }) => /(?:^|\s)cd(?:\s|$)/.test(text));
  // Control flow and function definitions decide at run time what actually executes: claim no
  // write, and if a cd is inside, the shell's place afterwards is unknown.
  if (parts.some(({ text }) => CONTROL.test(text)))
    return { dir: cds ? undefined : base, moved: cds, write: undefined };
  let dir = base;
  let moved = false;
  let write: WorkingLocation | undefined;
  for (const { text: part, piped } of parts) {
    const words = tokens(part);
    // Assignments and wrappers before the command; GIT_DIR/GIT_WORK_TREE pick another repository.
    let elsewhere = false;
    while (words[0] && /^\w+=/.test(words[0]))
      elsewhere ||= /^GIT_(?:DIR|WORK_TREE)=/.test(words.shift()!);
    if (words[0] === 'rtk' && words[1] === 'proxy') words.splice(0, 2);
    else if (['rtk', 'command', 'time'].includes(words[0])) words.shift();
    const [head, ...rest] = words;
    // A cd inside a pipeline changes only that pipeline's subshell.
    if (head === 'cd' && piped) continue;
    if (head === 'cd') {
      // Options before the directory: -L/-P/-e/-@ and --; anything else is unknown.
      let k = 0;
      while (/^-[LPe@]+$/.test(rest[k] ?? '')) k++;
      if (rest[k] === '--') k++;
      const target = rest[k];
      dir = target && !target.startsWith('-') ? resolveIn(dir, target) : undefined;
      moved = true;
      continue;
    }
    if (head === 'gh' && rest[0] === 'pr' && ['create', 'merge'].includes(rest[1])) {
      write = evidence(dir, at, 'git-write') ?? write;
      continue;
    }
    if (head !== 'git') continue;
    let where = elsewhere ? undefined : dir;
    let i = 0;
    // Global options: -C <dir> runs elsewhere, -c <k=v> only configures; --git-dir/--work-tree
    // pick a repository this doesn't follow, so no place is claimed.
    while (rest[i]?.startsWith('-')) {
      if (rest[i] === '-C' && rest[i + 1]) where = resolveIn(where, rest[++i]);
      else if (rest[i] === '-c') i++;
      else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(rest[i])) {
        where = undefined;
        if (!rest[i].includes('=')) i++;
      }
      i++;
    }
    const sub = rest[i];
    const args = rest.slice(i + 1);
    const branching =
      (sub === 'switch' && args.some((a) => ['-c', '-C', '--create'].includes(a))) ||
      (sub === 'checkout' && args.some((a) => ['-b', '-B'].includes(a)));
    if (sub === 'worktree' && args[0] === 'add') {
      // The new worktree is where the work goes next.
      const target = args
        .slice(1)
        .filter((a, k, all) => !a.startsWith('-') && !['-b', '-B'].includes(all[k - 1]))[0];
      write = evidence(target ? resolveIn(where, target) : undefined, at, 'git-write') ?? write;
    } else if (GIT_WRITES.has(sub) || branching) write = evidence(where, at, 'git-write') ?? write;
  }
  /** `dir` is undefined when a cd went somewhere that can't be read literally ($VAR, ~, -). */
  return { dir, moved, write };
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
    const patch = typeof raw === 'string' ? raw : ((raw as any)?.input ?? (raw as any)?.patch);
    const file =
      typeof patch === 'string'
        ? patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1]?.trim()
        : undefined;
    const full = file ? resolveIn(cwd, file) : undefined;
    return full ? evidence(path.dirname(full), at, 'file-edit') : undefined;
  }
}
/** The shell's own report that it went back after a cd outside the project (last line only). */
export function resetLocation(text: string): string | undefined {
  const last = text.trimEnd().split('\n').at(-1)?.trim();
  const target = last?.match(/^Shell cwd was reset to (.+)$/)?.[1];
  return safe(target) ? path.normalize(target) : undefined;
}
/**
 * A shell tool call: where it wrote Git/PR state, if it did. `shell` is where a persistent
 * shell (Claude Bash) currently is; an explicit workdir wins for the call.
 */
export function toolLocation(
  name: string,
  raw: unknown,
  at: number,
  shell?: string,
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
      ? shell
      : safe(given)
        ? given
        : typeof given === 'string' && given && !/[$`~\x00-\x1f]/.test(given)
          ? resolveIn(shell, given)
          : undefined;
  return readCommand(command, base, at).write;
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
