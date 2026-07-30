// Integracion HTTP: duracion configurable de la previsualizacion de
// ScreenCam (Tarea 5). Cubre lo que pide el checklist de pruebas de backend:
// admin puede leer/cambiar el valor, un no-admin recibe 403, los valores
// fuera de rango se rechazan, el valor persiste, una sesion nueva usa la
// duracion configurada y una ya creada no cambia retroactivamente.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire, seedActiveDevice } = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');

const db = projectRequire('src/db/adminDb.js');
const preview = projectRequire('src/screenCamPreview.js');
const adminRouter = projectRequire('src/routes/admin.js');
const wsMock = installWsMock();

const adminId = db.prepare(`
  insert into users (email, password_hash, role, status)
  values ('preview-duration-admin@test.local', 'test-hash', 'admin', 'active')
`).run().lastInsertRowid;
const adminToken = jwt.sign(
  { sub: adminId, email: 'preview-duration-admin@test.local', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);

const clientDevice = seedActiveDevice({ rustdeskId: 'DEV_DURATION_CLIENT' });
const clientToken = jwt.sign(
  { sub: clientDevice.userId, email: 'preview-duration-client@test.local', role: 'client' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/admin', adminRouter);
const server = http.createServer(app);
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  wsMock.restore();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  env.cleanup();
});

async function apiRequest(method, pathname, { token = adminToken, body } = {}) {
  const response = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method,
    headers: {
      ...(token ? { Cookie: `token=${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function getSettingsRow() {
  return db.prepare('select * from platform_settings where id = 1').get();
}

test('el default de fabrica es 300 segundos (5 minutos), igual que el limite historico', () => {
  assert.strictEqual(getSettingsRow().screen_cam_preview_duration_seconds, 300);
  assert.strictEqual(preview.DEFAULT_PREVIEW_DURATION_SECONDS, 300);
});

test('un admin puede leer el valor actual via GET /settings', async () => {
  const res = await apiRequest('GET', '/settings');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.screen_cam_preview_duration_seconds, 300);
});

test('un admin puede cambiar el valor y el cambio persiste en una lectura posterior', async () => {
  const put = await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: 600 } });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.screen_cam_preview_duration_seconds, 600);

  const get = await apiRequest('GET', '/settings');
  assert.strictEqual(get.body.screen_cam_preview_duration_seconds, 600);

  // Se registra la auditoria del cambio (recomendado: quien, de que a que).
  const entry = db.prepare(`
    select * from activity_log
    where action = 'screen_cam_preview_duration_updated'
    order by id desc limit 1
  `).get();
  assert.ok(entry);
  assert.strictEqual(entry.actor_user_id, adminId);
  assert.deepStrictEqual(JSON.parse(entry.detail), { from: 300, to: 600 });

  // Deja el valor en el default para no afectar el resto de las pruebas.
  await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: 300 } });
});

test('valores fuera de rango, no enteros o negativos son rechazados sin modificar nada', async () => {
  const before = getSettingsRow().screen_cam_preview_duration_seconds;
  const invalidValues = [10, 0, -60, 3600, 1.5, null, 'invalid', 300.5];
  for (const value of invalidValues) {
    const res = await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: value } });
    assert.strictEqual(res.status, 400, `valor ${JSON.stringify(value)} deberia rechazarse`);
    assert.ok(res.body.error);
  }
  assert.strictEqual(getSettingsRow().screen_cam_preview_duration_seconds, before);
});

test('los limites documentados (60 y 1800) se aceptan; 59 y 1801 no', async () => {
  for (const value of [60, 1800]) {
    const res = await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: value } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.screen_cam_preview_duration_seconds, value);
  }
  for (const value of [59, 1801]) {
    const res = await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: value } });
    assert.strictEqual(res.status, 400);
  }
  await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: 300 } });
});

test('un usuario no-admin recibe 403 al intentar modificar el limite (y al leerlo)', async () => {
  const putRes = await apiRequest('PUT', '/settings', {
    token: clientToken,
    body: { screen_cam_preview_duration_seconds: 900 },
  });
  assert.strictEqual(putRes.status, 403);
  assert.strictEqual(getSettingsRow().screen_cam_preview_duration_seconds, 300, 'el intento no debe haber cambiado nada');

  const getRes = await apiRequest('GET', '/settings', { token: clientToken });
  assert.strictEqual(getRes.status, 403);
});

test('sin autenticar devuelve 401, no 403 (no revela si el recurso existe)', async () => {
  const res = await apiRequest('GET', '/settings', { token: null });
  assert.strictEqual(res.status, 401);
});

test('una sesion nueva usa la duracion configurada; una ya creada no cambia retroactivamente', async () => {
  const before = seedActiveDevice({ rustdeskId: 'DEV_DURATION_BEFORE' });
  const sessionBefore = preview.startPreview(before.rustdeskId, adminId);
  assert.ok(sessionBefore.expires_in <= 300 && sessionBefore.expires_in > 295);

  const put = await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: 900 } });
  assert.strictEqual(put.status, 200);

  const after = seedActiveDevice({ rustdeskId: 'DEV_DURATION_AFTER' });
  const sessionAfter = preview.startPreview(after.rustdeskId, adminId);
  assert.ok(sessionAfter.expires_in <= 900 && sessionAfter.expires_in > 895);

  // expires_in/expires_at siguen siendo coherentes para la sesion nueva.
  const row = db.prepare('select expires_at from screen_cam_preview_sessions where id = ?').get(sessionAfter.session_id);
  const secondsLeft = Math.round((new Date(row.expires_at) - new Date()) / 1000);
  assert.ok(Math.abs(secondsLeft - 900) <= 2, `expires_at deberia reflejar ~900s, dio ${secondsLeft}`);

  // La sesion creada ANTES del cambio conserva su expires_at original: se
  // relee y sigue reportando ~300s, no 900s.
  const stillOld = preview.getPreviewForDevice(sessionBefore.session_id, before.rustdeskId);
  assert.ok(stillOld.expires_in <= 300 && stillOld.expires_in > 290);

  await apiRequest('PUT', '/settings', { body: { screen_cam_preview_duration_seconds: 300 } });
});

test('el valor sobrevive a una recarga del modulo (simula un reinicio del contenedor)', () => {
  db.prepare('update platform_settings set screen_cam_preview_duration_seconds = 900 where id = 1').run();
  const { clearProjectRequireCache } = require('./helpers/env');
  clearProjectRequireCache();
  const reloadedDb = projectRequire('src/db/adminDb.js');
  const row = reloadedDb.prepare('select screen_cam_preview_duration_seconds from platform_settings where id = 1').get();
  assert.strictEqual(row.screen_cam_preview_duration_seconds, 900);
  reloadedDb.prepare('update platform_settings set screen_cam_preview_duration_seconds = 300 where id = 1').run();
});
