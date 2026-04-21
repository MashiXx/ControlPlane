// In-process Telegram bot. Started by controller/src/index.js when
// TELEGRAM_TOKEN is set. Talks to the controller via BotApi (no HTTP).
//
// UX layers:
//   1. Text commands with autocomplete hints (setMyCommands):
//        /status  /help  /app <name>  /group <name>
//        /restart /stop /deploy /build — each takes <app> [server]
//   2. Inline keyboards on /status, /group, /app → click through list →
//      detail → action buttons. Multi-replica destructive actions go
//      through a confirm step before enqueueing.
//   3. Callback-driven navigation using short, stateless callback_data
//      (all data encoded in the button, no server-side session).
//
// Callback data grammar (≤ 64 bytes each):
//   list                         — re-render the app list (/status)
//   app:<id>                     — render app detail
//   a:<action>:<appId>           — pressed an action button
//   a:<action>:<appId>:<srvId>   — run action on ONE replica (no confirm)
//   cfm:<action>:<appId>         — confirmed: run on all replicas
//   pks:<action>:<appId>         — open replica picker for this action
//
// `build` is treated as an alias for `deploy` at the command-parser level
// — the controller currently builds only as a prelude to deploy, so /build
// enqueues the same two-phase build→fan-out job as /deploy.

import TelegramBot from 'node-telegram-bot-api';
import { ControlPlaneError } from '@cp/shared/errors';
import { JobAction, JobTargetType } from '@cp/shared/constants';

import { BotApi } from './api.js';
import { fmtApps, fmtJob, fmtEnqueueResult, escape, appStatusEmoji } from './format.js';

// Native /-menu: Telegram shows this on every chat with the bot. Keep the
// descriptions short; the client truncates at ~80 chars.
const MENU_COMMANDS = [
  { command: 'status',  description: 'Danh sách apps' },
  { command: 'help',    description: 'Hướng dẫn sử dụng' },
  { command: 'app',     description: '<name> — chi tiết 1 app' },
  { command: 'group',   description: '<name> — apps trong group' },
  { command: 'restart', description: '<app> [server] — restart' },
  { command: 'stop',    description: '<app> [server] — stop' },
  { command: 'deploy',  description: '<app> [server] — build + deploy' },
  { command: 'build',   description: '<app> [server] — giống /deploy' },
];

const HELP_TEXT = [
  '*ControlPlane bot*',
  '',
  '*Xem nhanh*',
  '`/status` — danh sách apps và trạng thái (click để mở chi tiết)',
  '`/app <name>` — chi tiết 1 app + replicas + nút tác vụ',
  '`/group <name>` — apps trong 1 group',
  '',
  '*Tác vụ* — chỉ admin',
  '`/restart <app> [server]`',
  '`/stop <app> [server]`',
  '`/deploy <app> [server]` — build rồi deploy',
  '`/build <app> [server]` — alias của `/deploy`',
  '',
  '_`[server]` rỗng = chạy trên mọi replica của app._',
  '_Bạn có thể bấm nút trong `/status` / `/app` thay vì gõ tên._',
  '_Khi chạy trên ≥2 replicas, bot sẽ hỏi xác nhận._',
].join('\n');

// Labels used in confirm text + result messages. Buttons use their own
// copy so icons stay consistent in the UI.
const ACTION_LABEL = {
  [JobAction.DEPLOY]:  'Deploy',
  [JobAction.RESTART]: 'Restart',
  [JobAction.STOP]:    'Stop',
};

// Which actions need a "really? all N replicas?" confirm step when the app
// has more than one replica.
const MULTI_REPLICA_CONFIRM = new Set([
  JobAction.DEPLOY, JobAction.RESTART, JobAction.STOP,
]);

export function startBot({ logger }) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    logger.info('bot:disabled (TELEGRAM_TOKEN not set)');
    return { stop: async () => {}, notifyAdmins: async () => {} };
  }

  const admins = new Set(
    (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  );

  const api = new BotApi();
  const bot = new TelegramBot(token, { polling: true });

  const isAdminId = (userId) => admins.size === 0 || admins.has(Number(userId));
  const isAdminMsg = (msg) => isAdminId(msg.from?.id);
  const actorOf = (from) => `telegram:${from?.id ?? 'anon'}`;
  const send = (chatId, text, extra = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });

  // Push the native command menu once at startup. This is what makes the
  // client show autocomplete when the user types `/`. Non-fatal if it fails
  // (network flap on startup, bot token lacking permission, etc.).
  bot.setMyCommands(MENU_COMMANDS).catch((err) => {
    logger.warn({ err: err.message }, 'bot:setMyCommands-failed');
  });

  async function guarded(msg, fn) {
    try { await fn(); }
    catch (err) {
      const text = err instanceof ControlPlaneError
        ? `⚠️ ${err.code}: ${err.message}`
        : `⚠️ unexpected: ${err.message}`;
      logger.warn({ err: err.message, chat: msg.chat.id }, 'bot:command-failed');
      await send(msg.chat.id, text).catch(() => {});
    }
  }

  async function guardedCb(q, fn) {
    try { await fn(); }
    catch (err) {
      logger.warn({ err: err.message, from: q.from?.id }, 'bot:callback-failed');
      const text = err instanceof ControlPlaneError
        ? `⚠️ ${err.code}: ${err.message}`.slice(0, 180)
        : `⚠️ ${err.message}`.slice(0, 180);
      // show_alert pops a blocking dialog — appropriate for errors.
      await bot.answerCallbackQuery(q.id, { text, show_alert: true }).catch(() => {});
    }
  }

  // ─── text commands ───────────────────────────────────────────────────

  // /help
  bot.onText(/^\/help(?:@\w+)?\s*$/, (msg) => guarded(msg, async () => {
    await send(msg.chat.id, HELP_TEXT);
  }));

  // /start — Telegram clients auto-send this on first interaction; route
  // to /help so new users get a welcome page instead of silence.
  bot.onText(/^\/start(?:@\w+)?\s*$/, (msg) => guarded(msg, async () => {
    await send(msg.chat.id, HELP_TEXT);
  }));

  // /status — app list with one clickable button per app.
  bot.onText(/^\/status(?:@\w+)?\s*$/, (msg) => guarded(msg, async () => {
    const apps = await api.listApplications();
    await send(msg.chat.id, renderAppListText(apps, 'Applications'), {
      reply_markup: renderAppListKeyboard(apps),
    });
  }));

  // /group <name> — same list UI, filtered to one group.
  bot.onText(/^\/group(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const [apps, groupList] = await Promise.all([api.listApplications(), api.listGroups()]);
    const g = groupList.find((x) => x.name === name);
    if (!g) return send(msg.chat.id, `_group *${escape(name)}* not found_`);
    const filtered = apps.filter((a) => a.group_id === g.id);
    await send(msg.chat.id, renderAppListText(filtered, `${name} — ${filtered.length} apps`), {
      reply_markup: renderAppListKeyboard(filtered),
    });
  }));

  // /app <name> — detail with action buttons.
  bot.onText(/^\/app(?:@\w+)?\s+(\S+)/, (msg, m) => guarded(msg, async () => {
    const name = m[1];
    const apps = await api.listApplications();
    const app = apps.find((a) => a.name === name);
    if (!app) return send(msg.chat.id, `_app *${escape(name)}* not found_`);
    const replicas = await api.listReplicas(app.id);
    await send(msg.chat.id, renderAppDetailText(app, replicas), {
      reply_markup: renderAppDetailKeyboard(app, replicas),
    });
  }));

  // /<action> <app> [server]
  // When `server` is omitted the orchestrator fans out to every replica.
  // When present it must match a server name registered as a replica of
  // the app (i.e. applications.server_id or a server_group member).
  const parseServerArg = async (raw) => {
    if (!raw) return {};
    const all = await api.listServers();
    const s = all.find((x) => x.name === raw);
    if (!s) throw new Error(`server '${raw}' not found`);
    return { serverId: s.id };
  };

  const actionCommands = [
    { re: /^\/restart(?:@\w+)?\s+(\S+)(?:\s+(\S+))?/, action: JobAction.RESTART },
    { re: /^\/stop(?:@\w+)?\s+(\S+)(?:\s+(\S+))?/,    action: JobAction.STOP    },
    { re: /^\/deploy(?:@\w+)?\s+(\S+)(?:\s+(\S+))?/,  action: JobAction.DEPLOY  },
    // /build is an alias: building without deploying isn't a distinct job
    // in this controller, so we just run the deploy pipeline (build + fan-out).
    { re: /^\/build(?:@\w+)?\s+(\S+)(?:\s+(\S+))?/,   action: JobAction.DEPLOY  },
  ];
  for (const { re, action } of actionCommands) {
    bot.onText(re, (msg, m) => guarded(msg, async () => {
      if (!isAdminMsg(msg)) return send(msg.chat.id, '_forbidden_');
      const [, appName, serverArg] = m;
      const apps = await api.listApplications();
      const app = apps.find((a) => a.name === appName);
      if (!app) return send(msg.chat.id, `_app *${escape(appName)}* not found_`);
      const selector = await parseServerArg(serverArg);
      const result = await api.enqueue({
        action,
        target: { type: JobTargetType.APP, id: app.id },
        triggeredBy: actorOf(msg.from),
        options: selector,
      });
      const scope = serverArg ? `@${escape(serverArg)}` : '(all replicas)';
      await send(msg.chat.id, `*${ACTION_LABEL[action] ?? action}* → *${escape(appName)}* ${scope}\n${fmtEnqueueResult(result)}`);
      const first = result.jobs?.[0];
      if (first?.jobId) pollJobStatus(msg.chat.id, first.jobId);
    }));
  }

  // ─── callback queries (inline keyboard clicks) ───────────────────────

  bot.on('callback_query', (q) => guardedCb(q, async () => {
    const data = q.data ?? '';

    if (data === 'list') return cbList(q);
    if (data.startsWith('app:')) return cbAppDetail(q, Number(data.slice(4)));

    if (data.startsWith('a:')) {
      const [, action, appIdStr, srvIdStr] = data.split(':');
      return cbAction(q, action, Number(appIdStr), srvIdStr ? Number(srvIdStr) : null);
    }
    if (data.startsWith('cfm:')) {
      const [, action, appIdStr] = data.split(':');
      return cbConfirm(q, action, Number(appIdStr));
    }
    if (data.startsWith('pks:')) {
      const [, action, appIdStr] = data.split(':');
      return cbPicker(q, action, Number(appIdStr));
    }

    // Unknown — just clear the spinner.
    await bot.answerCallbackQuery(q.id).catch(() => {});
  }));

  async function cbList(q) {
    const apps = await api.listApplications();
    await editMessage(q, renderAppListText(apps, 'Applications'), renderAppListKeyboard(apps));
    await bot.answerCallbackQuery(q.id).catch(() => {});
  }

  async function cbAppDetail(q, appId) {
    const app = await api.getApplication(appId);
    if (!app) return bot.answerCallbackQuery(q.id, { text: 'App not found', show_alert: true });
    const replicas = await api.listReplicas(appId);
    await editMessage(q, renderAppDetailText(app, replicas), renderAppDetailKeyboard(app, replicas));
    await bot.answerCallbackQuery(q.id).catch(() => {});
  }

  async function cbAction(q, action, appId, srvId) {
    if (!isAdminId(q.from?.id)) {
      return bot.answerCallbackQuery(q.id, { text: 'Forbidden', show_alert: true });
    }
    if (!ACTION_LABEL[action]) {
      return bot.answerCallbackQuery(q.id, { text: `unknown action: ${action}`, show_alert: true });
    }

    const app = await api.getApplication(appId);
    if (!app) return bot.answerCallbackQuery(q.id, { text: 'App not found', show_alert: true });
    const replicas = await api.listReplicas(appId);

    // Single replica OR operator targeted one specific replica → run now.
    if (srvId !== null || replicas.length <= 1 || !MULTI_REPLICA_CONFIRM.has(action)) {
      await runAction(q, app, replicas, action, srvId);
      return;
    }

    // Multi-replica destructive action → show confirm.
    const text = `Bạn sắp *${ACTION_LABEL[action]}* *${escape(app.name)}* trên *${replicas.length}* replicas.`;
    await editMessage(q, text, {
      inline_keyboard: [
        [{ text: `✅ Chạy trên tất cả ${replicas.length} replicas`, callback_data: `cfm:${action}:${appId}` }],
        [{ text: '🎯 Chọn replica cụ thể',                         callback_data: `pks:${action}:${appId}` }],
        [{ text: '❌ Hủy',                                          callback_data: `app:${appId}`         }],
      ],
    });
    await bot.answerCallbackQuery(q.id).catch(() => {});
  }

  async function cbConfirm(q, action, appId) {
    if (!isAdminId(q.from?.id)) {
      return bot.answerCallbackQuery(q.id, { text: 'Forbidden', show_alert: true });
    }
    const app = await api.getApplication(appId);
    if (!app) return bot.answerCallbackQuery(q.id, { text: 'App not found', show_alert: true });
    const replicas = await api.listReplicas(appId);
    await runAction(q, app, replicas, action, null);
  }

  async function cbPicker(q, action, appId) {
    if (!isAdminId(q.from?.id)) {
      return bot.answerCallbackQuery(q.id, { text: 'Forbidden', show_alert: true });
    }
    const app = await api.getApplication(appId);
    if (!app) return bot.answerCallbackQuery(q.id, { text: 'App not found', show_alert: true });
    const replicas = await api.listReplicas(appId);
    const rows = replicas.map((r) => [{
      text: `📡 @${r.server_name}`,
      callback_data: `a:${action}:${appId}:${r.server_id}`,
    }]);
    rows.push([{ text: '⬅ Back', callback_data: `app:${appId}` }]);
    await editMessage(q, `Chọn replica cho *${ACTION_LABEL[action]}* — *${escape(app.name)}*:`,
      { inline_keyboard: rows });
    await bot.answerCallbackQuery(q.id).catch(() => {});
  }

  async function runAction(q, app, replicas, action, srvId) {
    const selector = srvId ? { serverId: srvId } : {};
    const result = await api.enqueue({
      action,
      target: { type: JobTargetType.APP, id: app.id },
      triggeredBy: actorOf(q.from),
      options: selector,
    });
    const scope = srvId
      ? `@${escape(replicas.find((r) => r.server_id === srvId)?.server_name ?? `server#${srvId}`)}`
      : `(${replicas.length} replicas)`;
    const text = `*${ACTION_LABEL[action]}* → *${escape(app.name)}* ${scope}\n${fmtEnqueueResult(result)}`;
    await editMessage(q, text, { inline_keyboard: [[{ text: '⬅ App detail', callback_data: `app:${app.id}` }]] });
    await bot.answerCallbackQuery(q.id, { text: `${ACTION_LABEL[action]} queued` }).catch(() => {});
    const first = result.jobs?.[0];
    if (first?.jobId) pollJobStatus(q.message?.chat?.id, first.jobId);
  }

  // ─── render helpers ──────────────────────────────────────────────────

  function renderAppListText(apps, title) {
    if (!apps.length) return `*${title}*\n\n_no applications_`;
    return `*${title}*\n\n${fmtApps(apps)}\n\n_Bấm một app để xem chi tiết._`;
  }

  function renderAppListKeyboard(apps) {
    if (!apps.length) return undefined;
    return {
      inline_keyboard: apps.map((a) => [{
        text: `${appStatusEmoji(a)} ${a.name}  ${a.replicaCountRunning ?? 0}/${a.replicaCountTotal ?? 0}`,
        callback_data: `app:${a.id}`,
      }]),
    };
  }

  function renderAppDetailText(app, replicas) {
    const lines = [
      `*${escape(app.name)}* — ${replicas.length} replica(s)`,
      `runtime: \`${app.runtime}\`  branch: \`${app.branch}\``,
      `enabled: ${app.enabled ? '✅' : '❌'}  trusted: ${app.trusted ? '✅' : '❌'}`,
      '',
      ...replicas.map((r) =>
        `• @${escape(r.server_name)}: _${r.process_state}_ (expected ${r.expected_state}${r.pid ? `, pid ${r.pid}` : ''})`),
    ];
    return lines.join('\n');
  }

  function renderAppDetailKeyboard(app, _replicas) {
    return {
      inline_keyboard: [
        [
          { text: '🚀 Deploy',  callback_data: `a:${JobAction.DEPLOY}:${app.id}`  },
          { text: '♻️ Restart', callback_data: `a:${JobAction.RESTART}:${app.id}` },
        ],
        [
          { text: '⏹ Stop',    callback_data: `a:${JobAction.STOP}:${app.id}`    },
          // Build button is a deploy alias — same callback_data on purpose.
          { text: '🔨 Build',   callback_data: `a:${JobAction.DEPLOY}:${app.id}`  },
        ],
        [{ text: '⬅ Danh sách apps', callback_data: 'list' }],
      ],
    };
  }

  // Edit in place when possible (keeps the chat tidy); fall back to a new
  // message if the original is too old to edit or got deleted.
  async function editMessage(q, text, reply_markup) {
    const chatId = q.message?.chat?.id;
    const msgId  = q.message?.message_id;
    if (!chatId || !msgId) {
      if (chatId) await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup }).catch(() => {});
      return;
    }
    try {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown', reply_markup,
      });
    } catch (err) {
      // "message is not modified" = same content clicked twice → no-op is fine.
      // Only re-send on *real* failures (message deleted, too old to edit, ...).
      if (/message is not modified/i.test(err.message)) return;
      logger.warn({ err: err.message, chatId }, 'bot:edit-failed');
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup }).catch(() => {});
    }
  }

  // ─── job status polling (unchanged) ──────────────────────────────────

  async function pollJobStatus(chatId, jobId) {
    if (!chatId) return;
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
  // in controller/src/index.js.
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
