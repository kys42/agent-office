import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { remoteCodexHost } from './codex-desktop.js';

type Run = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<unknown>;
function verifiedRemoteLink(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'codex:' ||
    url.hostname !== 'threads' ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname) ||
    [...url.searchParams.keys()].some((k) => k !== 'hostId') ||
    url.searchParams.getAll('hostId').length !== 1 ||
    !remoteCodexHost(url.searchParams.get('hostId') ?? '')
  )
    throw Error('Unsupported remote conversation link');
  return url.toString();
}

/** Only used after an explicit send and authorization; no text or approval settings in links. */
export function codexConversationOpener(
  platform: NodeJS.Platform = process.platform,
  run: Run = promisify(execFile),
  home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
): ((url: string) => Promise<void>) | undefined {
  if (platform === 'darwin')
    return async (value) => {
      await run('/usr/bin/open', [verifiedRemoteLink(value)], { timeout: 5000, windowsHide: true });
    };
  if (platform !== 'win32') return undefined;
  const current = path.resolve(os.homedir(), '.codex').toLowerCase();
  if (
    path.resolve(home).toLowerCase() !== current ||
    (process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME).toLowerCase() !== current)
  )
    return undefined;
  return async (value) => {
    const encoded = Buffer.from(verifiedRemoteLink(value), 'utf8').toString('base64');
    const script = `$ErrorActionPreference='Stop'; $start=New-Object System.Diagnostics.ProcessStartInfo; $start.FileName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $start.UseShellExecute=$true; [void][Diagnostics.Process]::Start($start)`;
    const shell = path.win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    await run(
      shell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: 5000, windowsHide: true },
    );
  };
}
