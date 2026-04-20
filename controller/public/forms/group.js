import { openModal, confirmModal } from '../ui/modal.js';
import { apiClient } from '../api.js';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openGroupForm({ initial, onSaved }) {
  const isEdit = Boolean(initial);
  const form = document.createElement('form');
  form.noValidate = false;
  form.innerHTML = `
    <label>Name
      <input name="name" required pattern="[a-z0-9-]{1,64}"
             value="${escape(initial?.name)}" ${isEdit ? '' : 'autofocus'}>
    </label>
    <label>Description
      <input name="description" maxlength="255" value="${escape(initial?.description)}">
    </label>
  `;

  const submit = async (close) => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const description = String(fd.get('description') || '').trim();
    const payload = { name, ...(description ? { description } : {}) };
    try {
      const row = isEdit
        ? await apiClient.updateGroup(initial.id, payload)
        : await apiClient.createGroup(payload);
      close();
      onSaved?.(row);
    } catch (err) { alert(`Save failed: ${err.message}`); }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(() => handle.close());
  });

  const handle = openModal({
    title: isEdit ? `Edit group ${initial.name}` : 'New group',
    body: form,
    actions: [
      { label: 'Cancel', onClick: (h) => h.close() },
      { label: isEdit ? 'Save' : 'Create', primary: true,
        onClick: (h) => submit(() => h.close()) },
    ],
  });
}

export function confirmDeleteGroup(group) {
  return confirmModal({
    title: `Delete group "${group.name}"?`,
    message: 'Applications currently in this group will become ungrouped. The group row itself will be deleted. This cannot be undone.',
    confirmLabel: 'Delete group',
    danger: true,
  });
}
