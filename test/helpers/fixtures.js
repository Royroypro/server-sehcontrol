// Datos minimos para poder ejercitar ScreenCam: un plan con el modulo
// habilitado, un usuario cliente activo, y un equipo suyo con ScreenCam
// encendido (que es lo que startPreview exige).
const path = require('path');

function projectRequire(relative) {
  return require(path.resolve(__dirname, '..', '..', relative));
}

// Inserta plan + usuario + dispositivo y deja el dispositivo con ScreenCam
// activo. Devuelve los ids para usarlos en las aserciones.
function seedActiveDevice({ rustdeskId = 'DEV_TEST_1', maxStreams = 2 } = {}) {
  const db = projectRequire('src/db/adminDb.js');
  const policy = projectRequire('src/screenCamPolicy.js');
  const { hashPassword } = projectRequire('src/auth.js');

  const planId = db.prepare(
    "insert into plans (name, max_devices) values (?, 5)"
  ).run(`PlanTest_${rustdeskId}`).lastInsertRowid;

  const userId = db.prepare(
    "insert into users (email, password_hash, plan_id, status, role) values (?, ?, ?, 'active', 'client')"
  ).run(`${rustdeskId}@test.local`, hashPassword('x'), planId).lastInsertRowid;

  db.prepare(
    "insert into devices (rustdesk_id, owner_user_id, claim_source) values (?, ?, 'test')"
  ).run(rustdeskId, userId);

  policy.setPlanModule(planId, { enabled: true, mode: 'managed', maxStreams }, userId);
  policy.activateDevice(userId, rustdeskId);

  return { planId, userId, rustdeskId };
}

// Manipula directamente la fila de la sesion. Necesario para caracterizar
// estados a los que no se llega por la API publica (expired, o una sesion
// cuya ventana de espera ya vencio) sin tener que esperar en tiempo real.
function forceSessionColumns(sessionId, columns) {
  const db = projectRequire('src/db/adminDb.js');
  const keys = Object.keys(columns);
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`update screen_cam_preview_sessions set ${setSql} where id = ?`)
    .run(...keys.map((k) => columns[k]), sessionId);
}

function getSessionRow(sessionId) {
  const db = projectRequire('src/db/adminDb.js');
  return db.prepare('select * from screen_cam_preview_sessions where id = ?').get(sessionId);
}

module.exports = { projectRequire, seedActiveDevice, forceSessionColumns, getSessionRow };
