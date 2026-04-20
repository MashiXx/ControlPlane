import { openModal, confirmModal } from '../ui/modal.js';
import { apiClient } from '../api.js';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RUNTIME_DEFAULTS = {
  node: {
    install_cmd: 'npm ci',
    build_cmd:   'npm run build',
    start_cmd:   'node dist/index.js',
    launch_mode: 'wrapped',
  },
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

export function openApplicationForm({ initial, servers, groups, onSaved }) {
  const isEdit  = Boolean(initial);
  const running = isEdit && initial.process_state !== 'stopped';
  const form    = document.createElement('form');

  const serverOpts = servers.map((s) =>
    `<option value="${s.id}" ${initial?.server_id === s.id ? 'selected' : ''}>${escape(s.name)}</option>`,
  ).join('');
  const groupOpts = ['<option value="">(none)</option>'].concat(
    groups.map((g) => `<option value="${g.id}" ${initial?.group_id === g.id ? 'selected' : ''}>${escape(g.name)}</option>`),
  ).join('');

  const bannerHtml = running
    ? `<div class="banner-warn">App is <b>${escape(initial.process_state)}</b>. Changes apply after the next restart.</div>`
    : '';

  const envRaw = initial?.env
    ? (typeof initial.env === 'string' ? initial.env : JSON.stringify(initial.env, null, 2))
    : '';

  form.innerHTML = `
    ${bannerHtml}
    <fieldset><legend>Basics</legend>
      <label>Name
        <input name="name" required pattern="[a-z0-9-]{1,64}" value="${escape(initial?.name)}">
      </label>
      <label>Server
        <select name="server_id" required ${isEdit ? 'disabled' : ''}>${serverOpts}</select>
      </label>
      <label>Group <select name="group_id">${groupOpts}</select></label>
      <label>Runtime
        <select name="runtime" required>
          <option value="node" ${initial?.runtime === 'node' ? 'selected' : ''}>node</option>
          <option value="java" ${initial?.runtime === 'java' ? 'selected' : ''}>java</option>
        </select>
      </label>
    </fieldset>

    <fieldset><legend>Git</legend>
      <label>Repo URL <input name="repo_url" type="url" maxlength="512" value="${escape(initial?.repo_url)}"></label>
      <label>Branch  <input name="branch" maxlength="128" value="${escape(initial?.branch ?? 'main')}"></label>
    </fieldset>

    <fieldset><legend>Build</legend>
      <label>Build strategy
        <select name="build_strategy">
          ${['target','controller','builder'].map((v) =>
            `<option value="${v}" ${initial?.build_strategy === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label>Install cmd         <input name="install_cmd"         maxlength="512" value="${escape(initial?.install_cmd)}"></label>
      <label>Build cmd           <input name="build_cmd"           maxlength="512" value="${escape(initial?.build_cmd)}"></label>
      <label>Artifact pattern    <input name="artifact_pattern"    maxlength="255" value="${escape(initial?.artifact_pattern)}"></label>
      <label>Remote install path <input name="remote_install_path" maxlength="512" value="${escape(initial?.remote_install_path)}"></label>
    </fieldset>

    <fieldset><legend>Run</legend>
      <label>Launch mode
        <select name="launch_mode">
          ${['wrapped','raw','pm2','systemd'].map((v) =>
            `<option value="${v}" ${initial?.launch_mode === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label>Workdir    <input name="workdir" required maxlength="512" value="${escape(initial?.workdir)}"></label>
      <label>Start cmd  <input name="start_cmd" required maxlength="512" value="${escape(initial?.start_cmd)}"></label>
      <label>Stop cmd   <input name="stop_cmd"   maxlength="512" value="${escape(initial?.stop_cmd)}"></label>
      <label>Status cmd <input name="status_cmd" maxlength="512" value="${escape(initial?.status_cmd)}"></label>
      <label>Logs cmd   <input name="logs_cmd"   maxlength="512" value="${escape(initial?.logs_cmd)}"></label>
      <label>Health cmd <input name="health_cmd" maxlength="512" value="${escape(initial?.health_cmd)}"></label>
      <label>Env (JSON object)
        <textarea name="env" rows="4">${escape(envRaw)}</textarea>
      </label>
    </fieldset>

    <fieldset><legend>Advanced</legend>
      <label><input type="checkbox" name="trusted" ${initial?.trusted ? 'checked' : ''}>
        Trusted (allow free-form commands — RCE risk)
      </label>
      <label><input type="checkbox" name="enabled" ${initial?.enabled !== 0 ? 'checked' : ''}>
        Enabled
      </label>
    </fieldset>
  `;

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

  openModal({
    title: isEdit ? `Edit app ${initial.name}` : 'New application',
    body: form,
    actions: [
      { label: 'Cancel', onClick: (h) => h.close() },
      { label: isEdit ? 'Save' : 'Create', primary: true, onClick: async (h) => {
        let payload;
        try { payload = collect(form, isEdit); }
        catch (err) { alert(err.message); return; }
        try {
          const row = isEdit
            ? await apiClient.updateApp(initial.id, payload)
            : await apiClient.createApp(payload);
          h.close();
          onSaved?.(row);
        } catch (err) { alert(`Save failed: ${err.message}`); }
      }},
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
    if (!trusted) {
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
  if (!isEdit) {
    const sid = fd.get('server_id');
    if (sid != null && String(sid) !== '') payload.server_id = Number(sid);
  }
  const gid = fd.get('group_id');
  if (gid === '') payload.group_id = null;
  else if (gid != null) payload.group_id = Number(gid);

  copyStr('runtime');
  copyStr('build_strategy');
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
    message: 'DELETE the application row and cascade-delete its artifacts and deployments (build history will be lost). The app must be enabled=false and stopped before deletion.',
    confirmLabel: 'Delete permanently',
    danger: true,
  });
}
