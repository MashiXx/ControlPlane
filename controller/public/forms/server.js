import { openModal, confirmModal } from '../ui/modal.js';
import { apiClient } from '../api.js';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openServerForm({ initial, onSaved }) {
  const isEdit = Boolean(initial);
  const form = document.createElement('form');
  const labels = initial?.labels ? JSON.stringify(initial.labels, null, 2) : '';

  form.innerHTML = `
    <label>Name
      <input name="name" required pattern="[a-z0-9-]{1,64}"
             value="${escape(initial?.name)}" ${isEdit ? 'disabled' : 'autofocus'}>
    </label>
    <label>Hostname — DNS name, IP, or Host alias from controller's ~/.ssh/config
      <input name="hostname" required maxlength="255" value="${escape(initial?.hostname)}">
    </label>
    <label>Labels — JSON object, optional
      <textarea name="labels" rows="3" placeholder='{"region":"eu","env":"prod"}'>${escape(labels)}</textarea>
    </label>
    <small>
      The controller reaches this server over SSH using the hostname above.
      Add a matching entry (with <code>User</code>, <code>IdentityFile</code>,
      optional <code>ProxyJump</code> / <code>ControlMaster</code>) to the
      controller's <code>~/.ssh/config</code>.
    </small>
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
        labels: parseJSONField('labels'),
      };
      if (!isEdit) payload.name = String(fd.get('name') || '').trim();
    } catch (err) { alert(err.message); return; }

    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

    try {
      const row = isEdit
        ? await apiClient.updateServer(initial.id, payload)
        : await apiClient.createServer(payload);
      close();
      onSaved?.(row);
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

export function confirmDeleteServer(server) {
  return confirmModal({
    title: `Delete server "${server.name}"?`,
    message: 'This fails if any application still references this server. Delete or migrate those apps first.',
    confirmLabel: 'Delete server',
    danger: true,
  });
}
