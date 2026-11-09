import os from 'node:os';
import { wrappedPatches } from './working-location.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputCandidate } from '../../src/shared/types.js';
import {
  ARTIFACT_LINKS,
  CONFIG_JSON,
  OUTPUT_EXCLUDED_DIRS,
  OUTPUT_EXTENSIONS,
  extensionOf,
} from '../../src/shared/outputs.js';

// Outputs a session made (#350), from its record only: the files its edit tool created, the
// files it pointed the person to, and the Claude Artifacts it published. Each agent's way of
// saying so is read here, by tool and record shape (like working-location.ts): Claude `Write`
// tells "File created successfully" from "has been updated" in its result, Codex `apply_patch`
// names `*** Add File:` and reports success. No folder is ever listed and no file is read: a
// path counts only when the record names it, and a mention is checked by the collector later.

/** Candidates kept per parse (the newest); the store keeps what it has seen across windows. */
const MAX_CANDIDATES = 200;

/**
 * The absolute path of an output file, or null when it doesn't count: not a document kind, a
 * project config, or inside a hidden, dependency, VCS, build or test-results folder. Inside the
 * session's own folder only the part below it is judged (a session may work in a hidden worktree
 * folder); elsewhere the whole path is (`~/.claude/plans/…` is not an output).
 */
export function outputFile(raw: unknown, cwd?: string | null, home = os.homedir()): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p || p.length > 4096 || /[\x00-\x1f]/.test(p)) return null;
  if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  if (!path.isAbsolute(p)) {
    // A relative path is read from where the call ran, only when written out literally.
    if (!cwd || !path.isAbsolute(cwd) || /[$`*~]/.test(p)) return null;
    p = path.resolve(cwd, p);
  }
  // Never a network share (reaching it would reach out to that host).
  if (/^[\\/]{2}/.test(p)) return null;
  p = path.normalize(p);
  const base = path.basename(p);
  const ext = extensionOf(base);
  if (!OUTPUT_EXTENSIONS.has(ext) || base.startsWith('.')) return null;
  if (ext === 'json' && CONFIG_JSON.test(base)) return null;
  const root = cwd && path.isAbsolute(cwd) ? path.normalize(cwd) : undefined;
  const below = root && p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const rel = below ? p.slice(root!.length) : p;
  const dirs = rel.split(/[\\/]/).slice(0, -1).filter(Boolean);
  if (dirs.some((d) => d.startsWith('.') || OUTPUT_EXCLUDED_DIRS.has(d))) return null;
  return p;
}

/** Files a patch adds (`*** Add File: path`), as written in it. */
export function patchAdds(patch: unknown): string[] {
  if (typeof patch !== 'string') return [];
  return [...patch.matchAll(/^\*\*\* Add File: (.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

/** The patch text of an `apply_patch` call: JSON arguments `{input}`, or the patch itself. */
function patchText(raw: unknown): string | undefined {
  let input: any = raw;
  if (typeof raw === 'string' && raw.trimStart().startsWith('{'))
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
  const patch = typeof input === 'string' ? input : (input?.input ?? input?.patch);
  return typeof patch === 'string' ? patch : undefined;
}

/** Whether an `apply_patch` result says the patch went in. */
function patchApplied(text: string): boolean {
  if (/Success\. Updated the following files/.test(text)) return true;
  if (text.trimStart().startsWith('{'))
    try {
      const out = JSON.parse(text);
      if (out?.metadata?.exit_code === 0) return true;
      if (typeof out?.output === 'string') return patchApplied(out.output);
    } catch {
      /* plain text */
    }
  return false;
}

/** Unquote a shell word (`"a b"`, `'a b'`, `a\ b`). */
const word = (w: string) =>
  w
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^'(.*)'$/s, '$1')
    .replace(/\\(.)/g, '$1');

/**
 * Files a reply points the person to: `open <path>` (options before it skipped, `-a App` with
 * its app) and markdown links to a local path. Only absolute (or `~/`) paths: a relative one
 * says nothing certain about where it is.
 */
export function mentionedFiles(text: string): string[] {
  const out: string[] = [];
  // `open` as a command (not inside a word), up to the end of its command on that line.
  for (const m of text.matchAll(/(?:^|[\s`$(>;&|])open[ \t]+([^\n`;&|)]*)/g)) {
    const words = m[1].match(/"[^"\n]*"|'[^'\n]*'|(?:\\.|[^\s"'])+/g) ?? [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.startsWith('-')) {
        // -a/-b take an application; other flags stand alone.
        if (/^-[ab]$/.test(w)) i++;
        continue;
      }
      // Prose around it: a sentence's end, or a particle right after the name ("…/x.md를").
      const p = word(w)
        .replace(/[.,:;!?]+$/, '')
        .replace(/^(.*\.[A-Za-z0-9]{1,8})[^\x00-\x7F]+$/, '$1');
      if (p.startsWith('/') || p.startsWith('~/')) out.push(p);
    }
  }
  for (const m of text.matchAll(/\]\(\s*<?((?:\/|~\/|file:\/\/|[A-Za-z]:[\\/])[^)\s>]+)>?\s*\)/g)) {
    let p = m[1];
    try {
      // fileURLToPath: drive letters and escapes as the platform names them (file:///C:/x → C:\x).
      p = p.startsWith('file://') ? fileURLToPath(p) : decodeURI(p);
    } catch {
      continue;
    }
    out.push(p);
  }
  return out;
}

interface Pending {
  kind: 'write' | 'patch' | 'wrapped' | 'artifact';
  files: string[];
  /** Code mode: each file as the patch wrote it (the result lists it that way). */
  written?: string[];
}

/** A tool output's text: the `output` of JSON `{output, metadata}`, else the text itself. */
function outputText(text: string): string {
  if (text.trimStart().startsWith('{'))
    try {
      const out = JSON.parse(text);
      if (typeof out?.output === 'string') return out.output;
    } catch {
      /* plain text */
    }
  return text;
}

/** The script of a code-mode call: the code itself, or `{code}` / `{input}` JSON arguments. */
function wrappedCode(raw: unknown): string | undefined {
  if (typeof raw === 'object' && raw) raw = (raw as any).code ?? (raw as any).input;
  if (typeof raw !== 'string') return;
  if (raw.trimStart().startsWith('{'))
    try {
      const args = JSON.parse(raw);
      const code = args?.code ?? args?.input ?? args?.source;
      if (typeof code === 'string') return code;
    } catch {
      /* the code itself */
    }
  return raw;
}

/**
 * Collects the outputs one parse of a record names. `call` takes each tool call (with where it
 * ran), `result` its outcome, `say` each reply; `list` gives the candidates, newest last.
 */
export class OutputTracker {
  private found = new Map<string, OutputCandidate>();
  private pending = new Map<string, Pending>();
  private add(c: OutputCandidate) {
    const held = this.found.get(c.key);
    // A file the session made with its tool is that, whatever it said about it later.
    if (held && (c.via === 'mention' || held.via !== 'mention')) return;
    this.found.set(c.key, c);
    if (this.found.size > MAX_CANDIDATES) this.found.delete(this.found.keys().next().value!);
  }
  /** A tool call: Claude `Write`, Codex `apply_patch`, Claude `Artifact`; others say nothing. */
  call(name: string, raw: unknown, cwd: string | null | undefined, callId?: string) {
    if (!callId) return;
    if (name === 'Write' && raw && typeof raw === 'object') {
      const file = outputFile((raw as any).file_path, cwd);
      if (file) this.pending.set(callId, { kind: 'write', files: [file] });
      return;
    }
    if (/^(?:functions\.)?apply_patch$/.test(name)) {
      const files = patchAdds(patchText(raw))
        .map((f) => outputFile(f, cwd))
        .filter((f): f is string => !!f);
      if (files.length) this.pending.set(callId, { kind: 'patch', files });
      return;
    }
    // Code mode (`exec` / `functions.exec`): literal patches given to `tools.apply_patch`, as
    // `wrappedLocations` reads them. The script's own result is all there is, so each added
    // file waits for that result to report it added (see `result`).
    if (name === 'functions.exec' || name === 'exec') {
      const code = wrappedCode(raw);
      if (!code || !/tools\.apply_patch/.test(code)) return;
      const files: string[] = [];
      const written: string[] = [];
      for (const patch of wrappedPatches(code))
        for (const f of patchAdds(patch)) {
          const key = outputFile(f, cwd);
          if (key) {
            files.push(key);
            written.push(f);
          }
        }
      if (files.length) this.pending.set(callId, { kind: 'wrapped', files, written });
    }
    if (name === 'Artifact') this.pending.set(callId, { kind: 'artifact', files: [] });
  }
  /**
   * A call's result. Claude `Write` made the file only when it says so ("File created
   * successfully at:", or `toolUseResult.type` "create"); "has been updated" means it was there.
   * A denied or failed call made nothing.
   */
  result(
    callId: string | undefined,
    text: string,
    at: number,
    failed: boolean,
    detail?: { type?: unknown; filePath?: unknown },
  ) {
    const call = callId ? this.pending.get(callId) : undefined;
    if (!call) return;
    this.pending.delete(callId!);
    if (failed) return;
    if (call.kind === 'write') {
      const created =
        /^\s*File created successfully at:/.test(text) ||
        (detail?.type === 'create' && !/has been updated/.test(text));
      if (created) this.add({ key: call.files[0], kind: 'file', at, via: 'write' });
    } else if (call.kind === 'patch') {
      if (patchApplied(text))
        for (const key of call.files) this.add({ key, kind: 'file', at, via: 'patch' });
    } else if (call.kind === 'wrapped') {
      // Only a clear report counts: the patch tool's success line, and this very file listed
      // as added (`A <path>`, as written or resolved). A script's exit code says nothing of it.
      const report = outputText(text);
      if (!/Success\. Updated the following files/.test(report)) return;
      const added = new Set([...report.matchAll(/^\s*A (.+?)\s*$/gm)].map((m) => m[1]));
      call.files.forEach((key, i) => {
        if (added.has(key) || added.has(call.written![i]))
          this.add({ key, kind: 'file', at, via: 'patch' });
      });
    } else this.links(text, at);
  }
  /**
   * Codex's own report of an applied patch (`patch_apply_end`, when the rollout keeps it): the
   * files it added.
   */
  applied(changes: unknown, at: number, cwd: string | null | undefined) {
    if (!changes || typeof changes !== 'object') return;
    for (const [file, change] of Object.entries(changes as Record<string, any>)) {
      if (!change || typeof change !== 'object') continue;
      if (change.type !== 'add' && !('add' in change)) continue;
      const key = outputFile(file, cwd);
      if (key) this.add({ key, kind: 'file', at, via: 'patch' });
    }
  }
  /** A reply: the files it points to (checked later) and the Artifacts it links. */
  say(text: string, at: number, cwd: string | null | undefined) {
    if (!text) return;
    for (const raw of mentionedFiles(text)) {
      const key = outputFile(raw, cwd);
      if (key) this.add({ key, kind: 'file', at, via: 'mention' });
    }
    this.links(text, at);
  }
  private links(text: string, at: number) {
    for (const m of text.matchAll(ARTIFACT_LINKS)) {
      const title = m[1]?.trim();
      this.add({ key: m[2], kind: 'link', at, via: 'artifact', ...(title ? { title } : {}) });
    }
  }
  list(): OutputCandidate[] {
    return [...this.found.values()].sort((a, b) => a.at - b.at);
  }
}

/** Outputs of transport fragments of one conversation: each once, the first finding kept. */
export function mergeOutputs(lists: (OutputCandidate[] | undefined)[]): OutputCandidate[] {
  const out = new Map<string, OutputCandidate>();
  for (const c of lists.flat()) {
    if (!c) continue;
    const held = out.get(c.key);
    if (
      !held ||
      (held.via === 'mention' && c.via !== 'mention') ||
      (held.via === c.via && c.at < held.at)
    )
      out.set(c.key, c);
  }
  return [...out.values()].sort((a, b) => a.at - b.at).slice(-MAX_CANDIDATES);
}
