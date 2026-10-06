import { build } from 'esbuild';
await build({
  entryPoints: {
    main: 'desktop/main.ts',
    preload: 'desktop/preload.ts',
    worker: 'server/worker.ts',
    mcp: 'server/mcp.ts',
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
