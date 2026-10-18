import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { releaseInfo } from './release-utils.mjs';
if (process.platform !== 'win32') throw new Error('Windows packaging requires a Windows host.');
const arch = process.env.AGENT_OFFICE_ARCH ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error('Windows architecture must be x64 or arm64.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const commit = git('rev-parse', 'HEAD');
const stamp = `${commit.slice(0, 7)}${git('status', '--porcelain') ? '-dirty' : ''}`;
const source = path.resolve('.local', `windows-${arch}-${stamp}`);
await mkdir(source, { recursive: true });
for (const folder of ['dist', 'dist-desktop'])
  await cp(folder, path.join(source, folder), { recursive: true });
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
const metadata = {
  ...releaseInfo(pkg, arch),
  platform: 'win32',
  signing: 'unsigned',
  notarized: false,
};
await writeFile(path.join(source, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
const result = await packager({
  dir: source,
  name: pkg.productName,
  platform: 'win32',
  arch,
  electronVersion: pkg.devDependencies.electron,
  appVersion: pkg.version,
  out: path.resolve('release', `windows-${stamp}`),
  overwrite: false,
  asar: true,
  prune: true,
  icon: 'public/icon.ico',
  extraResource: [path.join(source, 'release.json'), 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'],
  win32metadata: {
    CompanyName: pkg.author,
    ProductName: pkg.productName,
    FileDescription: pkg.description,
  },
});
console.log(result.join('\n'));
