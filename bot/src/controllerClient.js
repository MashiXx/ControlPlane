// Thin controller API client used by the bot. No business logic here.

import { AuthError, ControlPlaneError } from '@cp/shared/errors';

export class ControllerClient {
  constructor({ baseUrl, apiToken }) {
    if (!baseUrl || !apiToken) {
      throw new Error('ControllerClient requires baseUrl and apiToken');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiToken = apiToken;
  }

  async _fetch(path, init = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiToken}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401) throw new AuthError(msg);
      throw new ControlPlaneError(msg, { code: body?.error?.code ?? `HTTP_${res.status}` });
    }
    return body;
  }

  listGroups()        { return this._fetch('/api/groups'); }
  listApplications()  { return this._fetch('/api/applications'); }
  listServers()       { return this._fetch('/api/servers'); }
  getApplication(id)  { return this._fetch(`/api/applications/${id}`); }
  getJob(id)          { return this._fetch(`/api/jobs/${id}`); }
  metrics()           { return this._fetch('/api/metrics'); }

  enqueue({ action, target }) {
    return this._fetch('/api/actions', {
      method: 'POST',
      body: JSON.stringify({ action, target }),
    });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
