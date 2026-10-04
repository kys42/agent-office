import path from 'node:path';
import { parse } from 'acorn';
import type { WorkingLocation } from '../../src/shared/types.js';
// Interpret only explicit shell invocation fields. Never execute transcript code,
// follow arbitrary file reads, or infer location from prose/PR URLs.
export function toolLocation(name: string, raw: unknown, at: number): WorkingLocation | undefined {
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
  // A literal leading cd overrides the invocation cwd for this command only.
  const match =
    typeof command === 'string' &&
    command.match(/^\s*cd\s+(?:"([^"$`\n]+)"|'([^'\n]+)'|([^\s;&|$`]+))\s*&&\s*\S/);
  const cd = match && (match[1] || match[2] || match[3]);
  const safe = (v: unknown): v is string =>
    typeof v === 'string' && v.length < 4096 && path.isAbsolute(v) && !/[\x00-\x1f$`]/.test(v);
  if (safe(cd)) return { path: path.normalize(cd), at, source: 'shell-cd' };
  if (safe(explicit)) return { path: path.normalize(explicit), at, source: 'tool-workdir' };
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
