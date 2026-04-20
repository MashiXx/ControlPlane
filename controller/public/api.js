// Typed fetch helpers for the dashboard. All requests are same-origin and
// rely on the cp_session cookie set by /auth/login. On 401 we redirect to
// /login.html so the operator can re-authenticate.

const base = '/api';

async function request(method, path, body) {
  const res = await fetch(base + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = parsed?.error?.message ?? text ?? `${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = parsed?.error?.code;
    throw err;
  }
  return parsed;
}

export const apiClient = {
  listApps:    () => request('GET', '/applications'),
  listGroups:  () => request('GET', '/groups'),
  listServers: () => request('GET', '/servers'),
  listJobs:    () => request('GET', '/jobs?limit=50'),
  listAudit:   () => request('GET', '/audit?limit=50'),

  createApp: (body)       => request('POST',   '/applications', body),
  updateApp: (id, patch)  => request('PATCH',  `/applications/${id}`, patch),
  deleteApp: (id)         => request('DELETE', `/applications/${id}`),

  createGroup: (body)     => request('POST',   '/groups', body),
  updateGroup: (id, patch)=> request('PATCH',  `/groups/${id}`, patch),
  deleteGroup: (id)       => request('DELETE', `/groups/${id}`),

  createServer:      (body)      => request('POST',   '/servers', body),
  updateServer:      (id, patch) => request('PATCH',  `/servers/${id}`, patch),
  rotateServerToken: (id)        => request('POST',   `/servers/${id}/rotate-token`),
  deleteServer:      (id)        => request('DELETE', `/servers/${id}`),

  enqueue: (action, target) => request('POST', '/actions', { action, target }),
};
