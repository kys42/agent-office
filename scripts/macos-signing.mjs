import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const bundleId = 'dev.kys.agentoffice';

export function signingConfig(env = process.env) {
  const mode = env.AGENT_OFFICE_SIGNING;
  if (!mode)
    throw new Error(
      'Choose a release: npm run release:mac -- dmg, or npm run package:preview for an explicitly temporary build.',
    );
  if (!['ad-hoc', 'developer-id'].includes(mode)) throw new Error('Invalid AGENT_OFFICE_SIGNING.');
  if (mode === 'ad-hoc') return { mode, identity: '-' };
  const identity = env.AGENT_OFFICE_SIGN_IDENTITY;
  const team = env.AGENT_OFFICE_TEAM_ID;
  if (
    !identity?.startsWith('Developer ID Application: ') ||
    !/^[A-Z0-9]{10}$/.test(team ?? '') ||
    !identity.endsWith(`(${team})`)
  ) {
    throw new Error(
      'Developer ID Application identity and matching AGENT_OFFICE_TEAM_ID required.',
    );
  }
  return { mode, identity, team, keychain: env.AGENT_OFFICE_SIGN_KEYCHAIN };
}

// Packager reuses Electron's executable. Namespace its LC_UUID before signing so
// macOS does not confuse our app with a different Electron app (Apple TN3178/3179).
// Separate arm64/x64 packages only; reject unsupported or malformed Mach-O input.
export function namespaceMachOUuid(input, identifier) {
  const bytes = Buffer.from(input);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error('Expected a thin little-endian 64-bit Mach-O executable.');
  const count = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  if (end > bytes.length) throw new Error('Truncated Mach-O load commands.');
  let offset = 32;
  let uuidOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) throw new Error('Truncated Mach-O command.');
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 || offset + size > end) throw new Error('Invalid Mach-O command.');
    if (command === 0x1b) {
      if (size !== 24 || uuidOffset !== undefined) throw new Error('Invalid or duplicate LC_UUID.');
      uuidOffset = offset + 8;
    }
    offset += size;
  }
  if (offset !== end || uuidOffset === undefined)
    throw new Error('Missing LC_UUID or invalid table.');
  const original = bytes.subarray(uuidOffset, uuidOffset + 16).toString('hex');
  const uuid = createHash('sha256').update(`${identifier}:${original}`).digest().subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x80;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  uuid.copy(bytes, uuidOffset);
  return { bytes, original, uuid: uuid.toString('hex') };
}

export async function namespaceAppExecutables(app) {
  const mappings = [];
  async function visit(bundle) {
    const plist = path.join(bundle, 'Contents/Info.plist');
    const get = (key) =>
      execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
        encoding: 'utf8',
      }).trim();
    const identifier = get('CFBundleIdentifier');
    const executable = path.join(bundle, 'Contents/MacOS', get('CFBundleExecutable'));
    const result = namespaceMachOUuid(await readFile(executable), identifier);
    await writeFile(executable, result.bytes);
    mappings.push({ identifier, original: result.original, uuid: result.uuid });
    for (const directory of ['Contents/Frameworks', 'Contents/Library/LoginItems']) {
      const entries = await readdir(path.join(bundle, directory), { withFileTypes: true }).catch(
        (error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      for (const entry of entries)
        if (entry.isDirectory() && entry.name.endsWith('.app'))
          await visit(path.join(bundle, directory, entry.name));
    }
  }
  await visit(app);
  return mappings;
}

export function verifyDeveloperId(app, team) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  // Verify the certificate class, Apple trust chain, bundle ID and Team ID,
  // rather than accepting any valid (including ad-hoc) signature.
  const requirement = `anchor apple generic and identifier "${bundleId}" and certificate leaf[subject.OU] = "${team}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
  execFileSync('codesign', ['--verify', '-R', `=${requirement}`, app], { stdio: 'inherit' });
}
