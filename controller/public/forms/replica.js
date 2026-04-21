import { apiClient } from '../api.js';
import { openModal } from '../ui/modal.js';

// Open the per-app replicas management dialog.
// `app`        — the application row from state.apps
// `allServers` — full server list from state.servers (used to populate the
//                "Add server" select with candidates not yet registered).
export async function openReplicasDialog(app, allServers) {
  const replicas = await apiClient.listReplicas(app.id);
  _renderDialog(app, allServers, replicas);
}

function _renderDialog(app, allServers, replicas) {
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const registeredIds = new Set(replicas.map((r) => r.server_id));
  const candidates = allServers.filter(
    (s) => !registeredIds.has(s.id) && s.status !== 'draining',
  );

  const body = document.createElement('div');
  body.innerHTML = `
    <table class="replicas">
      <thead>
        <tr>
          <th>Server</th><th>State</th><th>Expected</th>
          <th>PID</th><th>Release</th><th></th>
        </tr>
      </thead>
      <tbody>${replicas.length === 0
        ? '<tr><td colspan="6"><em>No replicas registered yet.</em></td></tr>'
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
            <button data-action="remove" class="danger">Remove</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
    <hr/>
    <form class="add-replica">
      <label>Add server as replica:
        <select name="serverId">
          ${candidates.map((s) =>
            `<option value="${s.id}">${escape(s.name)} (${escape(s.hostname)})</option>`,
          ).join('')}
        </select>
      </label>
      <button type="submit" ${candidates.length === 0 ? 'disabled' : ''}>Add</button>
    </form>
  `;

  // Wire per-row action buttons (Restart / Stop / Deploy / Remove).
  body.querySelectorAll('tr[data-server-id]').forEach((tr) => {
    const serverId = Number(tr.getAttribute('data-server-id'));
    tr.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const action = btn.getAttribute('data-action');
        try {
          if (action === 'remove') {
            if (!confirm('Remove this replica? The app will no longer be managed on that server.')) return;
            await apiClient.removeReplica(app.id, serverId);
          } else {
            await apiClient.submitAction(action, app.id, { serverId });
          }
          handle.close();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  });

  // Wire the "Add server" form.
  body.querySelector('form.add-replica').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const serverId = Number(ev.target.serverId.value);
    try {
      await apiClient.addReplica(app.id, serverId);
      handle.close();
    } catch (err) {
      alert(err.message);
    }
  });

  const handle = openModal({
    title: `Replicas of ${app.name}`,
    body,
    actions: [
      { label: 'Close', onClick: (h) => h.close() },
    ],
  });
}
