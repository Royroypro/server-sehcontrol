// Logica de reclamar/liberar un equipo, compartida entre el panel web
// (reclamo manual del cliente/admin) y el login nativo del cliente RustDesk
// (auto-asociacion al iniciar sesion, ver routes/hbbsHttp.js).
const db = require('./db/adminDb');
const hbbsDb = require('./db/hbbsDb');

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

function claimDevice(userId, rustdeskId, alias = null) {
  const info = db.prepare(
    'insert into devices (rustdesk_id, alias, owner_user_id) values (?, ?, ?)'
  ).run(rustdeskId, alias, userId);
  hbbsDb.setPeerDisabled(rustdeskId, false);
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

module.exports = { getDeviceOwner, countDevices, planLimitFor, claimDevice, releaseDevice };
