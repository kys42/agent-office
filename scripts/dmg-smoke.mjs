import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { releaseArchitecture, releaseStem, sha256 } from './release-utils.mjs';

const arch = releaseArchitecture(process.env.AGENT_OFFICE_ARCH ?? process.arch);
const packaged = path.resolve(`release/Agent Office-darwin-${arch}/Agent Office.app`);
const info = JSON.parse(
  await readFile(path.join(packaged, 'Contents/Resources/release.json'), 'utf8'),
);
const stem = releaseStem(info.version, arch, info.sourceCommit);
const dmg = path.resolve('release', `${stem}.dmg`);
const manifest = JSON.parse(await readFile(path.resolve('release', `${stem}.json`), 'utf8'));
assert.equal(await sha256(dmg), manifest.dmg.sha256, 'DMG checksum');
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-installed-'));
const mount = path.join(temp, 'volume');
let attached = false;
try {
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], {
    stdio: 'inherit',
  });
  attached = true;
  const installed = path.join(temp, 'Agent Office.app');
  await cp(path.join(mount, 'Agent Office.app'), installed, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const actual = JSON.parse(
    await readFile(path.join(installed, 'Contents/Resources/release.json'), 'utf8'),
  );
  assert.deepEqual(actual, info, 'Installed artifact metadata matches the package');
  execFileSync('codesign', ['--verify', '--deep', '--strict', installed], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/desktop-smoke.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_OFFICE_EXECUTABLE: path.join(installed, 'Contents/MacOS/Agent Office'),
    },
  });
  console.log(
    JSON.stringify({
      ok: true,
      installedFromDmg: true,
      sourceCommit: actual.sourceCommit,
      arch,
      signing: actual.signing,
      notarized: actual.notarized,
    }),
  );
} finally {
  if (attached) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
  await rm(temp, { recursive: true, force: true });
}
