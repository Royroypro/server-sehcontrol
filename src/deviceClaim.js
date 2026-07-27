// Logica de reclamar/liberar un equipo, compartida entre el panel web
// (reclamo manual del cliente/admin) y el login nativo del cliente RustDesk
// (auto-asociacion al iniciar sesion, ver routes/hbbsHttp.js).
const db = require('./db/adminDb');
const hbbsDb = require('./db/hbbsDb');
const notifications = require('./notifications');

function getDeviceOwner(rustdeskId) {
  return db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
}

function countDevices(userId) {
  return db.prepare('select count(*) c from devices where owner_user_id = ?').get(userId).c;
}

function planLimitFor(userId) {
  const row = db.prepare(`
    select p.max_devices from users u left join plans p on p.id = u.plan_id where u.id = ?
  `).get(userId);
  return row?.max_devices ?? 0;
}

// Busca si esta cuenta ya tiene un equipo reclamado con el mismo machine_id
// (misma maquina fisica) bajo un rustdesk_id distinto -- caso tipico:
// reinstalacion de RustDesk, que genera un id nuevo para el mismo hardware.
function findDeviceByMachineId(userId, machineId) {
  if (!machineId) return null;
  return db.prepare(
    'select rustdesk_id from devices where owner_user_id = ? and machine_id = ?'
  ).get(userId, machineId);
}

// Reasigna un equipo ya reclamado (alias, tags, historial) al nuevo
// rustdesk_id que genero la reinstalacion, en vez de crear un registro
// nuevo y dejar el anterior como obsoleto. No consume cupo del plan porque
// no es un equipo nuevo, es el mismo hardware con un id distinto.
function migrateDeviceId(oldRustdeskId, newRustdeskId, userId) {
  const tx = db.transaction(() => {
    db.prepare('delete from device_sysinfo where rustdesk_id = ?').run(newRustdeskId);
    db.prepare('delete from device_screen_cam_settings where rustdesk_id = ?').run(newRustdeskId);
    db.prepare(
      'update devices set rustdesk_id = ? where rustdesk_id = ? and owner_user_id = ?'
    ).run(newRustdeskId, oldRustdeskId, userId);
    db.prepare(
      'update device_sysinfo set rustdesk_id = ? where rustdesk_id = ?'
    ).run(newRustdeskId, oldRustdeskId);
    db.prepare(
      'update device_screen_cam_settings set rustdesk_id = ? where rustdesk_id = ?'
    ).run(newRustdeskId, oldRustdeskId);
  });
  tx();
  hbbsDb.setPeerDisabled(newRustdeskId, false);
  notifications.logActivity(
    userId,
    'device_id_migrated',
    'device',
    newRustdeskId,
    JSON.stringify({ old_rustdesk_id: oldRustdeskId, reason: 'machine_id_match' }),
  );
}

function claimDevice(userId, rustdeskId, alias = null, context = {}) {
  const info = db.prepare(
    'insert into devices (rustdesk_id, alias, owner_user_id, claimed_by_user_id, claim_source) values (?, ?, ?, ?, ?)'
  ).run(rustdeskId, alias, userId, context.actorUserId ?? userId, context.source || 'unknown');
  hbbsDb.setPeerDisabled(rustdeskId, false);
  notifications.logActivity(
    context.actorUserId ?? userId,
    'device_claimed',
    'device',
    rustdeskId,
    JSON.stringify({ owner_user_id: userId, source: context.source || 'unknown' }),
  );
  return info;
}

// Solo libera si el equipo realmente pertenece a ese usuario (evita que un
// logout con un id ajeno o manipulado borre el equipo de otra cuenta).
function releaseDevice(userId, rustdeskId) {
  const device = db.prepare('select * from devices where rustdesk_id = ? and owner_user_id = ?').get(rustdeskId, userId);
  if (!device) return false;
  db.prepare('delete from devices where id = ?').run(device.id);
  hbbsDb.setPeerDisabled(rustdeskId, false);
  return true;
}

module.exports = {
  getDeviceOwner,
  countDevices,
  planLimitFor,
  claimDevice,
  releaseDevice,
  findDeviceByMachineId,
  migrateDeviceId,
};
