import { openModal, confirmModal } from '../ui/modal.js';
import { apiClient } from '../api.js';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Edit / create form for a server_group. Membership is expressed as a
// checkbox list of servers — the API accepts a `serverIds` array and
// atomically replaces the membership, so we send whatever the checkboxes
// say and let the backend reconcile.
export async function openServerGroupForm({ initial, servers, onSaved }) {
  const isEdit = Boolean(initial);
  let currentMemberIds = new Set();
  if (isEdit) {
    try {
      const detail = await apiClient.getServerGroup(initial.id);
      currentMemberIds = new Set((detail.members ?? []).map((s) => s.id));
    } catch { /* fall back to empty */ }
  }

  const form = document.createElement('form');
  const memberOpts = servers.length === 0
    ? '<em>(no servers defined yet — create one first)</em>'
    : servers.map((s) => `
        <label class="inline">
          <input type="checkbox" name="serverIds" value="${s.id}"
            ${currentMemberIds.has(s.id) ? 'checked' : ''}>
          ${escape(s.name)}
          <small>${escape(s.hostname)} · ${escape(s.artifact_transfer)}</small>
        </label>`).join('');

  form.innerHTML = `
    <label>Name
      <input name="name" required pattern="[a-z0-9-]{1,64}"
             value="${escape(initial?.name)}" ${isEdit ? '' : 'autofocus'}>
    </label>
    <label>Description
      <input name="description" maxlength="255" value="${escape(initial?.description)}">
    </label>
    <fieldset><legend>Members</legend>
      ${memberOpts}
    </fieldset>
  `;

  const submit = async (close) => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const description = String(fd.get('description') || '').trim();
    const serverIds = fd.getAll('serverIds').map((v) => Number(v)).filter(Number.isFinite);

    const payload = {
      ...(isEdit ? {} : { name }),
      ...(description ? { description } : (isEdit ? { description: null } : {})),
      serverIds,
    };
    // On edit, name changes are allowed via PATCH.
    if (isEdit && name && name !== initial.name) payload.name = name;

    try {
      const row = isEdit
        ? await apiClient.updateServerGroup(initial.id, payload)
        : await apiClient.createServerGroup(payload);
      close();
      onSaved?.(row);
    } catch (err) { alert(`Save failed: ${err.message}`); }
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(() => handle.close()); });

  const handle = openModal({
    title: isEdit ? `Edit server group ${initial.name}` : 'New server group',
    body: form,
    actions: [
      { label: 'Cancel', onClick: (h) => h.close() },
      { label: isEdit ? 'Save' : 'Create', primary: true,
        onClick: (h) => submit(() => h.close()) },
    ],
  });
}

export function confirmDeleteServerGroup(group) {
  return confirmModal({
    title: `Delete server group "${group.name}"?`,
    message: 'This only removes the group and its membership rows — the servers themselves stay untouched. Apps deploying to this group will need a new target.',
    confirmLabel: 'Delete server group',
    danger: true,
  });
}

// Prompt for an app + optional commit sha, then enqueue a controller-built
// deploy fanned out across every member of `group`.
export async function deployToServerGroup({ group, apps, onEnqueued }) {
  const deployable = apps.filter((a) => a.build_strategy === 'controller' && a.enabled);
  if (deployable.length === 0) {
    alert('No app with build_strategy=controller is available. Server-group deploy fans a single artifact out to N servers, which requires a controller build.');
    return;
  }
  const form = document.createElement('form');
  form.innerHTML = `
    <label>Application
      <select name="applicationId" required>
        ${deployable.map((a) =>
          `<option value="${a.id}">${escape(a.name)}</option>`).join('')}
      </select>
    </label>
    <label>Commit sha (optional — pin a specific revision)
      <input name="commitSha" maxlength="40" placeholder="HEAD">
    </label>
  `;
  const submit = async (close) => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const applicationId = Number(fd.get('applicationId'));
    const commitShaRaw = String(fd.get('commitSha') || '').trim();
    const options = { applicationId };
    if (commitShaRaw) options.commitSha = commitShaRaw;
    try {
      await apiClient.enqueue('deploy', { type: 'server_group', id: group.name }, options);
      close();
      onEnqueued?.();
    } catch (err) { alert(`Enqueue failed: ${err.message}`); }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(() => handle.close()); });
  const handle = openModal({
    title: `Deploy to server group "${group.name}"`,
    body: form,
    actions: [
      { label: 'Cancel', onClick: (h) => h.close() },
      { label: 'Deploy', primary: true, onClick: (h) => submit(() => h.close()) },
    ],
  });
}
