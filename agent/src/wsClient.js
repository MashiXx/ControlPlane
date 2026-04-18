// WebSocket client that stays connected to the controller.
//
// Features:
//   - bearer-token auth on the initial HELLO frame
//   - auto-reconnect with exponential backoff + jitter
//   - heartbeat every N ms; includes current ProcessManager snapshot
//   - inbound frame dispatch to a user-provided handler table
//   - outbound helpers: sendJobUpdate, sendJobResult, sendLogChunk

import WebSocket from 'ws';
import { WsOp } from '@cp/shared/constants';
import { serializeError } from '@cp/shared/errors';

export class AgentWsClient {
  /**
   * @param {object} params
   * @param {object} params.config
   * @param {object} params.logger
   * @param {(op, frame) => Promise<void>} params.onFrame
   * @param {() => Array}  params.getAppsSnapshot
   */
  constructor({ config, logger, onFrame, getAppsSnapshot }) {
    this.config = config;
    this.logger = logger;
    this.onFrame = onFrame;
    this.getAppsSnapshot = getAppsSnapshot;

    this.ws = null;
    this.connected = false;
    this.shouldRun = false;
    this.reconnectDelay = config.reconnectMinMs;
    this.heartbeatTimer = null;
  }

  start() {
    this.shouldRun = true;
    this.connect();
  }

  async stop() {
    this.shouldRun = false;
    clearInterval(this.heartbeatTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(1000, 'agent shutdown'); } catch { /* noop */ }
    }
  }

  connect() {
    if (!this.shouldRun) return;
    this.logger.info({ url: this.config.controllerUrl }, 'ws:connect');
    this.ws = new WebSocket(this.config.controllerUrl, {
      headers: { Authorization: `Bearer ${this.config.authToken}` },
      handshakeTimeout: 10_000,
    });

    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('close', (code, reason) => this._onClose(code, reason?.toString()));
    this.ws.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'ws:error');
    });
  }

  _onOpen() {
    this.connected = true;
    this.reconnectDelay = this.config.reconnectMinMs;
    this.logger.info('ws:open');
    this._send(WsOp.HELLO, {
      agentId:   this.config.agentId,
      authToken: this.config.authToken,
      version:   this.config.version,
      os:        this.config.os,
    });
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this._heartbeat(), this.config.heartbeatMs);
  }

  _onClose(code, reason) {
    this.connected = false;
    clearInterval(this.heartbeatTimer);
    this.logger.warn({ code, reason }, 'ws:close');
    if (!this.shouldRun) return;
    const jitter = Math.floor(Math.random() * 500);
    const delay = Math.min(this.reconnectDelay, this.config.reconnectMaxMs) + jitter;
    this.logger.info({ delay }, 'ws:reconnect-scheduled');
    setTimeout(() => this.connect(), delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.reconnectMaxMs);
  }

  async _onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch (err) {
      this.logger.warn({ err: err.message }, 'ws:bad-json');
      return;
    }
    try {
      await this.onFrame(frame.op, frame);
    } catch (err) {
      this.logger.error({ op: frame?.op, err: serializeError(err) }, 'ws:handler-error');
      if (frame?.jobId) {
        this.sendError(frame.jobId, err);
      }
    }
  }

  _heartbeat() {
    this._send(WsOp.HEARTBEAT, {
      ts: Date.now(),
      apps: this.getAppsSnapshot?.() ?? [],
    });
  }

  _send(op, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ op, ts: Date.now(), ...payload }));
      return true;
    } catch (err) {
      this.logger.warn({ op, err: err.message }, 'ws:send-failed');
      return false;
    }
  }

  sendJobUpdate(jobId, phase, extra = {}) {
    this._send(WsOp.JOB_UPDATE, { jobId, phase, ...extra });
  }

  sendJobResult(jobId, result) {
    this._send(WsOp.JOB_RESULT, { jobId, ...result });
  }

  sendLogChunk(jobId, stream, buf) {
    this._send(WsOp.LOG_CHUNK, { jobId, stream, dataB64: Buffer.from(buf).toString('base64') });
  }

  sendError(jobId, err) {
    const s = serializeError(err);
    this._send(WsOp.ERROR, { jobId, code: s.code, message: s.message });
  }
}
