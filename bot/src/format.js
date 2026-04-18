// Telegram message formatting helpers. Uses Markdown V1 to keep it simple.

const emojiForState = {
  running:  '🟢',
  stopped:  '⚪',
  crashed:  '🔴',
  starting: '🟡',
  unknown:  '❔',
};

const emojiForJob = {
  pending: '🕒', running: '⚙️', success: '✅', failed: '❌', cancelled: '🚫',
};

export function fmtApps(apps) {
  if (!apps.length) return '_no applications_';
  return apps.map((a) =>
    `${emojiForState[a.process_state] ?? '❔'} *${escape(a.name)}*  _${a.process_state}_  (srv=${a.server_id})`,
  ).join('\n');
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

function escape(s) {
  return String(s).replace(/[_*`\[\]]/g, (ch) => `\\${ch}`);
}
