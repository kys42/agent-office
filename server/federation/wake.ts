import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Session } from '../../src/shared/types.js';
import { scanCodexOrigin } from '../../desktop/codex-queue.js';
import { findCodexDestination } from '../../desktop/codex-send.js';
import { defaultTerminalDeps } from '../../desktop/terminals.js';
import { defaultResumeDeps } from '../../desktop/tmux-resume.js';

// Only a saved, ordinary conversation, identified by the exporter. The client supplies no
// path, executable, native ID, initial prompt, or permission flags.
export function resumeDirectory(s: Session) {
  if (
    s.provider !== 'codex' ||
    !z.uuid().safeParse(s.nativeId).success ||
    s.id !== 'codex:' + s.nativeId ||
    !['root', 'fork'].includes(s.relation?.kind ?? 'root') ||
    !['interactive', 'unknown'].includes(s.origin?.kind ?? 'unknown') ||
    !s.cwd ||
    !path.isAbsolute(s.cwd) ||
    /[\x00-\x1f\x7f]/.test(s.cwd)
  )
    throw Error('Unsupported conversation');
  return s.cwd;
}
export async function resumeOrigin(s: Session) {
  resumeDirectory(s);
  const origin = (await scanCodexOrigin(s.sourcePath, s.nativeId))?.origin;
  if (!origin || origin.subagent) return null;
  return origin.originator === 'Codex Desktop'
    ? 'desktop'
    : origin.originator === 'codex-tui'
      ? 'cli'
      : null;
}
export async function desktopApp() {
  if (process.platform !== 'darwin') return null;
  // Use the running bundle if possible, rather than opening a second installed client.
  const apps = ['/Applications/Codex.app', '/Applications/ChatGPT.app'];
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'comm=']).catch(() => ({
    stdout: '',
  }));
  const processes = stdout.split('\n');
  const running = (app: string) =>
    processes.some((executable) => executable.startsWith(app + '/Contents/MacOS/'));
  for (const app of apps.sort((a, b) => Number(running(b)) - Number(running(a)))) {
    // The unified Codex bundle can be installed as Codex.app while its executable is ChatGPT.
    if (
      app.endsWith('/Codex.app') ||
      (await access(path.join(app, 'Contents/Resources/codex-cli')).then(
        () => true,
        () => false,
      ))
    ) {
      if (
        await access(path.join(app, 'Contents/Info.plist'), constants.R_OK).then(
          () => true,
          () => false,
        )
      )
        return app;
    }
  }
  return null;
}
export async function wakeDesktop(s: Session, authorize: () => void) {
  const app = await desktopApp();
  if (!app || (await resumeOrigin(s)) !== 'desktop') throw Error('Desktop unavailable');
  authorize();
  await promisify(execFile)(
    '/usr/bin/open',
    ['-g', '-a', app, 'codex://threads/' + s.nativeId + '?hostId=local'],
    { timeout: 5000 },
  );
}
// Recheck native delivery; opening a window or allocating a pane is not delivery readiness.
export async function waitForDestination(s: Session, authorize: () => void) {
  const until = Date.now() + 12000;
  do {
    authorize();
    if (await findCodexDestination(s.nativeId, s.sourcePath, { fresh: true })) {
      authorize();
      return true;
    }
    await new Promise((r) => setTimeout(r, 450));
  } while (Date.now() < until);
  return false;
}
/** The Codex desktop app's own CLI, for a Mac where the app is the only Codex installed. */
export const BUNDLED_CODEX = [
  '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
];
const executable = (file: string) =>
  access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
/**
 * The binary a remote summon or wake runs on this (exporting) office. Codex: the shared daemon's
 * or an installed native CLI (`defaultTerminalDeps`), then the one on PATH as local resume finds
 * it, and only then the desktop app's bundled CLI. The bundled CLI stays out of `terminals.ts`
 * `BINARIES`, so local `codex queue` and resume keep the binary they used before.
 */
export async function peerBinary(
  name: string,
  deps = {
    installed: () => defaultTerminalDeps().bin('codex'),
    onPath: (n: string) => defaultResumeDeps.binary(n),
    bundled: BUNDLED_CODEX,
  },
) {
  if (name !== 'codex') return deps.onPath(name);
  const file = deps.installed();
  if (path.isAbsolute(file) && (await executable(file))) return file;
  try {
    return await deps.onPath(name);
  } catch (e) {
    for (const app of deps.bundled) if (await executable(app)) return app;
    throw e;
  }
}
