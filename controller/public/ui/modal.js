// Generic modal. Returns a handle with .close(). Esc or backdrop click closes.

export function openModal({ title, body, actions = [] }) {
  const root = document.getElementById('modal-root');
  if (!root) throw new Error('modal-root not in DOM');

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = document.createElement('header');
  header.className = 'modal-header';
  header.textContent = title;
  dialog.appendChild(header);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  if (typeof body === 'string') bodyEl.textContent = body;
  else bodyEl.appendChild(body);
  dialog.appendChild(bodyEl);

  const footer = document.createElement('footer');
  footer.className = 'modal-footer';
  const actionButtons = [];
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    if (a.danger) btn.className = 'danger';
    if (a.primary) btn.classList.add('primary');
    btn.addEventListener('click', () => a.onClick?.(handle));
    actionButtons.push(btn);
    footer.appendChild(btn);
  }
  dialog.appendChild(footer);

  backdrop.appendChild(dialog);
  root.appendChild(backdrop);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  const handle = { close, dialog, body: bodyEl, footer, actionButtons };
  return handle;
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: message,
      actions: [
        { label: 'Cancel', onClick: (h) => { h.close(); resolve(false); } },
        { label: confirmLabel, danger, primary: !danger, onClick: (h) => { h.close(); resolve(true); } },
      ],
    });
    setTimeout(() => modal.actionButtons.at(-1)?.focus(), 0);
  });
}
