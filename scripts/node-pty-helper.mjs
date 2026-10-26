// node-pty 1.1.0 publishes its macOS `spawn-helper` without the execute bit, and every spawn
// then fails with "posix_spawnp failed". Restores it after install (and before packaging).
import { realpathSync } from 'node:fs';
import { chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function fixSpawnHelper(root = 'node_modules/node-pty') {
  const fixed = [];
  for (const dir of ['prebuilds', 'build/Release']) {
    const base = path.join(root, dir);
    const entries = await readdir(base).catch(() => []);
    for (const entry of dir === 'prebuilds' ? entries : ['.']) {
      const file = path.join(base, entry, 'spawn-helper');
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      await chmod(file, 0o755);
      fixed.push(file);
    }
  }
  return fixed;
}
/**
 * Run as a script (not imported)? Compared as URLs of the real path, so a checkout under a
 * folder with spaces or non-ASCII letters, or behind a symlink (/var → /private/var), counts.
 */
export function isEntry(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
if (isEntry(import.meta.url, process.argv[1])) await fixSpawnHelper();
