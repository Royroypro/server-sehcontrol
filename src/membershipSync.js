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

// Umbral fijo (independiente de expiry_warning_days, que solo controla
// cuantos avisos automaticos genera el cron) para decidir cuando el
// cliente debe mostrar el banner "tu plan vence pronto" en vivo. El cliente
// ya documento este mismo numero (7) de su lado.
const EXPIRING_SOON_THRESHOLD_DAYS = 7;

function daysLeftFor(user) {
  if (!user?.plan_expires_at) return null;
  return Math.ceil((new Date(user.plan_expires_at) - new Date()) / 86400000);
}

// Estado de membresia compartido entre GET /api/membership/status (poll) y
// el push por WebSocket (tiempo real) -- una sola fuente de verdad para que
// nunca diverjan blocked/reason/message entre los dos canales.
function membershipStatus(user, blocked = isUserBlocked(user)) {
  const daysLeft = daysLeftFor(user);
  let reason = null;
  let message = 'Cuenta activa';
  if (user.status !== 'active') {
    reason = 'suspended';
    message = 'Tu cuenta esta suspendida. Contacta al administrador.';
  } else if (blocked) {
    reason = 'expired';
    message = 'Tu plan ha vencido. Contacta al administrador.';
  } else if (daysLeft != null && daysLeft <= EXPIRING_SOON_THRESHOLD_DAYS) {
    reason = 'expiring_soon';
    message = daysLeft <= 0
      ? 'Tu licencia vence hoy. Actualiza tu cuenta.'
      : `Falta${daysLeft === 1 ? '' : 'n'} ${daysLeft} dia${daysLeft === 1 ? '' : 's'} para el termino de tu licencia. Actualiza tu cuenta.`;
  }
  return { blocked, reason, message, daysLeft };
}

// Payload para el push por websocket. Incluye days_left/plan_expires_at (no
// solo blocked/reason/message) para que el cliente pueda actualizar el
// banner con el push solo, sin depender de un GET de seguimiento -- aunque
// GET /api/membership/status sigue disponible para el detalle completo
// (plan, limite de equipos, ultimo pago).
function statusPushPayload(user, blocked) {
  const status = membershipStatus(user, blocked);
  return {
    type: 'membership_status',
    data: {
      blocked: status.blocked,
      reason: status.reason,
      message: status.message,
      days_left: status.daysLeft,
      plan_expires_at: user.plan_expires_at || null,
    },
  };
}

// El bloqueo real (peer.status en hbbs) y el aviso al cliente (WS) son dos
// cosas independientes -- antes, si hbbsDb no estaba disponible (deployment
// sin esa base montada), el push tampoco se mandaba, dejando al cliente sin
// enterarse de renovaciones/cambios en tiempo real aunque no dependiera de
// hbbs para nada. Ahora el push siempre se manda; solo el paso de
// hbbs.setPeerDisabled se salta si esa base no esta disponible.
function syncUserDevices(userId) {
  const user = db.prepare('select * from users where id = ?').get(userId);
  if (!user) return;
  const blocked = isUserBlocked(user);
  if (hbbsDb.isAvailable()) {
    const devices = db.prepare('select rustdesk_id from devices where owner_user_id = ?').all(userId);
    for (const d of devices) {
      hbbsDb.setPeerDisabled(d.rustdesk_id, blocked);
    }
  }
  ws.pushToUser(userId, statusPushPayload(user, blocked));
}

function syncDevice(rustdeskId, userId) {
  const user = db.prepare('select * from users where id = ?').get(userId);
  if (!user) return;
  const blocked = isUserBlocked(user);
  if (hbbsDb.isAvailable()) {
    hbbsDb.setPeerDisabled(rustdeskId, blocked);
  }
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

module.exports = { isUserBlocked, membershipStatus, syncUserDevices, syncDevice, syncAll, startPeriodicSync };
