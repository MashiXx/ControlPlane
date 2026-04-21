// In-process Telegram bot. Started by controller/src/index.js when
// TELEGRAM_TOKEN is set. Talks to the controller via BotApi (no HTTP).
//
// Commands:
//   /status                          — overview of all apps (replica counts)
//   /group <name>                    — apps in a group
//   /app <name>                      — app detail with per-replica list
//   /restart <app> <server|group:name|all>
//   /stop    <app> <server|group:name|all>
//   /deploy  <app> <server|group:name|all>

import TelegramBot from 'node-telegram-bot-api';
import { ControlPlaneError } from '@cp/shared/errors';
import { JobAction, JobTargetType } from '@cp/shared/constants';

import { BotApi } from './api.js';
import { fmtApps, fmtJob, fmtEnqueueResult } from './format.js';

export function startBot({ logger }) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    logger.info('bot:disabled (TELEGRAM_TOKEN not set)');
    // Always return a notifyAdmins so the AlertManager doesn't need null
    // checks; it's a no-op when the bot is disabled.
    return { stop: async () => {}, notifyAdmins: async () => {} };
  }

  const admins = new Set(
    (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  );

  const api = new BotApi();
  const bot = new TelegramBot(token, { polling: true });

  const isAdmin = (msg) => admins.size === 0 || admins.has(msg.from?.id);
  const actorOf = (msg) => `telegram:${msg.from?.id ?? 'anon'}`;
  const send = (chatId, text, extra = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });

  async function guarded(msg, fn) {
    try { await fn(); }
    catch (err) {
      const text = err instanceof ControlPlaneError
        ? `⚠️ ${err.code}: ${err.message}`
        : `⚠️ unexpected: ${err.message}`;
      logger.warn({ err: err.message, chat: msg.chat.id }, 'bot:command-failed');
      await send(msg.chat.id, text);
    }
  }

  // /status
  bot.onText(/^\/status(?:@\w+)?\s*$/, (msg) => guarded(msg, async () => {
    const apps = await api.listApplications();
    await send(msg.chat.id, fmtApps(apps));
  }));

  // /group <name>
  bot.onText(/^\/group(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const apps = await api.listApplications();
    const groups = await api.listGroups();
    const g = groups.find((x) => x.name === name);
    if (!g) return send(msg.chat.id, `_group *${name}* not found_`);
    const filtered = apps.filter((a) => a.group_id === g.id);
    await send(msg.chat.id, `*${name}* — ${filtered.length} apps\n${fmtApps(filtered)}`);
  }));

  // /app <name>
  bot.onText(/^\/app(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const apps = await api.listApplications();
    const app = apps.find((a) => a.name === name);
    if (!app) return send(msg.chat.id, `_app *${name}* not found_`);
    const replicas = await api.listReplicas(app.id);
    const lines = [
      `*${app.name}* — ${replicas.length} replica(s)`,
      `runtime: \`${app.runtime}\`  branch: \`${app.branch}\``,
      `enabled: ${app.enabled ? '✅' : '❌'}  trusted: ${app.trusted ? '✅' : '❌'}`,
      '',
      ...replicas.map((r) =>
        `• @${r.server_name}: _${r.process_state}_ (expected ${r.expected_state}${r.pid ? `, pid ${r.pid}` : ''})`,
      ),
    ];
    await send(msg.chat.id, lines.join('\n'));
  }));

  // /<action> <app> <server|group:name|all>
  const parseServerArg = async (appId, raw) => {
    if (raw === 'all') {
      const rs = await api.listReplicas(appId);
      return { serverIds: rs.map((r) => Number(r.server_id)) };
    }
    if (raw.startsWith('group:')) {
      return { serverGroupId: raw.slice('group:'.length) };
    }
    // Assume a server name. Map to id.
    const all = await api.listServers();
    const s = all.find((x) => x.name === raw);
    if (!s) throw new Error(`server '${raw}' not found`);
    return { serverId: s.id };
  };

  const actionCommands = [
    { re: /^\/restart(?:@\w+)?\s+(\S+)\s+(\S+)/, action: JobAction.RESTART },
    { re: /^\/stop(?:@\w+)?\s+(\S+)\s+(\S+)/,    action: JobAction.STOP    },
    { re: /^\/deploy(?:@\w+)?\s+(\S+)\s+(\S+)/,  action: JobAction.DEPLOY  },
  ];
  for (const { re, action } of actionCommands) {
    bot.onText(re, (msg, m) => guarded(msg, async () => {
      if (!isAdmin(msg)) return send(msg.chat.id, '_forbidden_');
      const [, appName, serverArg] = m;
      const apps = await api.listApplications();
      const app = apps.find((a) => a.name === appName);
      if (!app) return send(msg.chat.id, `_app *${appName}* not found_`);
      const selector = await parseServerArg(app.id, serverArg);
      const result = await api.enqueue({
        action,
        target: { type: JobTargetType.APP, id: app.id },
        triggeredBy: actorOf(msg),
        options: selector,
      });
      await send(msg.chat.id, `*${action}* → *${appName}* (${serverArg})\n${fmtEnqueueResult(result)}`);
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
      } catch { /* ignore transient polling errors */ }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  logger.info({ admins: admins.size }, 'bot:started');

  // Broadcast an alert text to every admin chat. Wired to the AlertManager
  // in controller/src/index.js — the alert manager stays decoupled from the
  // telegram library via this thin callback.
  const notifyAdmins = async (text) => {
    if (admins.size === 0) return;
    for (const chatId of admins) {
      try { await send(chatId, text); }
      catch (err) { logger.warn({ err: err.message, chatId }, 'bot:notify-failed'); }
    }
  };

  return {
    stop: async () => {
      try { await bot.stopPolling(); }
      catch (err) { logger.warn({ err: err.message }, 'bot:stop-failed'); }
    },
    notifyAdmins,
  };
}
