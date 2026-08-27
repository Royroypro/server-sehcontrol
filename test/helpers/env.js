// Aislamiento de entorno para las pruebas.
//
// Varios modulos del servidor tienen efectos secundarios al importarse:
//   - src/db/adminDb.js abre (y crea) una SQLite en cuanto se carga;
//   - src/auth.js lanza una excepcion si JWT_SECRET mide menos de 16 chars;
//   - src/ws.js lee JWT_SECRET en el momento de la carga.
// Por eso las variables tienen que quedar puestas ANTES del primer require,
// y cada archivo de prueba necesita su propia base temporal.
//
// node --test corre cada archivo en un proceso hijo aparte, asi que llamar
// a setupTestEnv() una vez al principio de cada archivo alcanza para
// aislarlos entre si.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SENSITIVE_DEFAULTS = {
  // Valores ficticios: nada de esto toca produccion ni el dominio publico.
  JWT_SECRET: 'test-secret-no-usar-en-produccion-0123456789',
  MEDIA_PUBLISH_URL: 'srt://127.0.0.1:18890',
  MEDIA_PLAYBACK_BASE: 'http://127.0.0.1:18889/media',
  FORCE_LOGIN: 'false',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
};

// Crea un directorio temporal propio, apunta ADMIN_DB_PATH a una SQLite
// dentro de el, y devuelve un cleanup que restaura process.env y borra todo.
function setupTestEnv(overrides = {}) {
  const originalEnv = { ...process.env };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sehcontrol-test-'));
  const dbPath = path.join(tmpDir, 'admin.sqlite3');

  Object.assign(process.env, SENSITIVE_DEFAULTS, { ADMIN_DB_PATH: dbPath }, overrides);

  return {
    tmpDir,
    dbPath,
    cleanup() {
      // Restaurar process.env exactamente como estaba (incluye borrar las
      // claves que agregamos, no solo revertir las que ya existian).
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// Descarga del require.cache todos los modulos del proyecto, para que una
// prueba pueda recargarlos con variables de entorno distintas. No toca
// node_modules: recargar better-sqlite3 (nativo) rompe el proceso.
function clearProjectRequireCache() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(projectRoot, 'src'))) delete require.cache[key];
  }
}

module.exports = { setupTestEnv, clearProjectRequireCache, SENSITIVE_DEFAULTS };
