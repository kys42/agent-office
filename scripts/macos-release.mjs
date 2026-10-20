import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { signingConfig } from './macos-signing.mjs';
import { notaryCredentials } from './notarize.mjs';

// Accept the existing TaskDeck/banryeojusik non-secret Apple profile schema.
// Keep keys in their original private location; do not copy them into this repo.
const mode = process.argv[2] ?? 'preflight';
if (!['preflight', 'app', 'dmg', 'resume'].includes(mode)) throw new Error('Invalid release mode.');
if (process.platform !== 'darwin') throw new Error('macOS required.');
const env = { ...process.env, AGENT_OFFICE_SIGNING: 'developer-id' };
if (env.AGENT_OFFICE_APPLE_PROFILE) {
  const profile = JSON.parse(readFileSync(env.AGENT_OFFICE_APPLE_PROFILE, 'utf8'));
  const allowed = [
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_PATH',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_TEAM_ID',
  ];
  if (
    Object.keys(profile).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => typeof profile[key] !== 'string' || !profile[key])
  )
    throw new Error('Invalid Apple release profile.');
  env.AGENT_OFFICE_SIGN_IDENTITY ??= profile.APPLE_SIGNING_IDENTITY;
  env.AGENT_OFFICE_TEAM_ID ??= profile.APPLE_TEAM_ID;
  for (const key of ['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH'])
    env[key] ??= profile[key].replace(/^\$\{HOME\}(?=\/)/, homedir());
}
const config = signingConfig(env);
const identities = execFileSync(
  'security',
  ['find-identity', '-v', '-p', 'codesigning', ...(config.keychain ? [config.keychain] : [])],
  { encoding: 'utf8' },
);
if (!identities.includes(`"${config.identity}"`)) throw new Error('Signing identity unavailable.');
if (env.APPLE_API_KEY_PATH && !env.AGENT_OFFICE_NOTARY_PROFILE) {
  const key = realpathSync(env.APPLE_API_KEY_PATH);
  const relative = path.relative(realpathSync('.'), key);
  const stat = statSync(key);
  if (
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)) ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077
  )
    throw new Error('Apple API key must be a private regular file outside the repository.');
  env.APPLE_API_KEY_PATH = key;
}
if (mode !== 'app') {
  // Read-only authentication probe: fail before building/uploading on expired agreements.
  execFileSync(
    'xcrun',
    ['notarytool', 'history', ...notaryCredentials(env), '--output-format', 'json'],
    { stdio: ['ignore', 'ignore', 'inherit'], env },
  );
  console.log('Developer ID and Apple notarization access verified.');
}
if (mode !== 'preflight') {
  const args =
    mode === 'resume' ? ['scripts/dmg.mjs'] : ['run', mode === 'app' ? 'package' : 'package:dmg'];
  execFileSync(mode === 'resume' ? process.execPath : 'npm', args, { env, stdio: 'inherit' });
}
