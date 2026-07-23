// Junta lo que sabe hbbs (IP, fecha de registro) con lo que el cliente
// RustDesk ya manda solo a /api/sysinfo y /api/heartbeat (hostname, os,
// usuario, "ultima vez visto"). Ver src/routes/hbbsHttp.js para el receptor.
const db = require('./db/adminDb');
const hbbsDb = require('./db/hbbsDb');

// El cliente manda heartbeat cada ~15s mientras esta abierto; con margen
// para jitter/red, 40s sin heartbeat = se considera offline.
const ONLINE_THRESHOLD_MS = 40 * 1000;

function toUtcDate(sqliteDatetime) {
  if (!sqliteDatetime) return null;
  // sqlite datetime('now') devuelve "YYYY-MM-DD HH:MM:SS" en UTC sin sufijo;
  // sin el 'Z' explicito, Date() lo interpretaria como hora local.
  return new Date(sqliteDatetime.replace(' ', 'T') + 'Z');
}

function enrichDevice(rustdeskId) {
  const live = hbbsDb.getPeerByRustdeskId(rustdeskId);
  const sysinfo = db.prepare('select * from device_sysinfo where rustdesk_id = ?').get(rustdeskId);
  const lastHeartbeat = toUtcDate(sysinfo?.last_heartbeat_at);
  const online = !!lastHeartbeat && (Date.now() - lastHeartbeat.getTime()) < ONLINE_THRESHOLD_MS;
  return {
    rustdesk_id: rustdeskId,
    registered_at: live?.registered_at || null,
    last_known_ip: live?.last_known_ip || null,
    hostname: sysinfo?.hostname || null,
    os: sysinfo?.os || null,
    cpu: sysinfo?.cpu || null,
    memory: sysinfo?.memory || null,
    username: sysinfo?.username || null,
    last_heartbeat_at: sysinfo?.last_heartbeat_at || null,
    online,
  };
}

module.exports = { enrichDevice };
