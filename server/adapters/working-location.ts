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
/** Shell segments of one command line (&&, ||, ;, |, newlines), with wrappers like `rtk proxy` dropped. */
const segments = (command: string) =>
  command
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      part
        .trim()
        .replace(/^(?:\w+=\S*\s+)*/, '')
        .replace(/^(?:rtk(?:\s+proxy)?|command|time)\s+/, ''),
    )
    .filter(Boolean);
const GIT_WRITES = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert']);
/**
 * Walk a command line: `cd` moves the directory for the rest of the line; a Git or PR write
 * reports where it ran. Returns the directory after the line and the last write's location.
 */
export function readCommand(command: string, base: string | undefined, at: number) {
  let dir = base;
  let write: WorkingLocation | undefined;
  for (const part of segments(command)) {
    const [head, ...rest] = tokens(part);
    if (head === 'cd') {
      dir = rest[0] ? resolveIn(dir, rest[0]) : undefined;
      continue;
    }
    if (head === 'gh' && rest[0] === 'pr' && ['create', 'merge'].includes(rest[1])) {
      write = evidence(dir, at, 'git-write') ?? write;
      continue;
    }
    if (head !== 'git') continue;
    let where = dir;
    let i = 0;
    // Global options: -C <dir> runs elsewhere, -c <k=v> only configures.
    while (rest[i]?.startsWith('-')) {
      if (rest[i] === '-C' && rest[i + 1]) where = resolveIn(where, rest[++i]);
      else if (rest[i] === '-c') i++;
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
  return { dir, write };
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
  const explicit = args.workdir ?? args.cwd;
  const command = args.cmd ?? args.command;
  if (typeof command !== 'string') return;
  return readCommand(command, safe(explicit) ? explicit : shell, at).write;
}
// Inspect syntax only; never evaluate log text. Dynamic expressions are unknown.
export function wrappedLocations(code: unknown, at: number): WorkingLocation[] {
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
          const value = toolLocation('exec_command', fields, at);
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
