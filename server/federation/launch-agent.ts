import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

export interface PeerAgentOptions {
  runtime: string;
  bundle: string;
  configDir: string;
  dataDir: string;
  label: string;
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
/** No credentials in launchd arguments: the existing config is read at request time. */
export function peerAgentPlist(options: PeerAgentOptions) {
  if (!/^dev\.kys\.agentoffice\.[a-z0-9.-]+$/.test(options.label))
    throw new Error('Choose a dev.kys.agentoffice.* service label');
  for (const file of [options.runtime, options.bundle, options.configDir, options.dataDir])
    if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file))
      throw new Error('Absolute paths required');
  const args = [
    options.runtime,
    options.bundle,
    '--serve',
    '--config-dir',
    options.configDir,
    '--data-dir',
    options.dataDir,
  ];
  const log = path.join(options.configDir, 'peer-service.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(options.label)}</string>
<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string>
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>WorkingDirectory</key><string>${xml(options.configDir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}
/** bootout can return while launchd still holds the old registration. */
export async function waitForPeerUnload(isLoaded: () => boolean, wait = () => delay(100)) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isLoaded()) return;
    await wait();
  }
  throw new Error('Previous peer service is still unloading; try again after it stops');
}
export async function installPeerAgent(options: PeerAgentOptions) {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent installation requires macOS');
  const plist = peerAgentPlist(options);
  for (const file of [
    options.runtime,
    options.bundle,
    path.join(options.configDir, 'export.json'),
    path.join(options.configDir, 'server-cert.pem'),
    path.join(options.configDir, 'server-key.pem'),
    path.join(options.dataDir, 'office.sqlite'),
  ])
    if (!existsSync(file)) throw new Error(`Missing required file: ${file}`);
  const version = execFileSync(options.runtime, ['--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  }).trim();
  if (!/^v(\d+)\./.test(version) || Number(version.match(/^v(\d+)\./)![1]) < 24)
    throw new Error('The service runtime must provide Node 24 or newer');
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${options.label}.plist`);
  const domain = `gui/${process.getuid!()}`;
  // Require a logged-in GUI session before changing an existing job.
  execFileSync('launchctl', ['print', domain], { stdio: 'ignore' });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, plist, { mode: 0o600 });
  execFileSync('plutil', ['-lint', temporary], { stdio: 'ignore' });
  if (existsSync(file)) copyFileSync(file, `${file}.previous`);
  let loaded = false;
  try {
    execFileSync('launchctl', ['print', `${domain}/${options.label}`], { stdio: 'ignore' });
    loaded = true;
  } catch {
    /* New job. */
  }
  if (loaded) {
    execFileSync('launchctl', ['bootout', `${domain}/${options.label}`], { stdio: 'ignore' });
    await waitForPeerUnload(() => {
      try {
        execFileSync('launchctl', ['print', `${domain}/${options.label}`], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });
  }
  renameSync(temporary, file);
  try {
    execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'ignore' });
  } catch (error) {
    if (existsSync(`${file}.previous`)) {
      copyFileSync(`${file}.previous`, file);
      if (loaded) execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'ignore' });
    }
    throw error;
  }
  return { label: options.label, plist: file, startsAtLogin: true };
}
