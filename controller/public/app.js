// Web dashboard SPA. Minimal, no frameworks.

import { apiClient } from './api.js';
import { openGroupForm, confirmDeleteGroup } from './forms/group.js';
import { openServerForm, rotateServerToken, confirmDeleteServer } from './forms/server.js';
import { openApplicationForm, confirmDeleteApp } from './forms/application.js';

const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ui`;

// ─── state ──────────────────────────────────────────────────────────────
const state = {
  apps: [],
  groups: [],
  servers: [],
  jobs: [],
  audit: [],
  filterGroupId: '',
};

// ─── dom helpers ────────────────────────────────────────────────────────
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function badge(cls, text) { return el('span', { class: `badge st-${cls}` }, text); }

// ─── data ───────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const [apps, groups, servers, jobs, audit] = await Promise.all([
      apiClient.listApps(),
      apiClient.listGroups(),
      apiClient.listServers(),
      apiClient.listJobs(),
      apiClient.listAudit(),
    ]);
    state.apps = apps; state.groups = groups; state.servers = servers;
    state.jobs = jobs; state.audit = audit;
    renderGroupsFilter();
    renderApps(); renderJobs(); renderAudit();
    renderGroupsTab(); renderServersTab();
  } catch (err) {
    if (err.message !== 'unauthenticated') console.warn('refresh failed:', err);
  }
}

async function enqueue(action, target) {
  try {
    await apiClient.enqueue(action, target);
    await refresh();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

// ─── render ─────────────────────────────────────────────────────────────
function renderGroupsFilter() {
  const sel = $('#groupFilter');
  sel.innerHTML = '<option value="">All groups</option>' +
    state.groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  sel.value = state.filterGroupId;
}

function renderApps() {
  const tbody = $('#apps-table tbody');
  tbody.replaceChildren();
  const filtered = state.filterGroupId
    ? state.apps.filter((a) => String(a.group_id) === state.filterGroupId)
    : state.apps;

  for (const a of filtered) {
    const groupName  = state.groups.find((g) => g.id === a.group_id)?.name ?? '-';
    const serverName = state.servers.find((s) => s.id === a.server_id)?.name ?? String(a.server_id);
    const row = el('tr', {}, [
      el('td', {}, a.name),
      el('td', {}, groupName),
      el('td', {}, serverName),
      el('td', {}, a.runtime),
      el('td', {}, [badge(a.process_state, a.process_state)]),
      el('td', {}, a.pid == null ? '-' : String(a.pid)),
      el('td', {}, a.uptime_seconds ? `${a.uptime_seconds}s` : '-'),
      el('td', {}, [
        el('button', { onclick: () => enqueue('restart', { type: 'app', id: a.id }) }, 'Restart'),
        el('button', { onclick: () => enqueue('build',   { type: 'app', id: a.id }) }, 'Build'),
        el('button', { onclick: () => openApplicationForm({
          initial: a, servers: state.servers, groups: state.groups, onSaved: refresh,
        })}, 'Edit'),
        el('button', { class: 'danger', onclick: async () => {
          if (await confirmDeleteApp(a)) {
            try { await apiClient.deleteApp(a.id); await refresh(); }
            catch (err) { alert(`Delete failed: ${err.message}`); }
          }
        }}, 'Delete'),
      ]),
    ]);
    tbody.appendChild(row);
  }
}

function renderJobs() {
  const tbody = $('#jobs-table tbody');
  tbody.replaceChildren();
  for (const j of state.jobs) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, String(j.id)),
      el('td', {}, j.action),
      el('td', {}, `${j.target_type}:${j.application_id ?? j.group_id ?? j.server_id ?? '-'}`),
      el('td', {}, [badge(j.status, j.status)]),
      el('td', {}, `${j.attempts}/${j.max_attempts}`),
      el('td', {}, j.enqueued_at ?? ''),
      el('td', {}, j.finished_at ?? '-'),
      el('td', {}, j.error_message ?? ''),
    ]));
  }
}

function renderAudit() {
  const tbody = $('#audit-table tbody');
  tbody.replaceChildren();
  for (const a of state.audit) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, a.occurred_at ?? ''),
      el('td', {}, a.actor),
      el('td', {}, a.action),
      el('td', {}, `${a.target_type}:${a.target_id ?? ''}`),
      el('td', {}, [badge(a.result, a.result)]),
      el('td', {}, (a.message ?? '').slice(0, 160)),
    ]));
  }
}

function renderGroupsTab() {
  const tbody = $('#groups-table tbody');
  tbody.replaceChildren();
  for (const g of state.groups) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, g.name),
      el('td', {}, g.description ?? ''),
      el('td', {}, [
        el('button', { onclick: () => openGroupForm({ initial: g, onSaved: refresh }) }, 'Edit'),
        el('button', { class: 'danger', onclick: async () => {
          if (await confirmDeleteGroup(g)) {
            try { await apiClient.deleteGroup(g.id); await refresh(); }
            catch (err) { alert(`Delete failed: ${err.message}`); }
          }
        }}, 'Delete'),
      ]),
    ]));
  }
}

function renderServersTab() {
  const tbody = $('#servers-table tbody');
  tbody.replaceChildren();
  for (const s of state.servers) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, s.name),
      el('td', {}, s.hostname),
      el('td', {}, [badge(s.status ?? 'unknown', s.status ?? 'unknown')]),
      el('td', {}, s.artifact_transfer),
      el('td', {}, s.last_seen_at ?? '-'),
      el('td', {}, [
        el('button', { onclick: () => openServerForm({ initial: s, onSaved: refresh }) }, 'Edit'),
        el('button', { onclick: () => rotateServerToken(s, refresh) }, 'Rotate'),
        el('button', { class: 'danger', onclick: async () => {
          if (await confirmDeleteServer(s)) {
            try { await apiClient.deleteServer(s.id); await refresh(); }
            catch (err) { alert(`Delete failed: ${err.message}`); }
          }
        }}, 'Delete'),
      ]),
    ]));
  }
}

// ─── live WS ────────────────────────────────────────────────────────────
let ws = null;
function connectWs() {
  ws = new WebSocket(wsUrl);
  ws.addEventListener('open',  () => $('#conn').classList.add('ok'));
  ws.addEventListener('close', () => {
    $('#conn').classList.remove('ok');
    setTimeout(connectWs, 2_000);
  });
  ws.addEventListener('message', (ev) => {
    let frame; try { frame = JSON.parse(ev.data); } catch { return; }
    onFrame(frame);
  });
}

function onFrame(frame) {
  if (frame.op === 'state') {
    for (const a of frame.apps ?? []) {
      const existing = state.apps.find((x) => x.id === a.id);
      if (existing) Object.assign(existing, {
        process_state: a.state, pid: a.pid, uptime_seconds: a.uptimeSeconds,
      });
    }
    renderApps();
  }
  if (frame.op === 'log:chunk') {
    const pre = $('#live-logs');
    try {
      const text = atob(frame.dataB64);
      pre.textContent += `[${frame.jobId.slice(-8)} ${frame.stream}] ${text}`;
      pre.scrollTop = pre.scrollHeight;
    } catch { /* noop */ }
  }
  if (frame.op === 'job:result' || frame.op === 'job:update') {
    refresh().catch(() => {});
  }
}

// ─── tabs + toolbar ─────────────────────────────────────────────────────
$$('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tabs button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $(`#tab-${btn.dataset.tab}`).classList.add('active');
}));

$('#groupFilter').addEventListener('change', (e) => {
  state.filterGroupId = e.target.value;
  renderApps();
});

$('#btn-refresh').addEventListener('click', () => refresh());
$('#btn-restart-group').addEventListener('click', () => {
  const g = state.groups.find((x) => String(x.id) === state.filterGroupId);
  if (!g) return alert('Select a group first');
  if (!confirm(`Restart all apps in group "${g.name}"?`)) return;
  enqueue('restart', { type: 'group', id: g.name });
});
$('#btn-build-group').addEventListener('click', () => {
  const g = state.groups.find((x) => String(x.id) === state.filterGroupId);
  if (!g) return alert('Select a group first');
  enqueue('build', { type: 'group', id: g.name });
});

$('#btn-new-app').addEventListener('click', () => openApplicationForm({
  servers: state.servers, groups: state.groups, onSaved: refresh,
}));
$('#btn-new-group').addEventListener('click',  () => openGroupForm({ onSaved: refresh }));
$('#btn-new-server').addEventListener('click', () => openServerForm({ onSaved: refresh }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ─── boot ───────────────────────────────────────────────────────────────
refresh().catch((err) => alert(`initial load failed: ${err.message}`));
connectWs();
setInterval(() => { refresh().catch(() => {}); }, 15_000);
