import { apiClient } from '../api.js';
import { openModal } from '../ui/modal.js';

// Per-app replicas dialog.
//
// Placement (single server OR single server-group) lives on the app row, so
// operators don't add/remove replicas here anymore — change placement by
// editing the app, or change the server-group's membership. This dialog is
// read-only plus the per-row action buttons (Restart / Stop / Deploy) that
// submit a narrowed action against one replica.
export async function openReplicasDialog(app, _allServers) {
  const replicas = await apiClient.listReplicas(app.id);
  _renderDialog(app, replicas);
}

function _renderDialog(app, replicas) {
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const placementLine = app.server_name
    ? `Placement: <b>server</b> <code>${escape(app.server_name)}</code>`
    : app.server_group_name
      ? `Placement: <b>server-group</b> <code>${escape(app.server_group_name)}</code>`
      : `<em>No placement — edit the application to pin it.</em>`;

  const body = document.createElement('div');
  body.innerHTML = `
    <p>${placementLine}</p>
    <p class="hint">Replicas are derived from placement. To add or remove a
      target server, either edit the app (for single-server placement) or
      edit the server-group membership.</p>
    <table class="replicas">
      <thead>
        <tr>
          <th>Server</th><th>State</th><th>Expected</th>
          <th>PID</th><th>Release</th><th></th>
        </tr>
      </thead>
      <tbody>${replicas.length === 0
        ? '<tr><td colspan="6"><em>No replicas.</em></td></tr>'
        : replicas.map((r) => `
        <tr data-server-id="${r.server_id}">
          <td>${escape(r.server_name)}</td>
          <td class="state-${escape(r.process_state)}">${escape(r.process_state)}</td>
          <td>${escape(r.expected_state)}</td>
          <td>${r.pid ?? '-'}</td>
          <td>${r.current_release_id ?? '-'}</td>
          <td>
            <button data-action="restart">Restart</button>
            <button data-action="stop">Stop</button>
            <button data-action="deploy">Deploy</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;

  // Wire per-row action buttons (Restart / Stop / Deploy).
  body.querySelectorAll('tr[data-server-id]').forEach((tr) => {
    const serverId = Number(tr.getAttribute('data-server-id'));
    tr.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const action = btn.getAttribute('data-action');
        try {
          await apiClient.submitAction(action, app.id, { serverId });
          handle.close();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  });

  const handle = openModal({
    title: `Replicas of ${app.name}`,
    body,
    actions: [
      { label: 'Close', onClick: (h) => h.close() },
    ],
  });
}
