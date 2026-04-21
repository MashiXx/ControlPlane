// Runs on the controller host. Clones the app repo at `branch` (or at a
// specific commit), runs install + build, collects files matching
// `artifact_pattern`, tar.gz's them, and ingests into the ArtifactStore.
//
// Each build uses an isolated workdir; the workdir is removed after the
// tarball is written so sensitive files (e.g., .npmrc from install) don't
// linger.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { glob } from 'glob';                   // portable glob (Node 20+)
import tar from 'tar-fs';                      // lightweight streaming tar

import { PermanentError, TransientError } from '@cp/shared/errors';
import { createLogger } from '@cp/shared/logger';

const logger = createLogger({ service: 'builder' });

const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS ?? 30 * 60 * 1000);

/**
 * @param {object} input
 * @param {object} input.app             — row from applications
 * @param {object} input.store           — ArtifactStore
 * @param {object} input.artifactRepo    — repositories.artifacts
 * @param {number} input.buildJobDbId    — jobs.id row for this build
 * @param {(chunk: Buffer, stream: 'stdout'|'stderr') => void} [input.onChunk]
 * @param {string} [input.commitSha]     — optional pin
 * @param {string} [input.workdirBase]   — parent dir for build workdirs; defaults to os.tmpdir()
 */
export async function runBuild({ app, store, artifactRepo, buildJobDbId, onChunk, commitSha, workdirBase }) {
  validateApp(app);

  const configHash = hashConfig(app);

  // Check for an existing artifact that matches this (app, commit, config).
  // Dedup hit → skip the whole build, but only if the tarball is still on
  // disk. An `artifacts` row whose file was cleared (tmp wipe, fresh clone,
  // operator `rm -rf`) is an orphan; treating it as a cache hit lets the
  // deploy fail later with ENOENT.
  if (commitSha) {
    const existing = await artifactRepo.findByCommitAndConfig(app.id, commitSha, configHash);
    if (existing && await store.exists({ applicationId: app.id, sha256: existing.sha256 })) {
      logger.info({ appId: app.id, sha256: existing.sha256 }, 'build:cache-hit');
      return { artifact: existing, reused: true };
    }
    if (existing) {
      logger.warn({ appId: app.id, artifactId: existing.id, sha256: existing.sha256 },
        'build:orphan-artifact-row-rebuilding');
    }
  }

  const buildId = `${Math.floor(Date.now() / 1000)}-${(commitSha ?? 'head').slice(0, 7)}`;
  const base = workdirBase ?? os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const workdir = await fs.mkdtemp(path.join(base, `cp-build-${app.id}-`));
  const tarPath = path.join(workdir, 'artifact.tar.gz');

  const log = (msg) => {
    const buf = Buffer.from(msg + '\n');
    onChunk?.(buf, 'stdout');
    logger.info({ appId: app.id, buildId }, msg);
  };

  try {
    log(`workdir=${workdir}`);

    // 1. clone
    await runCmd(`git clone --depth 50 --branch ${shellArg(app.branch)} ${shellArg(app.repo_url)} .`,
      { cwd: workdir, onChunk });

    // 2. checkout specific commit if requested
    if (commitSha) {
      await runCmd(`git fetch --depth 50 origin ${shellArg(commitSha)} && git checkout ${shellArg(commitSha)}`,
        { cwd: workdir, onChunk });
    }

    // 3. resolve commit sha actually checked out
    const resolvedSha = (await captureCmd('git rev-parse HEAD', { cwd: workdir })).trim();

    // 4. dedup re-check with resolved sha (same orphan-aware guard as above)
    const existing = await artifactRepo.findByCommitAndConfig(app.id, resolvedSha, configHash);
    if (existing && await store.exists({ applicationId: app.id, sha256: existing.sha256 })) {
      log(`cache-hit sha=${resolvedSha} → artifact #${existing.id}`);
      return { artifact: existing, reused: true };
    }
    if (existing) {
      log(`cache-hit artifact #${existing.id} but tarball missing → rebuilding`);
    }

    // 5. install + build
    if (app.install_cmd) {
      log(`$ ${app.install_cmd}`);
      await runCmd(app.install_cmd, { cwd: workdir, onChunk, env: safeEnv(app.env) });
    }
    if (app.build_cmd) {
      log(`$ ${app.build_cmd}`);
      await runCmd(app.build_cmd, { cwd: workdir, onChunk, env: safeEnv(app.env) });
    }

    // 6. collect artifact files
    const matches = await expandGlob(app.artifact_pattern, workdir);
    if (matches.length === 0) {
      throw new PermanentError(`no files matched artifact_pattern '${app.artifact_pattern}'`,
        { code: 'E_NO_ARTIFACT' });
    }
    log(`collecting ${matches.length} file(s) → tar.gz`);

    // 7. pack into tar.gz. Paths inside the tar are RELATIVE to workdir.
    await pipeline(
      tar.pack(workdir, { entries: matches.map((m) => path.relative(workdir, m)) }),
      createGzip({ level: 6 }),
      createWriteStream(tarPath),
    );

    // 8. ingest into store (computes sha256, moves into content-addressed path)
    const ingested = await store.ingest({ applicationId: app.id, sourcePath: tarPath });

    // 9. persist artifact row
    const artifactId = await artifactRepo.insert({
      applicationId: app.id,
      commitSha:    resolvedSha,
      branch:       app.branch,
      configHash,
      sha256:       ingested.sha256,
      path:         ingested.path,
      sizeBytes:    ingested.sizeBytes,
      buildJobId:   buildJobDbId,
    });

    log(`artifact #${artifactId} sha256=${ingested.sha256.slice(0, 12)} size=${ingested.sizeBytes}B`);

    return {
      artifact: {
        id: artifactId,
        commit_sha: resolvedSha,
        branch: app.branch,
        config_hash: configHash,
        sha256: ingested.sha256,
        path: ingested.path,
        size_bytes: ingested.sizeBytes,
      },
      reused: false,
      buildId,
    };
  } finally {
    // best-effort cleanup of the ephemeral workdir
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

function validateApp(app) {
  if (!app.repo_url)          throw new PermanentError('app.repo_url required');
  if (!app.artifact_pattern)  throw new PermanentError('app.artifact_pattern required');
  if (!app.remote_install_path) throw new PermanentError('app.remote_install_path required');
}

export function hashConfig(app) {
  const h = crypto.createHash('sha256');
  h.update(String(app.install_cmd ?? ''));
  h.update('|');
  h.update(String(app.build_cmd ?? ''));
  h.update('|');
  h.update(String(app.artifact_pattern ?? ''));
  return h.digest('hex');
}

async function runCmd(cmd, { cwd, env, onChunk }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, env: { ...process.env, ...(env ?? {}) }, shell: true });
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new TransientError(`build timeout: ${cmd.slice(0, 60)}`));
    }, BUILD_TIMEOUT_MS);
    child.stdout.on('data', (b) => onChunk?.(b, 'stdout'));
    child.stderr.on('data', (b) => onChunk?.(b, 'stderr'));
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new TransientError(`cmd failed (exit=${code}): ${cmd.slice(0, 60)}`,
        { code: 'E_BUILD_CMD_FAILED', meta: { exitCode: code } }));
    });
  });
}

function captureCmd(cmd, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`cmd exit=${code}`)));
    child.on('error', reject);
  });
}

async function expandGlob(pattern, cwd) {
  const matched = await glob(pattern, { cwd, nodir: false, dot: false });
  return matched.map((f) => path.join(cwd, f));
}

function safeEnv(env) {
  if (!env) return {};
  if (typeof env === 'string') { try { return JSON.parse(env); } catch { return {}; } }
  return env;
}

function shellArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
