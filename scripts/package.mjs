import { packager } from '@electron/packager';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const source = path.resolve('.local/package');
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
await cp('dist', path.join(source, 'dist'), { recursive: true });
await cp('dist-desktop', path.join(source, 'dist-desktop'), { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
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
  arch: 'arm64',
  electronVersion: pkg.devDependencies.electron,
  out: 'release',
  overwrite: true,
  asar: true,
  icon: 'public/icon.icns',
  prune: true,
  extendInfo: { NSHighResolutionCapable: true },
});
console.log(result.join('\n'));
