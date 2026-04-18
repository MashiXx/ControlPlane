// ControlPlane Telegram bot.
//
// Commands:
//   /status                — overview of all apps
//   /group <name>          — apps in a group
//   /app <name>            — app detail
//   /restart <group>       — restart all apps in a group
//   /build <group>         — build all apps in a group
//
// All side-effects go through the Controller API — the bot holds no state
// of its own beyond "which chat ids are allowed to issue destructive ops".

import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '@cp/shared/logger';
import { ControlPlaneError } from '@cp/shared/errors';
import { JobAction, JobTargetType } from '@cp/shared/constants';

import { ControllerClient } from './controllerClient.js';
import { fmtApps, fmtJob, fmtEnqueueResult } from './format.js';

const logger = createLogger({ service: 'bot' });

const token    = required('TELEGRAM_TOKEN');
const apiUrl   = required('TELEGRAM_CONTROLLER_URL');
const apiToken = required('TELEGRAM_CONTROLLER_TOKEN');
const admins   = new Set(
  (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
);

const api = new ControllerClient({ baseUrl: apiUrl, apiToken });
const bot = new TelegramBot(token, { polling: true });

// ─── helpers ────────────────────────────────────────────────────────────
function actorOf(msg) { return `telegram:${msg.from?.id ?? 'anon'}`; }
function isAdmin(msg) { return admins.size === 0 || admins.has(msg.from?.id); }

function send(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
}

async function guarded(msg, fn) {
  try {
    await fn();
  } catch (err) {
    const msgText = err instanceof ControlPlaneError
      ? `⚠️ ${err.code}: ${err.message}`
      : `⚠️ unexpected: ${err.message}`;
    logger.warn({ err: err.message, chat: msg.chat.id }, 'bot:command-failed');
    await send(msg.chat.id, msgText);
  }
}

// ─── /status ────────────────────────────────────────────────────────────
bot.onText(/^\/status(?:@\w+)?\s*$/, (msg) => guarded(msg, async () => {
  const apps = await api.listApplications();
  await send(msg.chat.id, fmtApps(apps));
}));

// ─── /group <name> ──────────────────────────────────────────────────────
bot.onText(/^\/group(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
  const name = m[1];
  const apps = await api.listApplications();
  const inGroup = apps.filter((a) => a.group_id !== null);
  const groups  = await api.listGroups();
  const g = groups.find((x) => x.name === name);
  if (!g) return send(msg.chat.id, `_group *${name}* not found_`);
  const filtered = inGroup.filter((a) => a.group_id === g.id);
  await send(msg.chat.id, `*${name}* — ${filtered.length} apps\n${fmtApps(filtered)}`);
}));

// ─── /app <name> ────────────────────────────────────────────────────────
bot.onText(/^\/app(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
  const name = m[1];
  const apps = await api.listApplications();
  const app  = apps.find((a) => a.name === name);
  if (!app) return send(msg.chat.id, `_app *${name}* not found_`);
  const detail = await api.getApplication(app.id);
  const lines = [
    `*${detail.name}*  _${detail.process_state}_`,
    `runtime: \`${detail.runtime}\`  pid: \`${detail.pid ?? '-'}\``,
    `server: \`${detail.server_id}\`  branch: \`${detail.branch}\``,
    `enabled: ${detail.enabled ? '✅' : '❌'}  trusted: ${detail.trusted ? '✅' : '❌'}`,
  ];
  await send(msg.chat.id, lines.join('\n'));
}));

// ─── /restart <group>  and  /build <group> ──────────────────────────────
const actionCommands = [
  { re: /^\/restart(?:@\w+)?\s+(\S+)/, action: JobAction.RESTART },
  { re: /^\/build(?:@\w+)?\s+(\S+)/,   action: JobAction.BUILD   },
  { re: /^\/deploy(?:@\w+)?\s+(\S+)/,  action: JobAction.DEPLOY  },
];
for (const { re, action } of actionCommands) {
  bot.onText(re, (msg, m) => guarded(msg, async () => {
    if (!isAdmin(msg)) return send(msg.chat.id, '_forbidden_');
    const groupName = m[1];
    const result = await api.enqueue({
      action,
      target: { type: JobTargetType.GROUP, id: groupName },
    });
    await send(msg.chat.id, `*${action}* → *${groupName}*\n${fmtEnqueueResult(result)}`);
    // Poll first job for a brief progression update.
    const first = result.jobs?.[0];
    if (first?.jobId) pollJobStatus(msg.chat.id, first.jobId);
  }));
}

async function pollJobStatus(chatId, jobId) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const job = await api.getJob(jobId);
      if (!job) return;
      if (job.status !== last) {
        last = job.status;
        await send(chatId, fmtJob(job));
        if (['success', 'failed', 'cancelled'].includes(job.status)) return;
      }
    } catch { /* ignore transient errors during polling */ }
    await sleep(3_000);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function required(name) {
  const v = process.env[name];
  if (!v) { logger.error({ name }, 'bot:missing-env'); process.exit(1); }
  return v;
}

logger.info({ admins: admins.size, apiUrl }, 'bot:started');

process.on('SIGINT',  () => bot.stopPolling().finally(() => process.exit(0)));
process.on('SIGTERM', () => bot.stopPolling().finally(() => process.exit(0)));
