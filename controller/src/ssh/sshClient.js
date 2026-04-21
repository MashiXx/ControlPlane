// SSH wrapper — the controller's only channel to target servers.
//
// Two modes, selected by passing `onChunk`:
//
//   buffered:  runSsh(host, cmd, { timeoutMs })
//               → { exitCode, stdoutTail, stderrTail, durationMs }
//   streaming: runSsh(host, cmd, { timeoutMs, onChunk: (c) => … })
//               → stdout/stderr lines are pushed to onChunk as they arrive;
//                 the returned object has empty tails so callers don't
//                 double-buffer.
//
// Hardening that's always applied regardless of ~/.ssh/config:
//
//   -o BatchMode=yes       — never prompt; this is a background job
//   -o ConnectTimeout=10   — fail fast when the target is unreachable
//
// All other connection details (User, Port, IdentityFile, ProxyJump,
// ControlMaster/ControlPath) live in the controller user's ~/.ssh/config.
//
// Error mapping:
//   - ssh exit 255       → TransientError (host unreachable / DNS / key
//                          rejected / remote dropped us). The queue retries.
//   - remote exit != 0   → TransientError with meta.exitCode + stderr tail;
//                          callers may rewrap this as permanent (e.g.
//                          healthcheck is re-thrown with transient=true).
//   - timeoutMs exceeded → TransientError('ssh timeout'); child SIGKILL'd.
//   - spawn error        → wrapped as TransientError.

import { spawn } from 'node:child_process';
import { PermanentError, TransientError } from '@cp/shared/errors';

export const SSH_HARDENING = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

const TAIL_BYTES = 16 * 1024;  // per-stream cap kept in the returned object

/**
 * Validate a string before embedding it in an SSH command line.
 * Matches the regex that rsyncTransfer.js previously used — both paths
 * now go through this helper.
 */
export function shellSafe(s) {
  if (typeof s !== 'string' || !/^[\w@%+=:,./-]+$/.test(s)) {
    throw new PermanentError(`unsafe remote path: ${s}`);
  }
  return s;
}

/**
 * Escape a command string for `bash -c '…'`. Single-quote is the only char
 * we need to handle since we're wrapping the whole thing in single quotes.
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command on a remote host over SSH.
 *
 * @param {string} host            — SSH target (hostname / IP / ssh_config alias)
 * @param {string} remoteCommand   — shell command evaluated on the remote
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000]
 * @param {object} [opts.env]      — merged into process.env for the local ssh
 * @param {(chunk: { stream: 'stdout'|'stderr', data: Buffer }) => void} [opts.onChunk]
 *   When present, stdout/stderr are streamed as they arrive; the returned
 *   `stdoutTail` / `stderrTail` are empty.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ exitCode: number, stdoutTail: string, stderrTail: string, durationMs: number }>}
 */
export function runSsh(host, remoteCommand, opts = {}) {
  const { timeoutMs = 120_000, env, onChunk, signal } = opts;
  const args = [...SSH_HARDENING, host, remoteCommand];
  return runChild('ssh', args, { timeoutMs, env, onChunk, signal });
}

/**
 * Push a local directory to a remote path via rsync+ssh.
 * Used by the deploy action to stage a release.
 */
export function runRsync(localDir, host, remoteDir, opts = {}) {
  const { timeoutMs = 20 * 60 * 1000, onChunk } = opts;
  const args = [
    '-az', '--delete',
    '-e', `ssh ${SSH_HARDENING.join(' ')}`,
    `${localDir}/`,
    `${host}:${remoteDir}`,
  ];
  return runChild('rsync', args, { timeoutMs, onChunk });
}

// ─── internal: shared spawn/collect plumbing ────────────────────────────
function runChild(cmd, args, { timeoutMs, env, onChunk, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });

    const startedAt = Date.now();
    let stdoutTail = '';
    let stderrTail = '';
    let finished = false;
    let timedOut = false;

    const appendTail = (buf, which) => {
      // When streaming, only keep a short prefix so errors surface even if
      // the caller only reads onChunk.
      const cap = onChunk ? 1024 : TAIL_BYTES;
      const s = buf.toString('utf8');
      if (which === 'stdout') stdoutTail = tail(stdoutTail + s, cap);
      else                    stderrTail = tail(stderrTail + s, cap);
    };

    child.stdout.on('data', (b) => {
      if (onChunk) { try { onChunk({ stream: 'stdout', data: b }); } catch { /* noop */ } }
      appendTail(b, 'stdout');
    });
    child.stderr.on('data', (b) => {
      if (onChunk) { try { onChunk({ stream: 'stderr', data: b }); } catch { /* noop */ } }
      appendTail(b, 'stderr');
    });

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(new TransientError(`${cmd} spawn failed: ${err.message}`, {
        code: 'E_SSH_SPAWN',
        meta: { cmd, error: err.message },
      }));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      signal?.removeEventListener?.('abort', onAbort);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        return reject(new TransientError(`${cmd} timeout after ${timeoutMs}ms`, {
          code: 'E_SSH_TIMEOUT',
          meta: { cmd, timeoutMs, stderrTail: stderrTail.slice(-2048) },
        }));
      }

      // Distinguish "ssh itself failed" (255) from "remote command returned
      // non-zero". Both are retryable, but the codes differ so operators can
      // tell them apart in the audit log.
      if (cmd === 'ssh' && code === 255) {
        return reject(new TransientError(
          `ssh to target failed (exit 255): ${tail(stderrTail, 512)}`,
          { code: 'E_SSH_CONNECT', meta: { exitCode: code, stderrTail: stderrTail.slice(-2048) } },
        ));
      }

      // Rsync-specific: non-zero → transient (network blip, partial disk).
      if (cmd === 'rsync' && code !== 0) {
        return reject(new TransientError(
          `rsync exit=${code}: ${tail(stderrTail, 512)}`,
          { code: 'E_RSYNC_FAILED', meta: { exitCode: code, stderrTail: stderrTail.slice(-2048) } },
        ));
      }

      resolve({ exitCode: code ?? -1, stdoutTail, stderrTail, durationMs });
    });
  });
}

function tail(s, cap) {
  return s.length > cap ? s.slice(-cap) : s;
}
