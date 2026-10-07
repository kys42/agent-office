import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseArchitecture, releaseInfo } from './release-utils.mjs';
if (process.platform !== 'darwin') throw new Error('macOS packaging requires a macOS host.');
const arch = releaseArchitecture(process.env.AGENT_OFFICE_ARCH ?? process.arch);
const source = path.resolve('.local/package', arch);
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
await cp('dist', path.join(source, 'dist'), { recursive: true });
await cp('dist-desktop', path.join(source, 'dist-desktop'), { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const metadata = releaseInfo(pkg, arch);
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
    },
    null,
    2,
  ),
);
const result = await packager({
  dir: source,
  name: 'Agent Office',
  appBundleId: 'dev.kys.agentoffice',
  appCategoryType: 'public.app-category.developer-tools',
  platform: 'darwin',
  arch,
  appVersion: pkg.version,
  electronVersion: pkg.devDependencies.electron,
  out: 'release',
  overwrite: true,
  asar: true,
  icon: 'public/icon.icns',
  prune: true,
  extraResource: [path.join(source, 'release.json'), 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'],
  osxSign: {
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  },
  extendInfo: { NSHighResolutionCapable: true },
});
for (const directory of result)
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', path.join(directory, 'Agent Office.app')],
    { stdio: 'inherit' },
  );
console.log(result.join('\n'));
