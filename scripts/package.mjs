import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseArchitecture, releaseInfo } from './release-utils.mjs';
import { fixSpawnHelper } from './node-pty-helper.mjs';
import { sign } from '@electron/osx-sign';
import { assertNoPendingNotarization } from './notarize.mjs';
import {
  bundleId,
  namespaceAppExecutables,
  signingConfig,
  verifyDeveloperId,
} from './macos-signing.mjs';
if (process.platform !== 'darwin') throw new Error('macOS packaging requires a macOS host.');
const signing = signingConfig();
await assertNoPendingNotarization();
const arch = releaseArchitecture(process.env.AGENT_OFFICE_ARCH ?? process.arch);
const source = path.resolve('.local/package', arch);
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
await cp('dist', path.join(source, 'dist'), { recursive: true });
await cp('dist-desktop', path.join(source, 'dist-desktop'), { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
// The mini terminal's PTY (node-pty) is the one native module: the bundle loads it from
// node_modules. Only its runtime files for this architecture go in; its N-API prebuild runs on
// Electron without a rebuild. `.node` files and spawn-helper are unpacked from the asar below.
const ptyVersion = pkg.optionalDependencies['node-pty'];
const ptySource = 'node_modules/node-pty';
const ptyTarget = path.join(source, 'node_modules', 'node-pty');
const ptyPkg = JSON.parse(await readFile(path.join(ptySource, 'package.json'), 'utf8'));
if (ptyPkg.version !== ptyVersion) throw new Error(`node-pty ${ptyPkg.version} != ${ptyVersion}`);
await cp(path.join(ptySource, 'lib'), path.join(ptyTarget, 'lib'), {
  recursive: true,
  filter: (file) => !/\.(test\.js|map)$/.test(file),
});
await cp(
  path.join(ptySource, 'prebuilds', `darwin-${arch}`),
  path.join(ptyTarget, 'prebuilds', `darwin-${arch}`),
  { recursive: true },
);
await cp(path.join(ptySource, 'LICENSE'), path.join(ptyTarget, 'LICENSE'));
await writeFile(
  path.join(ptyTarget, 'package.json'),
  JSON.stringify(
    { name: 'node-pty', version: ptyPkg.version, license: ptyPkg.license, main: ptyPkg.main },
    null,
    2,
  ),
);
await fixSpawnHelper(ptyTarget);
const metadata = releaseInfo(pkg, arch);
metadata.signing = signing.mode;
metadata.teamId = signing.team ?? null;
metadata.channel = signing.mode === 'developer-id' ? 'signed' : 'preview';
// Embedded metadata describes signing time. The final DMG manifest and Apple's
// stapled ticket attest notarization; never edit sealed resources after signing.
metadata.notarizationStatusSource = 'stapled-ticket-and-dmg-manifest';
await writeFile(path.join(source, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(
  path.join(source, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      main: pkg.main,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      dependencies: { 'node-pty': ptyVersion },
    },
    null,
    2,
  ),
);
const result = await packager({
  dir: source,
  name: 'Agent Office',
  appBundleId: bundleId,
  appCategoryType: 'public.app-category.developer-tools',
  platform: 'darwin',
  arch,
  appVersion: pkg.version,
  electronVersion: pkg.devDependencies.electron,
  out: 'release',
  overwrite: true,
  asar: { unpack: '**/node_modules/node-pty/prebuilds/**' },
  icon: 'public/icon.icns',
  prune: true,
  extraResource: [path.join(source, 'release.json'), 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'],
  osxSign: false,
  extendInfo: {
    NSHighResolutionCapable: true,
    NSLocalNetworkUsageDescription:
      'Connect to your other Agent Office computers to show their agents and conversations.',
  },
});
for (const directory of result) {
  const app = path.join(directory, 'Agent Office.app');
  const executableUuids = await namespaceAppExecutables(app);
  await writeFile(
    path.join(app, 'Contents/Resources/release.json'),
    JSON.stringify({ ...metadata, executableUuids }, null, 2) + '\n',
  );
  await sign({
    app,
    platform: 'darwin',
    version: pkg.devDependencies.electron,
    identity: signing.identity,
    keychain: signing.keychain,
    identityValidation: signing.mode === 'developer-id',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () =>
      signing.mode === 'developer-id'
        ? { hardenedRuntime: true, entitlements: path.resolve('scripts/entitlements.mac.plist') }
        : { hardenedRuntime: false, timestamp: 'none' },
  });
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', path.join(directory, 'Agent Office.app')],
    { stdio: 'inherit' },
  );
  if (signing.mode === 'developer-id') verifyDeveloperId(app, signing.team);
}
console.log(result.join('\n'));
