// Dashboard WebSocket hub. Post-agentless the only WS traffic the controller
// serves is /ui — browsers subscribing for live job/log/state/alert updates.
// The agent-facing /agent endpoint is gone along with the agent process.
//
// Messages are one-way (controller → browser). Nothing the UI sends over
// the socket is trusted; REST endpoints handle writes.

import { WebSocketServer } from 'ws';
import { parse as parseCookie } from 'cookie';

import { createLogger } from '@cp/shared/logger';
import { SESSION_COOKIE_NAME, verifySessionToken } from '../auth/session.js';

const logger = createLogger({ service: 'ws.ui' });

export class UiHub {
  constructor({ httpServer, sessionSecret }) {
    this.sessionSecret = sessionSecret;
    /** @type {Set<import('ws').WebSocket>} */
    this.uiClients = new Set();

    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ui') {
      socket.destroy();
      return;
    }
    if (!this._authOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._attach(ws));
  }

  _authOk(req) {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const v = verifySessionToken(this.sessionSecret, cookies[SESSION_COOKIE_NAME]);
    return v.ok;
  }

  _attach(ws) {
    this.uiClients.add(ws);
    ws.on('close', () => this.uiClients.delete(ws));
    ws.on('error', () => this.uiClients.delete(ws));
  }

  broadcast(frame) {
    if (this.uiClients.size === 0) return;
    let payload;
    try { payload = JSON.stringify(frame); }
    catch (err) { logger.warn({ err: err.message }, 'ui:serialize-failed'); return; }
    for (const ws of this.uiClients) {
      try { ws.send(payload); } catch { /* noop */ }
    }
  }

  stop() {
    for (const ws of this.uiClients) {
      try { ws.close(1001, 'controller shutdown'); } catch { /* noop */ }
    }
  }
}
