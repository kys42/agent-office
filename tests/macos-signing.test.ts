import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Plain Node packaging helpers.
import { namespaceMachOUuid, signingConfig } from '../scripts/macos-signing.mjs';
// @ts-expect-error Plain Node packaging helpers.
import * as notary from '../scripts/notarize.mjs';
const { notaryCredentials, notarizeArtifact, canResumeDmg, assertNoPendingNotarization } = notary;

test('Developer ID configuration fails closed instead of falling back to ad-hoc', () => {
  assert.throws(() => signingConfig({}), /Choose a release/);
  assert.equal(signingConfig({ AGENT_OFFICE_SIGNING: 'ad-hoc' }).mode, 'ad-hoc');
  for (const env of [
    { AGENT_OFFICE_SIGNING: 'typo' },
    { AGENT_OFFICE_SIGNING: 'developer-id' },
    { AGENT_OFFICE_SIGNING: 'developer-id', AGENT_OFFICE_SIGN_IDENTITY: '-' },
    {
      AGENT_OFFICE_SIGNING: 'developer-id',
      AGENT_OFFICE_SIGN_IDENTITY: 'Developer ID Application: Example (ABCDEFGHIJ)',
      AGENT_OFFICE_TEAM_ID: 'DIFFERENTX',
    },
  ])
    assert.throws(() => signingConfig(env));
  assert.equal(
    signingConfig({
      AGENT_OFFICE_SIGNING: 'developer-id',
      AGENT_OFFICE_SIGN_IDENTITY: 'Developer ID Application: Example (ABCDEFGHIJ)',
      AGENT_OFFICE_TEAM_ID: 'ABCDEFGHIJ',
    }).team,
    'ABCDEFGHIJ',
  );
  assert.throws(() => notaryCredentials({}));
  assert.deepEqual(notaryCredentials({ AGENT_OFFICE_NOTARY_PROFILE: 'office' }), [
    '--keychain-profile',
    'office',
  ]);
});

test('Notarization resumes the saved submission after timeout and never labels rejection as success', async () => {
  const cwd = process.cwd();
  const profile = process.env.AGENT_OFFICE_NOTARY_PROFILE;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-notary-test-'));
  process.chdir(temp);
  process.env.AGENT_OFFICE_NOTARY_PROFILE = 'synthetic-profile';
  try {
    const artifact = path.join(temp, 'test.dmg');
    await writeFile(artifact, 'synthetic dmg');
    let submissions = 0;
    let waits = 0;
    let staples = 0;
    const run = (_command: string, args: string[]) => {
      if (args[0] === 'notarytool' && args[1] === 'submit') {
        submissions++;
        return JSON.stringify({ id: 'synthetic-id' });
      }
      if (args[0] === 'notarytool' && args[1] === 'wait') {
        assert.equal(args[2], 'synthetic-id');
        if (++waits === 1) throw new Error('simulated timeout');
        return JSON.stringify({ status: 'Accepted' });
      }
      if (args[0] === 'stapler' && args[1] === 'staple') {
        staples++;
        appendFileSync(artifact, 'stapled ticket');
      }
      return '';
    };
    await assert.rejects(notarizeArtifact(artifact, false, 'build1', run), /timeout/);
    await assert.rejects(assertNoPendingNotarization(), /Unfinished/);
    assert.equal(await canResumeDmg(artifact, 'build1'), true);
    assert.equal(await notarizeArtifact(artifact, false, 'build1', run), 'synthetic-id');
    await assertNoPendingNotarization();
    assert.equal(await canResumeDmg(artifact, 'build1'), true);
    await notarizeArtifact(artifact, false, 'build1', run);
    assert.equal(submissions, 1);
    assert.equal(staples, 1);
    await writeFile(artifact, 'tampered');
    await assert.rejects(canResumeDmg(artifact, 'build1'), /does not match/);
    const rejected = path.join(temp, 'rejected.dmg');
    await writeFile(rejected, 'rejected');
    await assert.rejects(
      notarizeArtifact(rejected, false, 'build2', (_command: string, args: string[]) => {
        assert.equal(args[0], 'notarytool', 'rejected artifact is never stapled');
        return JSON.stringify(args[1] === 'submit' ? { id: 'rejected-id' } : { status: 'Invalid' });
      }),
      /Invalid/,
    );
    const uncertain = path.join(temp, 'uncertain.dmg');
    await writeFile(uncertain, 'unknown outcome');
    await assert.rejects(
      notarizeArtifact(uncertain, false, 'build3', () => {
        throw new Error('connection lost');
      }),
      /connection lost/,
    );
    await assert.rejects(
      notarizeArtifact(uncertain, false, 'build3', () => {
        throw new Error('must not resubmit');
      }),
      /outcome unknown/,
    );
  } finally {
    process.chdir(cwd);
    if (profile === undefined) delete process.env.AGENT_OFFICE_NOTARY_PROFILE;
    else process.env.AGENT_OFFICE_NOTARY_PROFILE = profile;
    await rm(temp, { recursive: true, force: true });
  }
});

function macho() {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.fill(7, 40, 56);
  return bytes;
}

test('Mach-O identity patch is deterministic, app-specific and changes only LC_UUID bytes', () => {
  const original = macho();
  const result = namespaceMachOUuid(original, 'dev.kys.agentoffice');
  assert.notEqual(result.uuid, result.original);
  assert.equal(result.uuid, namespaceMachOUuid(original, 'dev.kys.agentoffice').uuid);
  assert.notEqual(result.uuid, namespaceMachOUuid(original, 'dev.kys.other').uuid);
  assert.deepEqual(result.bytes.subarray(0, 40), original.subarray(0, 40));
  assert.deepEqual(result.bytes.subarray(56), original.subarray(56));
  assert.deepEqual(original, macho(), 'input remains unchanged');
});

test('Mach-O identity patch rejects missing, truncated and duplicate UUID load commands', () => {
  for (const bad of [Buffer.alloc(0), Buffer.alloc(64), macho().subarray(0, 48)])
    assert.throws(() => namespaceMachOUuid(bad, 'app'));
  for (const [offset, value] of [
    [16, 2],
    [20, 200],
    [32, 1],
    [36, 0],
    [36, 32],
  ]) {
    const bad = macho();
    bad.writeUInt32LE(value, offset);
    assert.throws(() => namespaceMachOUuid(bad, 'app'));
  }
  const duplicate = Buffer.alloc(80);
  macho().copy(duplicate);
  duplicate.writeUInt32LE(2, 16);
  duplicate.writeUInt32LE(48, 20);
  duplicate.writeUInt32LE(0x1b, 56);
  duplicate.writeUInt32LE(24, 60);
  assert.throws(() => namespaceMachOUuid(duplicate, 'app'));
});
