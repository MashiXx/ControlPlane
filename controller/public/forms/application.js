import { openModal, confirmModal } from '../ui/modal.js';
import { apiClient } from '../api.js';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Phase 1 ships Java-only defaults. The map is kept (rather than inlined)
// so reintroducing node/pm2 later is just a matter of adding a key.
const RUNTIME_DEFAULTS = {
  java: {
    build_cmd:        'mvn -B package',
    artifact_pattern: 'target/*.jar',
    start_cmd:        'java -jar <artifact>',
    launch_mode:      'wrapped',
  },
};

const COMMAND_FIELDS = [
  'install_cmd', 'build_cmd', 'start_cmd', 'stop_cmd',
  'status_cmd', 'logs_cmd', 'health_cmd',
];

export function openApplicationForm({
  initial, servers, serverGroups = [], groups, onSaved,
}) {
  const isEdit  = Boolean(initial);
  const running = isEdit && initial.process_state !== 'stopped';

  const form = document.createElement('form');

  const groupOpts = ['<option value="">(none)</option>'].concat(
    groups.map((g) => `<option value="${g.id}" ${initial?.group_id === g.id ? 'selected' : ''}>${escape(g.name)}</option>`),
  ).join('');

  const bannerHtml = running
    ? `<div class="banner-warn">App is <b>${escape(initial.process_state)}</b>. Changes apply after the next restart.</div>`
    : '';

  const envRaw = initial?.env
    ? (typeof initial.env === 'string' ? initial.env : JSON.stringify(initial.env, null, 2))
    : '';

  // Placement picker — exactly one of server_id / server_group_id is set.
  // Default to 'server' mode for new apps; reflect the existing choice on
  // edit. An app with no servers defined yet and no server-groups can't be
  // created, but we still render the form so the operator sees the hint.
  const initialPlacement = initial?.server_group_id != null ? 'group' : 'server';
  const serverOpts = ['<option value="">— pick a server —</option>']
    .concat(servers.map((s) =>
      `<option value="${s.id}" ${initial?.server_id === s.id ? 'selected' : ''}>${escape(s.name)} (${escape(s.hostname)})</option>`,
    )).join('');
  const serverGroupOpts = ['<option value="">— pick a server group —</option>']
    .concat(serverGroups.map((g) =>
      `<option value="${g.id}" ${initial?.server_group_id === g.id ? 'selected' : ''}>${escape(g.name)} (${g.member_count ?? 0} member${g.member_count === 1 ? '' : 's'})</option>`,
    )).join('');

  form.innerHTML = `
    ${bannerHtml}
    <fieldset><legend>Basics</legend>
      <label>Name
        <input name="name" required pattern="[a-z0-9-]{1,64}" value="${escape(initial?.name)}" ${isEdit ? '' : 'autofocus'}>
      </label>
      <label>Group
        <select name="group_id">${groupOpts}</select>
      </label>
      <label>Runtime
        <select name="runtime" required>
          <option value="java" selected>java</option>
        </select>
        <small>Node.js &amp; PM2 return in phase 2.</small>
      </label>
    </fieldset>

    <fieldset><legend>Placement</legend>
      <small>An application runs on exactly one server OR one server-group. Changing this re-syncs the app's replicas.</small>
      <label class="inline">
        <input type="radio" name="placement_mode" value="server"
               ${initialPlacement === 'server' ? 'checked' : ''}>
        Single server
      </label>
      <label class="inline">
        <input type="radio" name="placement_mode" value="group"
               ${initialPlacement === 'group' ? 'checked' : ''}>
        Server group
      </label>
      <label data-placement-block="server">Server
        <select name="server_id">${serverOpts}</select>
      </label>
      <label data-placement-block="group">Server group
        <select name="server_group_id">${serverGroupOpts}</select>
      </label>
    </fieldset>

    <fieldset><legend>Git</legend>
      <label>Repo URL (https://…, ssh://…, or git@host:path)
        <input name="repo_url" type="text" maxlength="512"
               placeholder="git@github.com:org/repo.git"
               value="${escape(initial?.repo_url)}">
      </label>
      <label>Branch
        <input name="branch" maxlength="128" value="${escape(initial?.branch ?? 'main')}">
      </label>
    </fieldset>

    <fieldset><legend>Build (on controller)</legend>
      <small>Every app builds on the controller and deploys via rsync+ssh.</small>
      <label>Install cmd
        <input name="install_cmd" maxlength="512" value="${escape(initial?.install_cmd)}">
      </label>
      <label>Build cmd
        <input name="build_cmd" maxlength="512" value="${escape(initial?.build_cmd)}">
      </label>
      <label>Artifact pattern
        <input name="artifact_pattern" maxlength="255" value="${escape(initial?.artifact_pattern)}">
      </label>
      <label>Remote install path
        <input name="remote_install_path" maxlength="512" value="${escape(initial?.remote_install_path)}">
      </label>
    </fieldset>

    <fieldset><legend>Run</legend>
      <label>Launch mode
        <select name="launch_mode">
          ${['wrapped','raw','systemd'].map((v) =>
            `<option value="${v}" ${initial?.launch_mode === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label>Workdir (absolute path)
        <input name="workdir" required maxlength="512" pattern="/[\\w\\-./]+" value="${escape(initial?.workdir)}">
      </label>
      <label>Start cmd
        <input name="start_cmd" required maxlength="512" value="${escape(initial?.start_cmd)}">
      </label>
      <label>Stop cmd
        <input name="stop_cmd" maxlength="512" value="${escape(initial?.stop_cmd)}">
      </label>
      <label>Status cmd
        <input name="status_cmd" maxlength="512" value="${escape(initial?.status_cmd)}">
      </label>
      <label>Logs cmd
        <input name="logs_cmd" maxlength="512" value="${escape(initial?.logs_cmd)}">
      </label>
      <label>Health cmd
        <input name="health_cmd" maxlength="512" value="${escape(initial?.health_cmd)}">
      </label>
      <label>Env — JSON object
        <textarea name="env" rows="4" placeholder='{"PORT":"8080","DATABASE_URL":"..."}'>${escape(envRaw)}</textarea>
      </label>
    </fieldset>

    <fieldset><legend>Advanced</legend>
      <label class="inline">
        <input type="checkbox" name="trusted" ${initial?.trusted ? 'checked' : ''}>
        Trusted (allow free-form commands — RCE risk)
      </label>
      <label class="inline">
        <input type="checkbox" name="enabled" ${initial?.enabled !== 0 ? 'checked' : ''}>
        Enabled
      </label>
    </fieldset>
  `;

  // Placement radio: show/hide the matching picker and clear the other one.
  const refreshPlacement = () => {
    const mode = form.querySelector('[name=placement_mode]:checked')?.value ?? 'server';
    for (const block of form.querySelectorAll('[data-placement-block]')) {
      block.style.display = block.dataset.placementBlock === mode ? '' : 'none';
    }
  };
  form.querySelectorAll('[name=placement_mode]').forEach((el) =>
    el.addEventListener('change', refreshPlacement));
  refreshPlacement();

  // Runtime defaults: fill blank cmd/pattern fields when runtime changes.
  form.querySelector('[name=runtime]').addEventListener('change', (e) => {
    const defaults = RUNTIME_DEFAULTS[e.target.value] ?? {};
    for (const [k, v] of Object.entries(defaults)) {
      const el = form.querySelector(`[name=${k}]`);
      if (!el) continue;
      if (el.tagName === 'SELECT') { if (!el.value) el.value = v; }
      else if (!el.value) el.value = v;
    }
  });

  // Trusted toggle: confirm + swap cmd fields between <input> and <textarea>.
  const trustedEl = form.querySelector('[name=trusted]');
  trustedEl.addEventListener('change', async () => {
    if (trustedEl.checked) {
      const ok = await confirmModal({
        title: 'Enable trusted mode?',
        message: 'Trusted apps can run arbitrary install/build/start commands on the target server. This is RCE if the repository is ever compromised. Continue?',
        confirmLabel: 'Yes, enable trusted',
        danger: true,
      });
      if (!ok) { trustedEl.checked = false; return; }
    }
    swapCommandFields(form, trustedEl.checked);
  });
  swapCommandFields(form, trustedEl.checked);

  const submit = async (close) => {
    if (!form.reportValidity()) return;
    let payload;
    try { payload = collect(form, isEdit); }
    catch (err) { alert(err.message); return; }
    try {
      const row = isEdit
        ? await apiClient.updateApp(initial.id, payload)
        : await apiClient.createApp(payload);
      close();
      onSaved?.(row);
    } catch (err) { alert(`Save failed: ${err.message}`); }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(() => handle.close());
  });

  const handle = openModal({
    title: isEdit ? `Edit app ${initial.name}` : 'New application',
    body: form,
    actions: [
      { label: 'Cancel', onClick: (h) => h.close() },
      { label: isEdit ? 'Save' : 'Create', primary: true,
        onClick: (h) => submit(() => h.close()) },
    ],
  });
}

function swapCommandFields(form, trusted) {
  for (const f of COMMAND_FIELDS) {
    const el = form.querySelector(`[name=${f}]`);
    if (!el) continue;
    const wanted = trusted ? 'TEXTAREA' : 'INPUT';
    if (el.tagName === wanted) continue;
    const val = el.value;
    const replace = document.createElement(trusted ? 'textarea' : 'input');
    replace.name = f;
    replace.value = val;
    if (trusted) {
      replace.rows = 2;
    } else {
      replace.setAttribute('type', 'text');
      replace.setAttribute('maxlength', '512');
    }
    if (f === 'start_cmd') replace.setAttribute('required', 'true');
    el.replaceWith(replace);
  }
}

function collect(form, isEdit) {
  const fd = new FormData(form);
  const payload = {};

  const copyStr = (k) => {
    const v = fd.get(k);
    if (v != null && String(v).trim() !== '') payload[k] = String(v).trim();
  };

  copyStr('name');
  const gid = fd.get('group_id');
  if (gid === '') payload.group_id = null;
  else if (gid != null) payload.group_id = Number(gid);

  // Placement: exactly one of server_id / server_group_id is sent.
  // The other is explicitly nulled so the PATCH handler switches modes
  // cleanly without tripping the XOR check constraint.
  const mode = fd.get('placement_mode');
  if (mode === 'server') {
    const sid = fd.get('server_id');
    if (!sid) throw new Error('Placement: pick a server');
    payload.server_id = Number(sid);
    payload.server_group_id = null;
  } else if (mode === 'group') {
    const sgid = fd.get('server_group_id');
    if (!sgid) throw new Error('Placement: pick a server group');
    payload.server_group_id = Number(sgid);
    payload.server_id = null;
  } else {
    throw new Error('Placement: pick server or server group');
  }

  copyStr('runtime');
  copyStr('artifact_pattern');
  copyStr('remote_install_path');
  copyStr('repo_url');
  copyStr('branch');
  copyStr('workdir');
  copyStr('launch_mode');
  for (const k of COMMAND_FIELDS) copyStr(k);

  const envRaw = String(fd.get('env') || '').trim();
  if (envRaw) {
    try { payload.env = JSON.parse(envRaw); }
    catch (e) { throw new Error(`env: invalid JSON — ${e.message}`); }
  }

  payload.trusted = Boolean(fd.get('trusted'));
  payload.enabled = Boolean(fd.get('enabled'));
  return payload;
}

export function confirmDeleteApp(app) {
  return confirmModal({
    title: `Delete app "${app.name}"?`,
    message: 'DELETE the application row and cascade-delete its artifacts and deployments (build history will be lost). The app must have Enabled=off and process_state=stopped before deletion.',
    confirmLabel: 'Delete permanently',
    danger: true,
  });
}
