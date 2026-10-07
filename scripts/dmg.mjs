import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { releaseArchitecture, releaseStem, sha256 } from './release-utils.mjs';

if (process.platform !== 'darwin') throw new Error('DMG creation requires macOS and hdiutil.');
const arch = releaseArchitecture(process.env.AGENT_OFFICE_ARCH ?? process.arch);
const app = path.resolve(`release/Agent Office-darwin-${arch}/Agent Office.app`);
const metadata = JSON.parse(
  await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8'),
);
if (metadata.arch !== arch) throw new Error('Packaged app architecture does not match the DMG.');
const stem = releaseStem(metadata.version, arch, metadata.sourceCommit);
const output = path.resolve('release', `${stem}.dmg`);
const stage = await mkdtemp(path.join(os.tmpdir(), 'agent-office-dmg-'));
try {
  await cp(app, path.join(stage, 'Agent Office.app'), { recursive: true, verbatimSymlinks: true });
  await symlink('/Applications', path.join(stage, 'Applications'));
  await cp('docs/INSTALL-MAC.txt', path.join(stage, 'INSTALL.txt'));
  await cp('LICENSE.md', path.join(stage, 'LICENSE.md'));
  await cp('THIRD_PARTY_NOTICES.md', path.join(stage, 'THIRD_PARTY_NOTICES.md'));
  await mkdir(path.dirname(output), { recursive: true });
  await rm(output, { force: true });
  execFileSync(
    'hdiutil',
    [
      'create',
      '-volname',
      'Agent Office',
      '-srcfolder',
      stage,
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      output,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('hdiutil', ['verify', output], { stdio: 'inherit' });
  const manifest = `${stem}.json`;
  await writeFile(
    path.resolve('release', manifest),
    JSON.stringify(
      {
        ...metadata,
        dmg: {
          file: path.basename(output),
          bytes: (await stat(output)).size,
          sha256: await sha256(output),
        },
      },
      null,
      2,
    ) + '\n',
  );
  const checksum = await sha256(path.resolve('release', manifest));
  await writeFile(
    path.resolve('release', `SHA256SUMS-${arch}.txt`),
    `${await sha256(output)}  ${path.basename(output)}\n${checksum}  ${manifest}\n`,
  );
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
