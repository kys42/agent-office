import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function releaseArchitecture(value) {
  if (!['arm64', 'x64'].includes(value)) throw new Error('AGENT_OFFICE_ARCH must be arm64 or x64.');
  return value;
}

export function releaseStem(version, arch, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('Invalid release version.');
  releaseArchitecture(arch);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A full source commit is required.');
  return `Agent-Office-${version}-macOS-${arch}-${commit.slice(0, 7)}`;
}

export function releaseInfo(pkg, arch) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  releaseStem(pkg.version, arch, sourceCommit);
  return {
    product: pkg.productName,
    version: pkg.version,
    platform: 'darwin',
    arch,
    electronVersion: pkg.devDependencies.electron,
    sourceCommit,
    sourceBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    sourceDirty: !!git('status', '--porcelain'),
    builtAt: new Date().toISOString(),
    channel: 'preview',
    signing: 'ad-hoc',
    notarized: false,
  };
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
