// Low-level command execution. One-shot processes (build, install, git pull,
// healthcheck) are run here and their output is streamed back via onChunk.
//
// Long-lived app processes go through processManager.js instead.

import { spawn } from 'node:child_process';
import { TimeoutError } from '@cp/shared/errors';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10m hard ceiling for builds

/**
 * Run a one-shot command and resolve with { exitCode, stdoutTail, stderrTail, durationMs }.
 *
 * @param {string} command
 * @param {object} opts
 * @param {string}                 [opts.cwd]
 * @param {Record<string,string>}  [opts.env]
 * @param {number}                 [opts.timeoutMs]
 * @param {(chunk: {stream, data}) => void} [opts.onChunk]
 * @param {AbortSignal}            [opts.signal]
 */
export function runOnce(command, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd;
  const env = { ...process.env, ...(opts.env ?? {}) };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    // shell: true so we accept standard shell syntax (pipes, &&) from
    // admin-owned app config. Whitelist / safety is enforced upstream.
    const child = spawn(command, { cwd, env, shell: true });

    const tails = { stdout: '', stderr: '' };
    const TAIL_MAX = 16 * 1024;

    function appendTail(stream, buf) {
      tails[stream] = (tails[stream] + buf).slice(-TAIL_MAX);
    }

    child.stdout.on('data', (buf) => {
      appendTail('stdout', buf.toString('utf8'));
      opts.onChunk?.({ stream: 'stdout', data: buf });
    });
    child.stderr.on('data', (buf) => {
      appendTail('stderr', buf.toString('utf8'));
      opts.onChunk?.({ stream: 'stderr', data: buf });
    });

    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new TimeoutError(`exec: ${command.slice(0, 60)}`, timeoutMs));
    }, timeoutMs);

    opts.signal?.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }, { once: true });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        exitCode:   code,
        signal,
        stdoutTail: tails.stdout,
        stderrTail: tails.stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}
