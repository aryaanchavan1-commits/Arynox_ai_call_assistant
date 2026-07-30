import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadMatchedArtifactManifest, parseMatchedArtifactManifest } from '../src/matched-artifact.js';

const root = new URL('../../../', import.meta.url);

test('Node and package inputs consume exact canonical device-neutral manifest bytes', async () => {
  const canonical = await readFile(new URL('protocol/matched-artifact.properties', root));
  const android = await readFile(new URL('app/src/main/res/raw/matched_artifact.properties', root));
  const linux = await readFile(new URL('packaging/linux/matched-artifact.properties', root));
  assert.deepEqual(android, canonical);
  assert.deepEqual(linux, canonical);

  const dir = await mkdtemp(join(tmpdir(), 'agentcall-canonical-manifest-'));
  try {
    const installed = join(dir, 'matched-artifact.properties');
    await writeFile(installed, canonical, { mode: 0o644 });
    const loaded = await loadMatchedArtifactManifest(installed, {
      expectedUid: process.getuid?.(), expectedGid: process.getgid?.(),
    });
    assert.equal(loaded.manifest.schemaVersion, 1);
    assert.equal(loaded.manifest.bootstrapProtocolVersion, 1);
    assert.equal(loaded.manifest.desktopPackageVersion, '0.2.5');
    assert.equal(loaded.manifest.androidPackageName, 'com.callagent.gateway');
    assert.equal(loaded.manifest.androidVersionCode, 332);
    assert.equal(loaded.manifest.androidSigningCertificateSha256.length, 64);
    assert.equal(loaded.digest.length, 32);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manifest loader rejects hard-linked package inputs', async () => {
  const canonical = await readFile(new URL('protocol/matched-artifact.properties', root));
  const dir = await mkdtemp(join(tmpdir(), 'agentcall-manifest-'));
  try {
    const file = join(dir, 'manifest.properties');
    await writeFile(file, canonical, { mode: 0o644 });
    const hard = join(dir, 'hard.properties');
    await link(file, hard);
    const ownership = { expectedUid: process.getuid?.(), expectedGid: process.getgid?.() };
    await assert.rejects(() => loadMatchedArtifactManifest(hard, ownership), /link|safe/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manifest loader rejects symlink package inputs', { skip: process.platform === 'win32' }, async () => {
  const canonical = await readFile(new URL('protocol/matched-artifact.properties', root));
  const dir = await mkdtemp(join(tmpdir(), 'agentcall-manifest-symlink-'));
  try {
    const file = join(dir, 'manifest.properties');
    const symbolic = join(dir, 'symbolic.properties');
    await writeFile(file, canonical, { mode: 0o644 });
    await symlink(file, symbolic);
    await assert.rejects(
      () => loadMatchedArtifactManifest(symbolic, { expectedUid: process.getuid?.(), expectedGid: process.getgid?.() }),
      /symlink|regular|safe/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manifest parser rejects unknown duplicate missing private and self-digest fields', async () => {
  const canonical = await readFile(new URL('protocol/matched-artifact.properties', root));
  const text = canonical.toString('ascii');
  for (const forbidden of ['adbSerial', 'serial', 'fingerprint', 'controller', 'salt', 'credential', 'artifactManifestSha256', 'privateKey', 'sharedSecret']) {
    assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, `manifest leaked ${forbidden}`);
  }
  assert.throws(() => parseMatchedArtifactManifest(Buffer.concat([canonical, Buffer.from('unknown=value\n')])));
  assert.throws(() => parseMatchedArtifactManifest(Buffer.concat([canonical, Buffer.from('schemaVersion=1\n')])));
  assert.throws(() => parseMatchedArtifactManifest(Buffer.from(text.replace('schemaVersion=1\n', ''))));
  assert.throws(() => parseMatchedArtifactManifest(Buffer.from(text.replace('androidVersionCode=332', 'androidVersionCode=0332'))));
  assert.throws(() => parseMatchedArtifactManifest(Buffer.from(text.replace('androidVersionCode=332', 'androidVersionCode=999999999999999999999999'))));
  assert.throws(() => parseMatchedArtifactManifest(Buffer.from(text.replace('desktopPackageVersion=0.2.5', 'desktopPackageVersion=00.2.5'))));
  assert.throws(() => parseMatchedArtifactManifest(Buffer.from(text.replace(/androidSigningCertificateSha256=[0-9a-f]{64}/, `androidSigningCertificateSha256=${'0'.repeat(64)}`))));
});
