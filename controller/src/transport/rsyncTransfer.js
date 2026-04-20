// Rsync push transfer: controller streams the artifact into the target
// server's release directory over SSH.
//
// The `hostname` column is passed as-is to `ssh` and `rsync`, so
// everything else — User, Port, IdentityFile, ProxyJump, StrictHostKeyChecking,
// UserKnownHostsFile — is read from the controller's ~/.ssh/config.
//
// Flow:
//   1. Extract controller-local tar.gz to a staging dir (content-addressed).
//   2. `ssh <hostname> mkdir -p …`   (dest dir, portable — avoids requiring rsync ≥3.2.3)
//   3. `rsync -az --delete staging/ <hostname>:<remote_install_path>/releases/<release_id>/`
//   4. Return the prestaged remote path so the deploy handler skips download.
//
// Hardening we enforce regardless of ~/.ssh/config:
//   -o BatchMode=yes       — never prompt; this is a background job
//   -o ConnectTimeout=10   — fail fast when the target is unreachable

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-fs';

import { PermanentError, TransientError } from '@cp/shared/errors';
import { createLogger } from '@cp/shared/logger';

const logger = createLogger({ service: 'transport.rsync' });

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

/**
 * @param {object} p
 * @param {object} p.server            - row from servers (needs .hostname, .name, .id)
 * @param {object} p.artifact          - row from artifacts (path, sha256, id)
 * @param {string} p.remoteInstallPath
 * @param {string} p.releaseId
 * @returns {Promise<{ prestagedPath: string }>}
 */
export async function pushArtifact({ server, artifact, remoteInstallPath, releaseId }) {
  const target = server.hostname;
  if (!target) throw new PermanentError(`server ${server.name} has no hostname`);

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), `cp-stage-${artifact.id}-`));
  try {
    await pipeline(
      createReadStream(artifact.path),
      createGunzip(),
      tar.extract(staging),
    );

    const remoteDir = path.posix.join(remoteInstallPath, 'releases', releaseId) + '/';

    await runSimple('ssh', [...SSH_OPTS, target, `mkdir -p ${shellSafe(remoteDir)}`]);

    await runSimple('rsync', [
      '-az', '--delete',
      '-e', `ssh ${SSH_OPTS.join(' ')}`,
      `${staging}/`,
      `${target}:${remoteDir}`,
    ], { timeoutMs: 20 * 60 * 1000 });

    logger.info({ serverId: server.id, releaseId, remoteDir }, 'rsync:pushed');
    return { prestagedPath: remoteDir };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function shellSafe(s) {
  if (!/^[\w@%+=:,./-]+$/.test(s)) throw new PermanentError(`unsafe remote path: ${s}`);
  return s;
}

function runSimple(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new TransientError(`${cmd} timeout`));
    }, timeoutMs);
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new TransientError(`${cmd} exit=${code}: ${stderr.slice(-512)}`,
        { code: 'E_RSYNC_FAILED', meta: { exitCode: code, stderr: stderr.slice(-2048) } }));
    });
  });
}
