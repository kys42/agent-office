import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
await build({
  entryPoints: {
    main: 'desktop/main.ts',
    preload: 'desktop/preload.ts',
    worker: 'server/worker.ts',
    mcp: 'server/mcp.ts',
    'office-peer': 'server/federation/cli.ts',
    'manager-runner': 'server/manager/runner.ts',
    'manager-cli': 'server/manager/cli.ts',
  },
  outdir: 'dist-desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});

await copyFile('skills/office-manager/SKILL.md', 'dist-desktop/office-manager.SKILL.md');
