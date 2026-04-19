// Rsync push transfer: controller streams the artifact into the target
// server's release directory over SSH, bypassing HTTP pull.
//
// Flow:
//   1. Extract controller-local tar.gz to a staging dir (content-addressed).
//   2. Rsync staging/ → target:<remote_install_path>/releases/<release_id>/
//   3. Return the prestaged remote path so the deploy handler skips download.
//
// Security: the SSH key lives on disk in CONTROLLER_SSH_KEY_DIR; host keys
// are pinned via `-o UserKnownHostsFile=... -o StrictHostKeyChecking=yes`
// provided by the operator in ssh_config on the server row.

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

/**
 * @param {object} p
 * @param {object} p.server        - row from servers (must have ssh_config)
 * @param {object} p.artifact      - row from artifacts (path, sha256)
 * @param {string} p.remoteInstallPath
 * @param {string} p.releaseId
 * @param {string} p.sshKeyDir     - controller dir holding ssh keys
 * @returns {Promise<{ prestagedPath: string }>}
 */
export async function pushArtifact({ server, artifact, remoteInstallPath, releaseId, sshKeyDir }) {
  const ssh = parseSshConfig(server);

  // 1. extract to staging (ephemeral)
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), `cp-stage-${artifact.id}-`));
  try {
    await pipeline(
      createReadStream(artifact.path),
      createGunzip(),
      tar.extract(staging),
    );

    // 2. rsync — trailing slash on src copies contents into dest.
    const remoteDir = path.posix.join(remoteInstallPath, 'releases', releaseId) + '/';
    const sshOpt = buildSshOpt(ssh, sshKeyDir);

    // Ensure dest dir exists (rsync --mkpath exists in rsync ≥3.2.3; use
    // a prep ssh call for portability).
    await runSimple('ssh', [...sshOpt, sshTarget(ssh), `mkdir -p ${shellSafe(remoteDir)}`]);

    const rsyncArgs = [
      '-az',
      '--delete',
      '-e', `ssh ${sshOpt.join(' ')}`,
      `${staging}/`,
      `${sshTarget(ssh)}:${remoteDir}`,
    ];
    await runSimple('rsync', rsyncArgs, { timeoutMs: 20 * 60 * 1000 });

    logger.info({ serverId: server.id, releaseId, remoteDir }, 'rsync:pushed');
    return { prestagedPath: remoteDir };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function parseSshConfig(server) {
  const raw = server.ssh_config;
  const cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  if (!cfg.host) throw new PermanentError(`server ${server.name} has no ssh_config.host`);
  return {
    host:        cfg.host,
    user:        cfg.user ?? 'controlplane',
    port:        Number(cfg.port ?? 22),
    keyFile:     cfg.key_file ?? 'id_ed25519',
    knownHosts:  cfg.known_hosts_file,   // optional absolute path
  };
}

function buildSshOpt(ssh, sshKeyDir) {
  const keyPath = path.isAbsolute(ssh.keyFile)
    ? ssh.keyFile
    : path.join(sshKeyDir, ssh.keyFile);
  const args = [
    '-p', String(ssh.port),
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (ssh.knownHosts) {
    args.push('-o', `UserKnownHostsFile=${ssh.knownHosts}`);
  }
  return args;
}

function sshTarget(ssh) { return `${ssh.user}@${ssh.host}`; }

function shellSafe(s) {
  // Conservative: only allow filesystem-safe characters.
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
