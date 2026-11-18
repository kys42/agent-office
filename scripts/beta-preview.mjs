// Same app from a worktree, with a disposable development profile. No installed app replacement.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import electron from 'electron';
const root = path.resolve('.local/beta-preview');
mkdirSync(root, { recursive: true, mode: 0o700 });
const child = spawn(electron, ['.', `--user-data-dir=${path.join(root, 'profile')}`], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENT_OFFICE_DATA_DIR: path.join(root, 'data'),
    AGENT_OFFICE_FEDERATION_DIR: path.join(root, 'federation'),
  },
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
