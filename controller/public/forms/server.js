import { openModal, confirmModal } from '../ui/modal.js';
import { apiClient } from '../api.js';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showTokenModal({ server, rawToken }) {
  const snippet = `AGENT_SERVER_NAME=${server.name} AGENT_CONTROLLER_TOKEN=${rawToken} npm run dev:agent`;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="banner-warn">
      Copy this token now — it cannot be retrieved later. Lose it and you must rotate.
    </div>
    <label>Raw token
      <div class="token-reveal">${escape(rawToken)}</div>
    </label>
    <label>Start the agent
      <div class="token-reveal">${escape(snippet)}</div>
    </label>
  `;
  openModal({
    title: `Token for server "${server.name}"`,
    body,
    actions: [{ label: 'I saved it', primary: true, onClick: (h) => h.close() }],
  });
}

export function openServerForm({ initial, onSaved }) {
  const isEdit = Boolean(initial);
  const form = document.createElement('form');
  const labels = initial?.labels ? JSON.stringify(initial.labels, null, 2) : '';
  const ssh    = initial?.ssh_config ? JSON.stringify(initial.ssh_config, null, 2) : '';

  form.innerHTML = `
    <label>Name
      <input name="name" required pattern="[a-z0-9-]{1,64}"
             value="${escape(initial?.name)}" ${isEdit ? 'disabled' : 'autofocus'}>
    </label>
    <label>Hostname
      <input name="hostname" required maxlength="255" value="${escape(initial?.hostname)}">
    </label>
    <label>Artifact transfer
      <select name="artifact_transfer" required>
        <option value="http"  ${initial?.artifact_transfer === 'http'  ? 'selected' : ''}>http (agent pulls)</option>
        <option value="rsync" ${initial?.artifact_transfer === 'rsync' ? 'selected' : ''}>rsync (controller pushes)</option>
      </select>
    </label>
    <label>Labels — JSON object, optional
      <textarea name="labels" rows="3" placeholder='{"region":"eu","env":"prod"}'>${escape(labels)}</textarea>
    </label>
    <label>SSH config — required when transfer=rsync
      <textarea name="ssh_config" rows="5"
                placeholder='{"user":"deploy","host":"1.2.3.4","port":22,"key_path":"/home/ci/.ssh/id_rsa"}'>${escape(ssh)}</textarea>
    </label>
  `;

  function parseJSONField(name) {
    const s = String(new FormData(form).get(name) || '').trim();
    if (!s) return undefined;
    try { return JSON.parse(s); }
    catch (e) { throw new Error(`${name}: invalid JSON — ${e.message}`); }
  }

  const submit = async (close) => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    let payload;
    try {
      payload = {
        hostname: String(fd.get('hostname') || '').trim(),
        artifact_transfer: String(fd.get('artifact_transfer') || ''),
        labels:     parseJSONField('labels'),
        ssh_config: parseJSONField('ssh_config'),
      };
      if (!isEdit) payload.name = String(fd.get('name') || '').trim();
    } catch (err) { alert(err.message); return; }

    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

    try {
      if (isEdit) {
        const row = await apiClient.updateServer(initial.id, payload);
        close();
        onSaved?.(row);
      } else {
        const { server, rawToken } = await apiClient.createServer(payload);
        close();
        showTokenModal({ server, rawToken });
        onSaved?.(server);
      }
    } catch (err) { alert(`Save failed: ${err.message}`); }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(() => handle.close());
  });

  const handle = openModal({
    title: isEdit ? `Edit server ${initial.name}` : 'New server',
    body: form,
    actions: [
      { label: 'Cancel', onClick: (h) => h.close() },
      { label: isEdit ? 'Save' : 'Create', primary: true,
        onClick: (h) => submit(() => h.close()) },
    ],
  });
}

export async function rotateServerToken(server, onDone) {
  const ok = await confirmModal({
    title: `Rotate token for "${server.name}"?`,
    message: 'The connected agent will be kicked. It will reconnect only after you update AGENT_CONTROLLER_TOKEN on that host and restart it.',
    confirmLabel: 'Rotate token',
    danger: true,
  });
  if (!ok) return;
  try {
    const { rawToken } = await apiClient.rotateServerToken(server.id);
    showTokenModal({ server, rawToken });
    onDone?.();
  } catch (err) { alert(`Rotate failed: ${err.message}`); }
}

export function confirmDeleteServer(server) {
  return confirmModal({
    title: `Delete server "${server.name}"?`,
    message: 'This fails if any application still references this server. Delete or migrate those apps first.',
    confirmLabel: 'Delete server',
    danger: true,
  });
}
