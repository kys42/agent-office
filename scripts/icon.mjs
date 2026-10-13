import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The approved PNG is the source for every macOS icon representation.
if (process.platform !== 'darwin') throw new Error('ICNS generation requires macOS.');
const source = path.resolve('public/icon.png');
const temp = await mkdtemp(path.join(os.tmpdir(), 'agent-office-icon-'));
try {
  const iconset = path.join(temp, 'AgentOffice.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      execFileSync(
        'sips',
        [
          '--resampleHeightWidth',
          pixels,
          pixels,
          source,
          '--out',
          path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
        ],
        { stdio: 'ignore' },
      );
    }
  const output = path.join(temp, 'icon.icns');
  execFileSync('iconutil', ['--convert', 'icns', '--output', output, iconset]);
  await rename(output, path.resolve('public/icon.icns'));
  console.log('public/icon.icns generated from public/icon.png (16–1024px)');
} finally {
  await rm(temp, { recursive: true, force: true });
}
