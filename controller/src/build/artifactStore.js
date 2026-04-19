// On-disk artifact storage.
// Layout:
//   ARTIFACT_STORE_DIR/
//     <appId>/
//       <sha256>.tar.gz     ← immutable; dedup by content hash
// Files are chmod 0600 and served only via signed token URLs.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class ArtifactStore {
  constructor({ baseDir }) {
    if (!baseDir) throw new Error('ArtifactStore: baseDir required');
    this.baseDir = baseDir;
  }

  async ensure() {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  pathFor({ applicationId, sha256 }) {
    return path.join(this.baseDir, String(applicationId), `${sha256}.tar.gz`);
  }

  async exists(desc) {
    try { await fs.stat(this.pathFor(desc)); return true; }
    catch { return false; }
  }

  /**
   * Move a file built in a temp location into the content-addressed store.
   * Returns { path, sha256, sizeBytes }.
   */
  async ingest({ applicationId, sourcePath }) {
    const { sha256, sizeBytes } = await hashFile(sourcePath);
    const finalPath = this.pathFor({ applicationId, sha256 });
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    try { await fs.rename(sourcePath, finalPath); }
    catch (err) {
      if (err.code === 'EXDEV') {
        // cross-device: fall back to copy
        await fs.copyFile(sourcePath, finalPath);
        await fs.unlink(sourcePath).catch(() => {});
      } else if (err.code === 'EEXIST') {
        // already ingested (dedup hit) — discard source
        await fs.unlink(sourcePath).catch(() => {});
      } else {
        throw err;
      }
    }
    await fs.chmod(finalPath, 0o600).catch(() => {});
    return { path: finalPath, sha256, sizeBytes };
  }

  async unlink(desc) {
    try { await fs.unlink(this.pathFor(desc)); } catch { /* noop */ }
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const { createReadStream, statSync } = await import('node:fs');
  await new Promise((resolve, reject) => {
    const s = createReadStream(filePath);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('end',  resolve);
    s.on('error', reject);
  });
  return { sha256: hash.digest('hex'), sizeBytes: statSync(filePath).size };
}
