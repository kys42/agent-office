import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, X509Certificate, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { defaultDataDir } from '../store.js';
import { exportConfigSchema } from './protocol.js';
import { startExportServer } from './export-server.js';

const args = process.argv.slice(2);
const option = (key: string) => args[args.indexOf(key) + 1];
const dir = args.includes('--config-dir')
  ? option('--config-dir')
  : path.join(defaultDataDir(), 'federation-beta');
const dataDir = args.includes('--data-dir') ? option('--data-dir') : defaultDataDir();
async function main() {
  if (args.includes('--init')) {
    if (!args.includes('--host')) throw new Error('--host is required (choose a LAN interface)');
    if (existsSync(path.join(dir, 'export.json')))
      throw new Error('Configuration already exists; refusing to replace credentials');
    const config = exportConfigSchema.parse({
      enabled: true,
      officeId: randomUUID(),
      host: option('--host'),
      port: args.includes('--port') ? Number(option('--port')) : 4320,
      token: randomBytes(32).toString('hex'),
      projects: args.includes('--all-visible')
        ? ['*']
        : args.flatMap((a, i) => (a === '--project' ? [args[i + 1]] : [])),
      conversation: args.includes('--conversation'),
      allowSend: args.includes('--allow-send'),
      ...(args.includes('--allow-send') ? { sendToken: randomBytes(32).toString('hex') } : {}),
      ...(args.includes('--profile-dir') ? { profileDir: option('--profile-dir') } : {}),
    });
    if (!config.projects.length)
      throw new Error('Choose --project NAME or --all-visible explicitly');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-nodes',
        '-days',
        '365',
        '-subj',
        '/CN=Agent Office Peer',
        '-keyout',
        path.join(dir, 'server-key.pem'),
        '-out',
        path.join(dir, 'server-cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    chmodSync(path.join(dir, 'server-key.pem'), 0o600);
    const cert = new X509Certificate(readFileSync(path.join(dir, 'server-cert.pem')));
    const fingerprint = createHash('sha256').update(cert.raw).digest('hex');
    writeFileSync(path.join(dir, 'export.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    writeFileSync(
      path.join(dir, 'connection.json'),
      JSON.stringify(
        {
          officeId: config.officeId,
          endpoint: `https://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}/`,
          fingerprint,
          token: config.token,
          ...(config.sendToken ? { sendToken: config.sendToken } : {}),
          label: 'Remote Office',
          tags: [],
          projects: {},
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      'Created export.json and connection.json in the chosen directory. Keep connection.json private.',
    );
    return;
  }
  if (!args.includes('--serve'))
    throw new Error('Use --init or --serve; see docs/development/MULTI-OFFICE.md');
  const exporter = await startExportServer(dataDir, dir);
  console.log('Agent Office beta peer listening', exporter.server.address());
  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      void exporter.close().finally(() => process.exit());
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Export failed');
  process.exitCode = 1;
});
