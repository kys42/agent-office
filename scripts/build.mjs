import { build } from 'esbuild';
import { sdkImportMeta } from './node-bundle.mjs';
await build({
  entryPoints: {
    main: 'desktop/main.ts',
    preload: 'desktop/preload.ts',
    worker: 'server/worker.ts',
    mcp: 'server/mcp.ts',
    'office-peer': 'server/federation/cli.ts',
  },
  outdir: 'dist-desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  plugins: [sdkImportMeta],
  sourcemap: true,
});
