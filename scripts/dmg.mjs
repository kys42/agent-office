import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { releaseArchitecture, releaseStem, sha256 } from './release-utils.mjs';
import { signingConfig, verifyDeveloperId } from './macos-signing.mjs';
import { notarizeArtifact, notaryCredentials, canResumeDmg } from './notarize.mjs';

if (process.platform !== 'darwin') throw new Error('DMG creation requires macOS and hdiutil.');
const arch = releaseArchitecture(process.env.AGENT_OFFICE_ARCH ?? process.arch);
const app = path.resolve(`release/Agent Office-darwin-${arch}/Agent Office.app`);
const metadata = JSON.parse(
  await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8'),
);
const signing = signingConfig();
if (metadata.signing !== signing.mode) throw new Error('Signing mode differs from packaged app.');
const context = await sha256(path.join(app, 'Contents/Resources/release.json'));
let appSubmission;
if (signing.mode === 'developer-id') {
  notaryCredentials();
  if (metadata.sourceDirty) throw new Error('Signed DMG requires a clean committed source tree.');
  if (metadata.teamId !== signing.team) throw new Error('Signing team differs from packaged app.');
  verifyDeveloperId(app, signing.team);
  appSubmission = await notarizeArtifact(app, true, context);
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], {
    stdio: 'inherit',
  });
}
if (metadata.arch !== arch) throw new Error('Packaged app architecture does not match the DMG.');
const stem = releaseStem(metadata.version, arch, metadata.sourceCommit);
const output = path.resolve('release', `${stem}.dmg`);
const stage = await mkdtemp(path.join(os.tmpdir(), 'agent-office-dmg-'));
try {
  await cp(app, path.join(stage, 'Agent Office.app'), { recursive: true, verbatimSymlinks: true });
  await symlink('/Applications', path.join(stage, 'Applications'));
  await cp(
    signing.mode === 'developer-id' ? 'docs/INSTALL-MAC-SIGNED.txt' : 'docs/INSTALL-MAC.txt',
    path.join(stage, 'INSTALL.txt'),
  );
  await cp('LICENSE.md', path.join(stage, 'LICENSE.md'));
  await cp('THIRD_PARTY_NOTICES.md', path.join(stage, 'THIRD_PARTY_NOTICES.md'));
  await mkdir(path.dirname(output), { recursive: true });
  const resumeDmg = signing.mode === 'developer-id' && (await canResumeDmg(output, context));
  if (!resumeDmg) {
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
  }
  execFileSync('hdiutil', ['verify', output], { stdio: 'inherit' });
  let dmgSubmission;
  if (signing.mode === 'developer-id') {
    if (!resumeDmg)
      execFileSync(
        'codesign',
        [
          '--sign',
          signing.identity,
          '--timestamp',
          ...(signing.keychain ? ['--keychain', signing.keychain] : []),
          output,
        ],
        { stdio: 'inherit' },
      );
    dmgSubmission = await notarizeArtifact(output, false, context);
    execFileSync(
      'spctl',
      [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=2',
        output,
      ],
      { stdio: 'inherit' },
    );
  }
  const manifest = `${stem}.json`;
  await writeFile(
    path.resolve('release', manifest),
    JSON.stringify(
      {
        ...metadata,
        notarized: !!dmgSubmission,
        ...(dmgSubmission ? { notarization: { appSubmission, dmgSubmission } } : {}),
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
