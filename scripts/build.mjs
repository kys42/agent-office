import { build } from 'esbuild';
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
  // node-pty is native: loaded from node_modules (unpacked from the asar in the app).
  external: ['electron', 'node-pty'],
  sourcemap: true,
});
