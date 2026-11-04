import { execFileSync } from 'node:child_process';

const mode = process.argv[2];
if (!['app', 'dmg'].includes(mode)) throw new Error('Expected app or dmg.');
console.warn(
  'TEMPORARY PREVIEW: ad-hoc signing does not preserve Developer ID identity. Do not replace a signed installation with this build.',
);
const env = { ...process.env, AGENT_OFFICE_SIGNING: 'ad-hoc' };
execFileSync('npm', ['run', 'package'], { env, stdio: 'inherit' });
if (mode === 'dmg') execFileSync(process.execPath, ['scripts/dmg.mjs'], { env, stdio: 'inherit' });
