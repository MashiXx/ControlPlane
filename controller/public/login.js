const form = document.getElementById('login-form');
const errEl = document.getElementById('err');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errEl.textContent = '';
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) { location.href = '/'; return; }
    const body = await res.json().catch(() => ({}));
    errEl.textContent = body?.error?.message ?? `error ${res.status}`;
  } catch (err) {
    errEl.textContent = err.message;
  }
});
