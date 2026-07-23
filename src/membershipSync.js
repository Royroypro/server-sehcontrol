// Aplica el estado de membresia (cuenta suspendida o plan vencido) sobre
// peer.status en la base de datos de hbbs, para que el servidor de senializacion
// parcheado rechace conexiones hacia los equipos de cuentas no activas.
const db = require('./db/adminDb');
const hbbsDb = require('./db/hbbsDb');
const ws = require('./ws');

function isUserBlocked(user) {
  if (!user) return true;
  if (user.status !== 'active') return true;
  if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) return true;
  return false;
}

// Payload liviano para el push por websocket. Si el cliente quiere el detalle
// completo (plan, dias restantes, limite de equipos) puede pedirlo con
// GET /api/membership/status apenas reciba este evento.
function statusPushPayload(user, blocked) {
  let reason = null;
  if (user.status !== 'active') reason = 'suspended';
  else if (blocked) reason = 'expired';
  return {
    type: 'membership_status',
    data: {
      blocked,
      reason,
      message: reason === 'suspended'
        ? 'Tu cuenta esta suspendida. Contacta al administrador.'
        : reason === 'expired'
          ? 'Tu plan ha vencido. Contacta al administrador.'
          : 'Cuenta activa',
    },
  };
}

function syncUserDevices(userId) {
  if (!hbbsDb.isAvailable()) return;
  const user = db.prepare('select * from users where id = ?').get(userId);
  if (!user) return;
  const blocked = isUserBlocked(user);
  const devices = db.prepare('select rustdesk_id from devices where owner_user_id = ?').all(userId);
  for (const d of devices) {
    hbbsDb.setPeerDisabled(d.rustdesk_id, blocked);
  }
  ws.pushToUser(userId, statusPushPayload(user, blocked));
}

function syncDevice(rustdeskId, userId) {
  if (!hbbsDb.isAvailable()) return;
  const user = db.prepare('select * from users where id = ?').get(userId);
  const blocked = isUserBlocked(user);
  hbbsDb.setPeerDisabled(rustdeskId, blocked);
  ws.pushToUser(userId, statusPushPayload(user, blocked));
}

// Recalcula todo: cubre expiraciones por fecha que ocurren sin que nadie
// toque el panel (nadie hizo click, simplemente paso el tiempo). Solo empuja
// el push a los usuarios cuyo estado realmente cambio (setPeerDisabled
// devuelve true cuando hubo una diferencia real).
function syncAll() {
  if (!hbbsDb.isAvailable()) return;
  const rows = db.prepare(`
    select d.rustdesk_id, u.id as user_id, u.status, u.plan_expires_at
    from devices d join users u on u.id = d.owner_user_id
  `).all();
  let changed = 0;
  const changedUsers = new Set();
  for (const r of rows) {
    const blocked = isUserBlocked(r);
    if (hbbsDb.setPeerDisabled(r.rustdesk_id, blocked)) {
      changed++;
      changedUsers.add(r.user_id);
    }
  }
  for (const userId of changedUsers) {
    const user = db.prepare('select * from users where id = ?').get(userId);
    if (user) ws.pushToUser(userId, statusPushPayload(user, isUserBlocked(user)));
  }
  return { checked: rows.length, changed };
}

function startPeriodicSync(intervalMs = 5 * 60 * 1000) {
  syncAll();
  setInterval(syncAll, intervalMs);
}

module.exports = { isUserBlocked, syncUserDevices, syncDevice, syncAll, startPeriodicSync };
