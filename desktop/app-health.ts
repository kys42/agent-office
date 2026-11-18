import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildDetails, type AppHealth } from '../src/shared/app-health.js';
const run = promisify(execFile);

export async function readAppHealth(
  version: string,
  packaged: boolean,
  resources: string,
  bundle: string,
): Promise<AppHealth> {
  let metadata: unknown;
  try {
    const file = path.join(resources, 'release.json');
    if ((await stat(file)).size <= 65536) metadata = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    /* Development and older installations may have no build metadata. */
  }
  const result: AppHealth = {
    version,
    platform: process.platform,
    arch: process.arch,
    ...buildDetails(metadata),
    signature: packaged ? 'unavailable' : 'development',
    teamId: null,
  };
  if (!packaged || process.platform !== 'darwin') return result;
  result.signature = 'unverified';
  try {
    const options = { timeout: 8000, maxBuffer: 65536 };
    const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], options);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], options);
    if (/^Signature=adhoc$/m.test(stderr)) result.signature = 'ad-hoc';
    else {
      await run(
        '/usr/bin/codesign',
        [
          '--verify',
          '-R',
          '=anchor apple generic and identifier "dev.kys.agentoffice" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
          bundle,
        ],
        options,
      );
      result.signature = 'developer-id';
      result.teamId = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1] ?? null;
    }
  } catch {
    /* Do not claim a broken, timed out, or unrecognized signature is trusted. */
  }
  return result;
}
