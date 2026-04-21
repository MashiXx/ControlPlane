// Telegram message formatting helpers. Uses Markdown V1 to keep it simple.

const emojiForJob = {
  pending: '🕒', running: '⚙️', success: '✅', failed: '❌', cancelled: '🚫',
};

// Emoji hint for app health, based on running/total replica counts.
// ⚪ = not placed anywhere, 🔴 = zero running, 🟡 = partial, 🟢 = all up.
export function appStatusEmoji(a) {
  const run = a.replicaCountRunning ?? 0;
  const tot = a.replicaCountTotal ?? 0;
  if (tot === 0) return '⚪';
  if (run === 0) return '🔴';
  if (run < tot) return '🟡';
  return '🟢';
}

export function fmtApps(apps) {
  if (!apps.length) return '_no applications_';
  return apps.map((a) => {
    const running = a.replicaCountRunning ?? '?';
    const total   = a.replicaCountTotal   ?? '?';
    return `${appStatusEmoji(a)} *${escape(a.name)}*  ${running}/${total}  ${a.enabled ? '' : '(disabled)'}`;
  }).join('\n');
}

export function fmtJob(job) {
  return `${emojiForJob[job.status] ?? '•'} job #${job.id} *${escape(job.action)}*  `
    + `_${job.status}_  attempts=${job.attempts}/${job.max_attempts}`
    + (job.error_message ? `\n\`${escape(job.error_message.slice(0, 200))}\`` : '');
}

export function fmtEnqueueResult(result) {
  const n = result.jobs?.length ?? 0;
  if (n === 0) return '_no jobs enqueued_';
  const lines = result.jobs.map((j) =>
    `• queued \`${escape(j.action)}\` for *${escape(j.application.name)}* (job #${j.jobId ?? '?'})`,
  );
  return lines.join('\n');
}

export function escape(s) {
  return String(s).replace(/[_*`\[\]]/g, (ch) => `\\${ch}`);
}
