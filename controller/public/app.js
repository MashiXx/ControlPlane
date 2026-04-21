// Web dashboard SPA. Minimal, no frameworks.

import { apiClient } from './api.js';
import { openGroupForm, confirmDeleteGroup } from './forms/group.js';
import { openServerForm, confirmDeleteServer } from './forms/server.js';
import { openApplicationForm, confirmDeleteApp } from './forms/application.js';
import { openReplicasDialog } from './forms/replica.js';
import {
  openServerGroupForm, confirmDeleteServerGroup,
} from './forms/serverGroup.js';

const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ui`;

// ─── state ──────────────────────────────────────────────────────────────
const state = {
  apps: [],
  groups: [],
  servers: [],
  serverGroups: [],
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
    const [apps, groups, servers, serverGroups, jobs, audit] = await Promise.all([
      apiClient.listApps(),
      apiClient.listGroups(),
      apiClient.listServers(),
      apiClient.listServerGroups(),
      apiClient.listJobs(),
      apiClient.listAudit(),
    ]);
    state.apps = apps; state.groups = groups; state.servers = servers;
    state.serverGroups = serverGroups; state.jobs = jobs; state.audit = audit;
    renderGroupsFilter();
    renderApps(); renderJobs(); renderAudit();
    renderGroupsTab(); renderServersTab(); renderServerGroupsTab();
  } catch (err) {
    if (err.message !== 'unauthenticated') console.warn('refresh failed:', err);
  }
}

async function enqueue(action, target, options) {
  try {
    await apiClient.enqueue(action, target, options);
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
    const placement = a.server_name
      ? `server: ${a.server_name}`
      : a.server_group_name
        ? `group: ${a.server_group_name}`
        : '(unplaced)';

    const row = el('tr', {}, [
      el('td', {}, a.name),
      el('td', {}, groupName),
      el('td', {}, placement),
      el('td', {}, a.runtime),
      el('td', {}, `${a.replica_running ?? 0}/${a.replica_total ?? 0} running`),
      el('td', {}, [
        el('button', { onclick: async () => {
          try { await openReplicasDialog(a, state.servers); }
          catch (err) { alert(`Failed to load replicas: ${err.message}`); }
        }}, 'Replicas'),
        el('button', { onclick: () => openApplicationForm({
          initial: a, servers: state.servers, serverGroups: state.serverGroups,
          groups: state.groups, onSaved: refresh,
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

function renderServerGroupsTab() {
  const tbody = $('#server-groups-table tbody');
  tbody.replaceChildren();
  for (const g of state.serverGroups) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, g.name),
      el('td', {}, g.description ?? ''),
      el('td', {}, String(g.member_count ?? 0)),
      el('td', {}, [
        el('button', { onclick: () => openServerGroupForm({
          initial: g, servers: state.servers, onSaved: refresh,
        })}, 'Edit'),
        el('button', { class: 'danger', onclick: async () => {
          if (await confirmDeleteServerGroup(g)) {
            try { await apiClient.deleteServerGroup(g.id); await refresh(); }
            catch (err) { alert(`Delete failed: ${err.message}`); }
          }
        }}, 'Delete'),
      ]),
    ]));
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
      el('td', {}, s.last_seen_at ?? '-'),
      el('td', {}, [
        el('button', { onclick: () => openServerForm({ initial: s, onSaved: refresh }) }, 'Edit'),
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
    // Per-replica state — re-fetch the full app list so the replica-count
    // aggregate (inside the Replicas dialog) is fresh.
    refresh().catch(() => {});
    return;
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
  if (frame.op === 'alert') {
    showAlertBanner(frame);
    refresh().catch(() => {});
  }
}

// Push an alert frame onto the top-of-page banner stack. The banner lives
// outside the <main> tabs so it's visible no matter which view is active.
// Each banner self-dismisses after 30s; the user can also close manually.
function showAlertBanner(frame) {
  const root = $('#alerts-banner');
  if (!root) return;
  root.hidden = false;
  const item = el('div', { class: 'alert-item' }, [
    el('span', { class: 'alert-dot' }, '●'),
    el('span', { class: 'alert-text' },
      `${frame.message ?? `${frame.appName} ${frame.state}`} · ${frame.at ?? ''}`),
    el('button', {
      class: 'alert-dismiss',
      onclick: () => { item.remove(); if (!root.children.length) root.hidden = true; },
    }, '×'),
  ]);
  root.appendChild(item);
  setTimeout(() => {
    item.remove();
    if (!root.children.length) root.hidden = true;
  }, 30_000);
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

$('#btn-new-app').addEventListener('click', () => openApplicationForm({
  servers: state.servers, serverGroups: state.serverGroups,
  groups: state.groups, onSaved: refresh,
}));
$('#btn-new-group').addEventListener('click',  () => openGroupForm({ onSaved: refresh }));
$('#btn-new-server').addEventListener('click', () => openServerForm({ onSaved: refresh }));
$('#btn-new-server-group').addEventListener('click', () => openServerGroupForm({
  servers: state.servers, onSaved: refresh,
}));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ─── boot ───────────────────────────────────────────────────────────────
refresh().catch((err) => alert(`initial load failed: ${err.message}`));
connectWs();
setInterval(() => { refresh().catch(() => {}); }, 15_000);
