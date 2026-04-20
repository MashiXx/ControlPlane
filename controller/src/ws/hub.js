// WebSocket hub.
//
// Responsibilities:
//   - accept agent WS connections on /agent, authenticate via HELLO
//   - accept browser UI WS connections on /ui, gated by the cp_session
//     cookie (verified against the same secret used by /auth/login)
//   - track agent sessions keyed by serverId
//   - expose executeAndWait(serverId, frame) used by the in-process worker
//   - broadcast job updates + state snapshots to subscribed UI clients
//
// Reliability: on agent disconnect, all pending dispatches for that
// server are rejected with TransientError → the queue will retry.

import { WebSocketServer } from 'ws';
import { WsOp, HEARTBEAT_MISS_LIMIT } from '@cp/shared/constants';
import { schemas } from '@cp/shared';
import { AgentUnavailableError, AuthError, TimeoutError, serializeError } from '@cp/shared/errors';
import { newSessionId, sha256Hex } from '@cp/shared/ids';
import { createLogger } from '@cp/shared/logger';
import { servers, applications, jobs as jobsRepo } from '../db/repositories.js';
import { writeAudit } from '../audit/audit.js';
import { parse as parseCookie } from 'cookie';
import { SESSION_COOKIE_NAME, verifySessionToken } from '../auth/session.js';

const logger = createLogger({ service: 'ws.hub' });

export class WsHub {
  constructor({ httpServer, heartbeatMs, onJobResult, sessionSecret }) {
    this.heartbeatMs = heartbeatMs;
    this.onJobResult = onJobResult;
    this.sessionSecret = sessionSecret;

    /** @type {Map<number, AgentSession>} */
    this.sessionsByServer = new Map();
    /** @type {Set<import('ws').WebSocket>} */
    this.uiClients = new Set();
    /** @type {Map<string, { resolve: Function, reject: Function, timer: any, serverId: number }>} */
    this.pendingJobs = new Map();

    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/agent') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this._attachAgent(ws, req));
    } else if (url.pathname === '/ui') {
      if (!this._uiAuthOk(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._attachUi(ws, req));
    } else {
      socket.destroy();
    }
  }

  _uiAuthOk(req) {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const v = verifySessionToken(this.sessionSecret, cookies[SESSION_COOKIE_NAME]);
    return v.ok;
  }

  // ─── Agent connections ────────────────────────────────────────────────
  _attachAgent(ws, req) {
    let session = null;

    // Expect HELLO as first frame; authenticate against servers.auth_token_hash
    ws.once('message', async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString('utf8')); }
      catch { return this._rejectAgent(ws, 'bad json'); }

      const parsed = schemas.WsHello.safeParse(frame);
      if (!parsed.success) return this._rejectAgent(ws, 'invalid HELLO');

      // Prefer Authorization header if present; fall back to HELLO.authToken.
      const headerTok = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const token = headerTok ?? parsed.data.authToken;
      const hash = sha256Hex(token);
      const server = await servers.findByTokenHash(hash);
      if (!server) return this._rejectAgent(ws, 'auth failed');

      await servers.updateSeen(server.id, { version: parsed.data.version, os: parsed.data.os });
      await writeAudit({
        actor: `agent:${parsed.data.agentId}`, action: 'agent.connect',
        targetType: 'server', targetId: String(server.id),
        result: 'success', message: `v${parsed.data.version}`,
      });

      session = {
        ws,
        sessionId: newSessionId(),
        server,
        missedHeartbeats: 0,
        lastSeen: Date.now(),
      };
      this.sessionsByServer.set(server.id, session);

      this._send(ws, { op: WsOp.WELCOME, sessionId: session.sessionId, heartbeatMs: this.heartbeatMs });
      logger.info({ serverId: server.id, sessionId: session.sessionId }, 'agent:connected');

      ws.on('message', (r) => this._onAgentFrame(session, r));
      ws.on('close', () => this._onAgentClose(session));
      ws.on('error', (err) => logger.warn({ err: err.message, serverId: server.id }, 'ws:agent-error'));
    });

    // Kick the client if HELLO is not received quickly.
    const helloTimer = setTimeout(() => {
      if (!session) this._rejectAgent(ws, 'hello timeout');
    }, 10_000);
    ws.on('close', () => clearTimeout(helloTimer));
  }

  _rejectAgent(ws, reason) {
    try {
      this._send(ws, { op: WsOp.ERROR, code: 'E_AUTH', message: reason });
      ws.close(4401, reason);
    } catch { /* noop */ }
  }

  async _onAgentFrame(session, raw) {
    let frame;
    try { frame = JSON.parse(raw.toString('utf8')); } catch { return; }
    session.lastSeen = Date.now();

    switch (frame.op) {
      case WsOp.HEARTBEAT: {
        const parsed = schemas.WsHeartbeat.safeParse(frame);
        if (!parsed.success) return;
        session.missedHeartbeats = 0;
        for (const a of parsed.data.apps) {
          applications.updateProcessState(a.id, {
            state: a.state, pid: a.pid, uptime: a.uptimeSeconds, exitCode: a.lastExitCode,
          }).catch(() => {});
        }
        this._broadcastUi({ op: 'state', serverId: session.server.id, apps: parsed.data.apps });
        return;
      }

      case WsOp.JOB_UPDATE: {
        const parsed = schemas.WsJobUpdate.safeParse(frame);
        if (!parsed.success) return;
        this._broadcastUi({ op: 'job:update', ...parsed.data });
        return;
      }

      case WsOp.JOB_RESULT: {
        const parsed = schemas.WsJobResult.safeParse(frame);
        if (!parsed.success) return;
        const pending = this.pendingJobs.get(parsed.data.jobId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingJobs.delete(parsed.data.jobId);
          if (parsed.data.success) pending.resolve(parsed.data);
          else pending.reject(Object.assign(new Error(parsed.data.error?.message ?? 'job failed'), {
            code: parsed.data.error?.code ?? 'E_JOB_FAILED',
            transient: parsed.data.error?.transient ?? true,
            meta: parsed.data,
          }));
        }
        this._broadcastUi({ op: 'job:result', ...parsed.data });
        this.onJobResult?.(parsed.data);
        return;
      }

      case WsOp.LOG_CHUNK: {
        const parsed = schemas.WsLogChunk.safeParse(frame);
        if (!parsed.success) return;
        this._broadcastUi({ op: 'log:chunk', ...parsed.data });
        return;
      }

      default:
        logger.debug({ op: frame.op }, 'ws:agent-unhandled');
    }
  }

  async _onAgentClose(session) {
    this.sessionsByServer.delete(session.server.id);
    await servers.updateStatus(session.server.id, 'offline').catch(() => {});
    logger.info({ serverId: session.server.id }, 'agent:disconnected');

    // Reject all in-flight jobs for this server so the queue retries.
    for (const [jobId, pending] of this.pendingJobs) {
      if (pending.serverId !== session.server.id) continue;
      clearTimeout(pending.timer);
      this.pendingJobs.delete(jobId);
      pending.reject(new AgentUnavailableError(session.server.id));
    }

    await writeAudit({
      actor: `agent:${session.server.name}`, action: 'agent.disconnect',
      targetType: 'server', targetId: String(session.server.id), result: 'info',
    });
  }

  // ─── UI connections ───────────────────────────────────────────────────
  _attachUi(ws, req) {
    this.uiClients.add(ws);
    ws.on('close', () => this.uiClients.delete(ws));
    ws.on('error', () => this.uiClients.delete(ws));
    // Optional: send initial snapshot.
  }

  _broadcastUi(frame) {
    const payload = JSON.stringify(frame);
    for (const ws of this.uiClients) {
      try { ws.send(payload); } catch { /* noop */ }
    }
  }

  // Close an agent's WS so it must reconnect (e.g. after token rotation).
  // Idempotent: returns false when the server isn't currently connected.
  disconnectServer(serverId, reason = 'disconnect') {
    const session = this.sessionsByServer.get(serverId);
    if (!session) return false;
    try { session.ws.close(4001, reason); } catch { /* noop */ }
    return true;
  }

  // ─── Job dispatch ─────────────────────────────────────────────────────
  /**
   * Sends an EXECUTE frame to the correct agent and resolves when the
   * agent responds with JOB_RESULT, or rejects on timeout / disconnect.
   */
  executeAndWait(serverId, executeFrame, { timeoutMs }) {
    const session = this.sessionsByServer.get(serverId);
    if (!session) return Promise.reject(new AgentUnavailableError(serverId));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(executeFrame.jobId);
        reject(new TimeoutError(`agent job ${executeFrame.jobId}`, timeoutMs));
      }, timeoutMs);
      this.pendingJobs.set(executeFrame.jobId, { resolve, reject, timer, serverId });
      this._send(session.ws, { op: WsOp.EXECUTE, ...executeFrame });
    });
  }

  _send(ws, frame) {
    try { ws.send(JSON.stringify(frame)); } catch (err) {
      logger.warn({ err: err.message }, 'ws:send-failed');
    }
  }

  startHeartbeatMonitor() {
    const interval = Math.max(5_000, this.heartbeatMs);
    this._hbTimer = setInterval(() => {
      const now = Date.now();
      for (const [serverId, session] of this.sessionsByServer) {
        if (now - session.lastSeen > interval * HEARTBEAT_MISS_LIMIT) {
          logger.warn({ serverId }, 'agent:heartbeat-missed-terminating');
          try { session.ws.terminate(); } catch { /* noop */ }
        }
      }
    }, interval);
  }

  stop() {
    clearInterval(this._hbTimer);
    for (const { ws } of this.sessionsByServer.values()) {
      try { ws.close(1001, 'controller shutdown'); } catch { /* noop */ }
    }
    for (const ws of this.uiClients) {
      try { ws.close(1001, 'controller shutdown'); } catch { /* noop */ }
    }
  }
}
