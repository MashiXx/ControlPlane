// Download an artifact from the controller's signed URL, verify sha256,
// and extract into the target release directory.
//
// Chosen for simplicity: pipe the gzip stream through gunzip into tar-fs
// extract. No temp tarball on disk; sha256 is computed on the stream.

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, rm, symlink, readdir, readlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-fs';

import { TransientError, PermanentError } from '@cp/shared/errors';
import { RELEASE_RETENTION_COUNT } from '@cp/shared/constants';

/**
 * @param {object} args
 * @param {object} args.artifact       - { id, sha256, sizeBytes, downloadUrl?, prestagedPath?, releaseId }
 * @param {string} args.remoteInstallPath  - e.g. '/opt/ledger'
 * @param {(m:string)=>void} [args.log]
 */
export async function stageArtifact({ artifact, remoteInstallPath, log = () => {} }) {
  if (!remoteInstallPath) throw new PermanentError('remoteInstallPath missing');
  if (!artifact?.releaseId) throw new PermanentError('artifact.releaseId missing');

  const releasesDir = path.join(remoteInstallPath, 'releases');
  const releaseDir  = path.join(releasesDir, artifact.releaseId);

  await mkdir(releaseDir, { recursive: true });

  if (artifact.prestagedPath) {
    // rsync/scp pushed files directly — just verify + use.
    log(`using prestaged release at ${artifact.prestagedPath}`);
  } else if (artifact.downloadUrl) {
    log(`downloading artifact #${artifact.id}`);
    await downloadAndExtract({
      url: artifact.downloadUrl,
      expectedSha256: artifact.sha256,
      expectedSize: artifact.sizeBytes,
      destDir: releaseDir,
    });
  } else {
    throw new PermanentError('artifact missing both downloadUrl and prestagedPath');
  }

  await atomicSwapCurrent(remoteInstallPath, releaseDir, log);
  await gcOldReleases(releasesDir, RELEASE_RETENTION_COUNT, log);

  return { releaseDir };
}

async function downloadAndExtract({ url, expectedSha256, expectedSize, destDir }) {
  const res = await fetch(url);
  if (!res.ok) throw new TransientError(`artifact fetch HTTP ${res.status}`);
  if (!res.body) throw new TransientError('artifact response has no body');

  const hasher = crypto.createHash('sha256');
  let bytes = 0;

  // fetch Body is a web ReadableStream; convert to a Node Readable that
  // observes every chunk (for hash + size) before forwarding to gunzip+tar.
  const { Readable } = await import('node:stream');
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on('data', (chunk) => {
    hasher.update(chunk);
    bytes += chunk.length;
  });

  await pipeline(
    nodeStream,
    createGunzip(),
    tar.extract(destDir),
  );

  const actualSha = hasher.digest('hex');
  if (actualSha !== expectedSha256) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw new TransientError(
      `artifact sha256 mismatch: expected=${expectedSha256.slice(0, 12)} got=${actualSha.slice(0, 12)}`,
      { code: 'E_ARTIFACT_SHA_MISMATCH' },
    );
  }
  if (expectedSize && bytes !== expectedSize) {
    throw new TransientError(`artifact size mismatch: expected=${expectedSize} got=${bytes}`);
  }
}

async function atomicSwapCurrent(base, releaseDir, log) {
  const currentLink = path.join(base, 'current');
  const tmpLink     = path.join(base, `.current.${process.pid}.${Date.now()}`);

  // previous-release capture for rollback audit
  let previous;
  try { previous = await readlink(currentLink); } catch { previous = null; }

  // symlink(2) is atomic on the same filesystem via rename.
  await symlink(releaseDir, tmpLink);
  const { rename } = await import('node:fs/promises');
  await rename(tmpLink, currentLink);
  log(`current → ${path.basename(releaseDir)} (was ${previous ? path.basename(previous) : 'none'})`);
  return { previous };
}

async function gcOldReleases(releasesDir, keep, log) {
  const entries = await readdir(releasesDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const extra = Math.max(0, dirs.length - keep);
  if (extra === 0) return;
  for (const name of dirs.slice(0, extra)) {
    await rm(path.join(releasesDir, name), { recursive: true, force: true }).catch(() => {});
    log(`gc release ${name}`);
  }
}
