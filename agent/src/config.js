import os from 'node:os';
import path from 'node:path';

export function loadAgentConfig() {
  const cfg = {
    agentId:       process.env.AGENT_ID       ?? `agent-${os.hostname()}`,
    serverName:    process.env.AGENT_SERVER_NAME ?? os.hostname(),
    controllerUrl: process.env.CONTROLLER_WS_URL ?? 'ws://127.0.0.1:8080/agent',
    authToken:     process.env.AGENT_AUTH_TOKEN ?? '',
    heartbeatMs:   Number(process.env.AGENT_HEARTBEAT_MS ?? 10_000),
    workdir:       process.env.AGENT_WORKDIR ?? path.resolve(os.tmpdir(), 'controlplane-apps'),
    version:       process.env.npm_package_version ?? '0.1.0',
    os:            `${os.type()} ${os.release()} (${os.arch()})`,
    // Reconnect backoff
    reconnectMinMs: 1_000,
    reconnectMaxMs: 30_000,
  };
  if (!cfg.authToken) {
    throw new Error('AGENT_AUTH_TOKEN is required');
  }
  return cfg;
}
