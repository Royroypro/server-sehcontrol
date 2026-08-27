// Integracion HTTP aislada del GET administrativo de preview.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const {
  projectRequire,
  seedActiveDevice,
  forceSessionColumns,
  getSessionRow,
} = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');

const db = projectRequire('src/db/adminDb.js');
const preview = projectRequire('src/screenCamPreview.js');
const mediaApi = projectRequire('src/mediaMtxApi.js');
const adminRouter = projectRequire('src/routes/admin.js');
const wsMock = installWsMock();

const adminId = db.prepare(`
  insert into users (email, password_hash, role, status)
  values ('preview-get-admin@test.local', 'test-hash', 'admin', 'active')
`).run().lastInsertRowid;
const adminToken = jwt.sign(
  { sub: adminId, email: 'preview-get-admin@test.local', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);
const client = seedActiveDevice({ rustdeskId: 'DEV_GET_HTTP_CLIENT' });
const clientToken = jwt.sign(
  { sub: client.userId, email: 'preview-get-client@test.local', role: 'client' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);

const mediaCalls = [];
const originalKick = mediaApi.kickSrtPublishersForPath;
mediaApi.kickSrtPublishersForPath = async (...args) => {
  mediaCalls.push(args);
  return { status: 'kicked', matched: 1, kicked: 1 };
};
const originalGetPreviewForDevice = preview.getPreviewForDevice;

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
  preview.getPreviewForDevice = originalGetPreviewForDevice;
  mediaApi.kickSrtPublishersForPath = originalKick;
  wsMock.restore();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  env.cleanup();
});

async function request(pathname, token = adminToken) {
  const response = await fetch(`${baseUrl}/api/admin${pathname}`, {
    headers: token ? { Cookie: `token=${token}` } : {},
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : null,
  };
}

function createSession(rustdeskId) {
  const owner = seedActiveDevice({ rustdeskId });
  return {
    ...owner,
    session: preview.startPreview(rustdeskId, adminId),
  };
}

function activityCount() {
  return db.prepare('select count(*) as count from activity_log').get().count;
}

test('admin + combinacion correcta devuelve 200 con el contrato publico vigente', async () => {
  const ctx = createSession('DEV_GET_HTTP_OK');
  const expected = preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'publishing' },
  );

  const response = await request(
    `/devices/${ctx.rustdeskId}/screen-cam/preview/${ctx.session.session_id}`,
  );

  assert.strictEqual(response.status, 200);
  // playback_ready es un enriquecimiento del handler HTTP (Tarea 2): no
  // esta en lo que devuelve updateFromClientForUser directamente. En este
  // entorno de pruebas no hay MediaMTX real escuchando en 9997, asi que la
  // consulta de disponibilidad falla y se resuelve "desconocido" -> true
  // (fail-open: nunca debe bloquear la reproduccion).
  assert.deepStrictEqual(response.body, { ...expected, playback_ready: true });
  assert.ok(response.body.playback_url);
  assert.ok(!Object.hasOwn(response.body, 'publish_token'));
  assert.ok(!Object.hasOwn(response.body, 'read_token'));
});

test('inexistente, mismatch y entrada invalida devuelven el mismo 404', async () => {
  const a = createSession('DEV_GET_HTTP_404_A');
  const b = createSession('DEV_GET_HTTP_404_B');
  const missing = await request(
    `/devices/${a.rustdeskId}/screen-cam/preview/pv_get_http_missing`,
  );
  const mismatch = await request(
    `/devices/${a.rustdeskId}/screen-cam/preview/${b.session.session_id}`,
  );
  const invalid = await request(
    `/devices/%20/screen-cam/preview/${b.session.session_id}`,
  );

  assert.strictEqual(missing.status, 404);
  assert.strictEqual(mismatch.status, 404);
  assert.strictEqual(invalid.status, 404);
  assert.deepStrictEqual(missing.body, { error: 'Sesion no encontrada' });
  assert.deepStrictEqual(mismatch.body, missing.body);
  assert.deepStrictEqual(invalid.body, missing.body);
  assert.ok(!mismatch.text.includes(b.rustdeskId));
  assert.ok(!mismatch.text.includes('playback_url'));
  assert.ok(!mismatch.text.includes('read_token'));
});

test('escenario A/session B no filtra ni modifica B y la combinacion B/B funciona', async () => {
  const a = createSession('DEV_GET_HTTP_CROSS_A');
  const b = createSession('DEV_GET_HTTP_CROSS_B');
  const beforeA = getSessionRow(a.session.session_id);
  const beforeB = getSessionRow(b.session.session_id);
  const activityBefore = activityCount();
  wsMock.clear();
  mediaCalls.length = 0;

  const crossed = await request(
    `/devices/${a.rustdeskId}/screen-cam/preview/${b.session.session_id}`,
  );
  const correct = await request(
    `/devices/${b.rustdeskId}/screen-cam/preview/${b.session.session_id}`,
  );

  assert.strictEqual(crossed.status, 404);
  assert.deepStrictEqual(crossed.body, { error: 'Sesion no encontrada' });
  assert.strictEqual(correct.status, 200);
  // Sesion en 'waiting_client' (todavia sin playback_url): playback_ready
  // es false sin necesidad de consultar a MediaMTX.
  assert.deepStrictEqual(correct.body, { ...b.session, playback_ready: false });
  assert.deepStrictEqual(getSessionRow(a.session.session_id), beforeA);
  assert.deepStrictEqual(getSessionRow(b.session.session_id), beforeB);
  assert.strictEqual(activityCount(), activityBefore);
  assert.deepStrictEqual(wsMock.sent, []);
  assert.deepStrictEqual(mediaCalls, []);
});

test('una excepcion inesperada devuelve 500 sanitario', async () => {
  preview.getPreviewForDevice = () => {
    throw new Error('SQLITE token=secret /home/private stack https://internal.invalid');
  };
  try {
    const response = await request(
      '/devices/DEV_GET_HTTP_ERROR/screen-cam/preview/pv_get_http_error',
    );
    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(response.body, { error: 'Error interno del servidor' });
    for (const secret of ['SQLITE', 'token', '/home/', 'stack', 'internal.invalid']) {
      assert.ok(!response.text.includes(secret));
    }
  } finally {
    preview.getPreviewForDevice = originalGetPreviewForDevice;
  }
});

test('GET permanece detras de requireAuth y requireAdmin', async () => {
  const path = '/devices/DEV_GET_HTTP_AUTH/screen-cam/preview/pv_get_http_auth';
  assert.strictEqual((await request(path, null)).status, 401);
  assert.strictEqual((await request(path, clientToken)).status, 403);
});

test('una sesion cerrada correcta sigue siendo legible y la consulta no la altera', async () => {
  const ctx = createSession('DEV_GET_HTTP_CLOSED');
  forceSessionColumns(ctx.session.session_id, {
    status: 'stopped',
    ended_at: '2026-01-02 03:04:05',
    playback_url: null,
  });
  const before = getSessionRow(ctx.session.session_id);

  const response = await request(
    `/devices/${ctx.rustdeskId}/screen-cam/preview/${ctx.session.session_id}`,
  );

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, 'stopped');
  assert.deepStrictEqual(getSessionRow(ctx.session.session_id), before);
});
