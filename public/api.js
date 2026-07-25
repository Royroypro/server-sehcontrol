async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de solicitud');
  return data;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString();
}

function planBadge(expiresAt) {
  if (!expiresAt) return '';
  const days = (new Date(expiresAt) - new Date()) / 86400000;
  if (days < 0) return '<span class="badge suspended">Expirado</span>';
  if (days < 7) return '<span class="badge warn">Vence pronto</span>';
  return '';
}

function toDateInputValue(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

function deviceStatusBadge(live) {
  if (!live) return '<span class="badge suspended">No visto</span>';
  if (live.online) return '<span class="badge active">En linea</span>';
  if (live.last_heartbeat_at || live.registered_at) {
    return '<span class="badge">Offline</span>';
  }
  return '<span class="badge suspended">No visto</span>';
}
