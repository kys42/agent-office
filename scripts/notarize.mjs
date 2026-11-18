import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './release-utils.mjs';

export function notaryCredentials(env = process.env) {
  if (env.AGENT_OFFICE_NOTARY_PROFILE)
    return [
      '--keychain-profile',
      env.AGENT_OFFICE_NOTARY_PROFILE,
      ...(env.AGENT_OFFICE_SIGN_KEYCHAIN ? ['--keychain', env.AGENT_OFFICE_SIGN_KEYCHAIN] : []),
    ];
  if (env.APPLE_API_KEY_PATH && env.APPLE_API_KEY && env.APPLE_API_ISSUER)
    return [
      '--key',
      env.APPLE_API_KEY_PATH,
      '--key-id',
      env.APPLE_API_KEY,
      '--issuer',
      env.APPLE_API_ISSUER,
    ];
  throw new Error(
    'Signed DMG requires a notarytool keychain profile or existing Apple Team API profile.',
  );
}

const receiptDirectory = () => path.resolve('.local/notary');
const artifactKey = (artifact) => {
  const resolved = path.join(
    realpathSync(path.dirname(path.resolve(artifact))),
    path.basename(artifact),
  );
  const relative = path.relative(process.cwd(), resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Notarization artifact must be inside the release checkout.');
  return relative;
};
const receiptPath = (artifact, context) =>
  path.join(
    receiptDirectory(),
    createHash('sha256')
      .update(`${artifactKey(artifact)}:${context}`)
      .digest('hex') + '.json',
  );
async function readReceipt(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function saveReceipt(file, receipt) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + '.tmp', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}
async function fingerprint(artifact, isApp) {
  if (!isApp) return sha256(artifact);
  // Stapling does not modify sealed app resources or its main executable.
  return createHash('sha256')
    .update(await sha256(path.join(artifact, 'Contents/_CodeSignature/CodeResources')))
    .update(await sha256(path.join(artifact, 'Contents/MacOS/Agent Office')))
    .digest('hex');
}
export async function assertNoPendingNotarization() {
  const files = await readdir(receiptDirectory()).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of files.filter((name) => name.endsWith('.json'))) {
    const receipt = await readReceipt(path.join(receiptDirectory(), name));
    if (!receipt.stapled)
      throw new Error(
        `Unfinished notarization receipt ${name}. Resume the existing build; do not overwrite it.`,
      );
  }
}
export async function canResumeDmg(artifact, context) {
  const receipt = await readReceipt(receiptPath(artifact, context));
  if (!receipt) return false;
  const digest = await sha256(artifact);
  if (![receipt.submittedFingerprint, receipt.stapledFingerprint].includes(digest))
    throw new Error(
      'Saved DMG receipt does not match artifact bytes. Preserve it and investigate.',
    );
  return true;
}

export async function notarizeArtifact(artifact, isApp = false, context = '', run = execFileSync) {
  const credentials = notaryCredentials();
  const file = receiptPath(artifact, context);
  const digest = await fingerprint(artifact, isApp);
  let receipt = await readReceipt(file);
  if (receipt && ['Invalid', 'Rejected'].includes(receipt.status))
    throw new Error(
      `Notarization ${receipt.status}: inspect log for ${receipt.id}, preserve this receipt, then fix and build a new artifact.`,
    );
  if (receipt && ![receipt.submittedFingerprint, receipt.stapledFingerprint].includes(digest))
    throw new Error('Notarization receipt provenance mismatch. Do not resubmit blindly.');
  if (receipt && !receipt.id)
    throw new Error(
      `Submission outcome unknown: reconcile Apple history and receipt ${file} before retrying.`,
    );
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'office-notary-'));
  try {
    if (!receipt) {
      let submission = artifact;
      if (isApp) {
        submission = path.join(temporary, 'Agent-Office.zip');
        run('ditto', ['-c', '-k', '--keepParent', artifact, submission], { stdio: 'inherit' });
      }
      receipt = {
        artifact: artifactKey(artifact),
        context,
        submittedFingerprint: digest,
        submittedAt: new Date().toISOString(),
        status: 'Submitting',
        id: null,
        stapled: false,
      };
      await saveReceipt(file, receipt);
      const submitted = JSON.parse(
        run(
          'xcrun',
          ['notarytool', 'submit', submission, ...credentials, '--output-format', 'json'],
          { encoding: 'utf8', timeout: 20 * 60 * 1000 },
        ),
      );
      if (!submitted.id)
        throw new Error('Missing submission ID. Reconcile Apple history before retrying.');
      receipt.id = submitted.id;
      receipt.status = 'Submitted';
      await saveReceipt(file, receipt);
    }
    if (receipt.status !== 'Accepted') {
      // ID is already durable if wait times out or this process is interrupted.
      const result = JSON.parse(
        run(
          'xcrun',
          [
            'notarytool',
            'wait',
            receipt.id,
            ...credentials,
            '--timeout',
            '20m',
            '--output-format',
            'json',
          ],
          { encoding: 'utf8', timeout: 21 * 60 * 1000 },
        ),
      );
      receipt.status = result.status ?? 'Unknown';
      await saveReceipt(file, receipt);
      if (result.status !== 'Accepted')
        throw new Error(
          `Apple notarization ${receipt.status}; submission ${receipt.id}. Inspect with notarytool log.`,
        );
    }
    if (!receipt.stapled) run('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' });
    run('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit' });
    receipt.stapled = true;
    receipt.stapledFingerprint = await fingerprint(artifact, isApp);
    await saveReceipt(file, receipt);
    return receipt.id;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
