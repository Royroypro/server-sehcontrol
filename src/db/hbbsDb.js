const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const hbbsPath = path.resolve(__dirname, '../..', process.env.HBBS_DB_PATH || '../rustdesk-server/db_v2.sqlite3');

let db = null;
let writeDb = null;
if (fs.existsSync(hbbsPath)) {
  db = new Database(hbbsPath, { readonly: true, fileMustExist: true });
  // Conexion aparte, de escritura, usada solo para marcar peer.status (0 = bloqueado).
  // hbbs corre en su propio proceso con la misma base en modo WAL, por eso es seguro
  // escribir desde aqui de forma concurrente; busy_timeout evita errores SQLITE_BUSY.
  writeDb = new Database(hbbsPath, { fileMustExist: true });
  writeDb.pragma('busy_timeout = 5000');
} else {
  console.warn(`[hbbsDb] No se encontro la base de datos de hbbs en ${hbbsPath}. Los datos en vivo de equipos no estaran disponibles hasta que exista el archivo.`);
}

// hbbs solo persiste { ip } en la columna "info"; no guarda estado online/offline
// ni hostname/usuario en la version open source (eso es una funcion de RustDesk Pro).
function getPeerByRustdeskId(rustdeskId) {
  if (!db) return null;
  const row = db.prepare('select id, created_at, info from peer where id = ?').get(rustdeskId);
  if (!row) return null;
  let info = {};
  try { info = JSON.parse(row.info || '{}'); } catch (_) { /* ignore malformed info */ }
  return {
    rustdesk_id: row.id,
    registered_at: row.created_at,
    last_known_ip: info.ip || null,
  };
}

function peerExists(rustdeskId) {
  if (!db) return false;
  const row = db.prepare('select 1 from peer where id = ?').get(rustdeskId);
  return !!row;
}

// Todos los IDs que alguna vez se registraron en hbbs (no implica que esten
// online ahora mismo, ver nota en getPeerByRustdeskId). Se usa para el picker
// de "equipos registrados sin asignar" del panel admin.
function listAllPeers() {
  if (!db) return [];
  const rows = db.prepare('select id, created_at, info from peer order by created_at desc').all();
  return rows.map((row) => {
    let info = {};
    try { info = JSON.parse(row.info || '{}'); } catch (_) { /* ignore malformed info */ }
    return { rustdesk_id: row.id, registered_at: row.created_at, last_known_ip: info.ip || null };
  });
}

// Marca (o levanta) el bloqueo de un ID a nivel hbbs. hbbs (parcheado) rechaza
// cualquier intento de conexion hacia un ID con status = 0, sin importar el
// estado en memoria del proceso. Si el ID aun no se registro nunca en hbbs
// (no tiene fila en "peer"), no hay nada que marcar todavia: se reintentara
// en la siguiente pasada del sync periodico una vez que el dispositivo se conecte.
function setPeerDisabled(rustdeskId, disabled) {
  if (!writeDb) return false;
  const info = writeDb
    .prepare('update peer set status = ? where id = ?')
    .run(disabled ? 0 : null, rustdeskId);
  return info.changes > 0;
}

module.exports = { getPeerByRustdeskId, peerExists, listAllPeers, setPeerDisabled, isAvailable: () => !!db };
