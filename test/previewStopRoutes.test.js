// Integracion HTTP aislada de DELETE/beacon-stop con el router administrativo.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire, seedActiveDevice, getSessionRow } = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');

const db = projectRequire('src/db/adminDb.js');
const preview = projectRequire('src/screenCamPreview.js');
const mediaApi = projectRequire('src/mediaMtxApi.js');
const adminRouter = projectRequire('src/routes/admin.js');
const wsMock = installWsMock();

const adminId = db.prepare(`
  insert into users (email, password_hash, role, status)
  values ('preview-stop-admin@test.local', 'test-hash', 'admin', 'active')
`).run().lastInsertRowid;
const adminToken = jwt.sign(
  { sub: adminId, email: 'preview-stop-admin@test.local', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);
const client = seedActiveDevice({ rustdeskId: 'DEV_HTTP_AUTH_CLIENT' });
const clientToken = jwt.sign(
  { sub: client.userId, email: 'client@test.local', role: 'client' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);

const mediaCalls = [];
const originalKick = mediaApi.kickSrtPublishersForPath;
mediaApi.kickSrtPublishersForPath = async (path) => {
  mediaCalls.push(path);
  return { status: 'kicked', matched: 1, kicked: 1 };
};

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
  preview.stopPreview = originalStopPreview;
  mediaApi.kickSrtPublishersForPath = originalKick;
  wsMock.restore();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  env.cleanup();
});

async function request(method, pathname, token = adminToken) {
  const response = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method,
    headers: token ? { Cookie: `token=${token}` } : {},
  });
  const text = await response.text();
  let body = null;
  if (text) body = JSON.parse(text);
  return { status: response.status, text, body };
}

function createSession(rustdeskId) {
  const owner = seedActiveDevice({ rustdeskId });
  return {
    ...owner,
    session: preview.startPreview(rustdeskId, adminId),
  };
}

function stoppedActivityCount(rustdeskId) {
  return db.prepare(`
    select count(*) as count from activity_log
    where action = 'screen_cam_preview_stopped' and target_id = ?
  `).get(rustdeskId).count;
}

const originalStopPreview = preview.stopPreview;

test('DELETE correcto cierra, hace kick, emite Stop y devuelve estado publico', async () => {
  const ctx = createSession('DEV_HTTP_DELETE_OK');
  mediaCalls.length = 0;
  wsMock.clear();
  const activityBefore = stoppedActivityCount(ctx.rustdeskId);

  const response = await request(
    'DELETE',
    `/devices/${ctx.rustdeskId}/screen-cam/preview/${ctx.session.session_id}`,
  );

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, 'stopped');
  assert.strictEqual(response.body.device_id, ctx.rustdeskId);
  assert.deepStrictEqual(mediaCalls, [ctx.session.session_id]);
  assert.strictEqual(wsMock.sent.length, 1);
  assert.strictEqual(stoppedActivityCount(ctx.rustdeskId), activityBefore + 1);
});

test('DELETE inexistente y mismatch devuelven 404 identico sin efectos', async () => {
  const a = createSession('DEV_HTTP_DELETE_A');
  const b = createSession('DEV_HTTP_DELETE_B');
  const beforeA = getSessionRow(a.session.session_id);
  const beforeB = getSessionRow(b.session.session_id);
  const activityBefore = stoppedActivityCount(b.rustdeskId);
  mediaCalls.length = 0;
  wsMock.clear();

  const missing = await request(
    'DELETE',
    `/devices/${a.rustdeskId}/screen-cam/preview/pv_http_missing`,
  );
  const mismatch = await request(
    'DELETE',
    `/devices/${a.rustdeskId}/screen-cam/preview/${b.session.session_id}`,
  );

  assert.strictEqual(missing.status, 404);
  assert.strictEqual(mismatch.status, 404);
  assert.deepStrictEqual(mismatch.body, missing.body);
  assert.deepStrictEqual(mismatch.body, { error: 'Sesion no encontrada' });
  assert.deepStrictEqual(getSessionRow(a.session.session_id), beforeA);
  assert.deepStrictEqual(getSessionRow(b.session.session_id), beforeB);
  assert.deepStrictEqual(mediaCalls, []);
  assert.deepStrictEqual(wsMock.sent, []);
  assert.strictEqual(stoppedActivityCount(b.rustdeskId), activityBefore);
  assert.ok(!JSON.stringify(mismatch.body).includes(b.rustdeskId));
});

test('DELETE convierte una excepcion inesperada en 500 sanitario', async () => {
  const ctx = createSession('DEV_HTTP_DELETE_ERROR');
  preview.stopPreview = async () => {
    const error = new Error('SQL secreto token=abc https://internal.invalid');
    error.code = 'SQLITE_PRIVATE_DETAIL';
    throw error;
  };
  try {
    const response = await request(
      'DELETE',
      `/devices/${ctx.rustdeskId}/screen-cam/preview/${ctx.session.session_id}`,
    );
    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(response.body, { error: 'Error interno del servidor' });
    assert.ok(!response.text.includes('SQL'));
    assert.ok(!response.text.includes('token'));
    assert.ok(!response.text.includes('stack'));
    assert.ok(!response.text.includes('internal.invalid'));
  } finally {
    preview.stopPreview = originalStopPreview;
  }
});

test('beacon correcto espera el cierre, responde 204 sin cuerpo y cierra', async () => {
  const ctx = createSession('DEV_HTTP_BEACON_OK');
  mediaCalls.length = 0;
  wsMock.clear();
  const response = await request(
    'POST',
    `/devices/${ctx.rustdeskId}/screen-cam/preview/${ctx.session.session_id}/beacon-stop`,
  );
  assert.strictEqual(response.status, 204);
  assert.strictEqual(response.text, '');
  assert.strictEqual(getSessionRow(ctx.session.session_id).status, 'stopped');
  assert.deepStrictEqual(mediaCalls, [ctx.session.session_id]);
  assert.strictEqual(wsMock.sent.length, 1);
});

test('beacon inexistente y mismatch responden 204 sin efectos ni cuerpo', async () => {
  const a = createSession('DEV_HTTP_BEACON_A');
  const b = createSession('DEV_HTTP_BEACON_B');
  const beforeA = getSessionRow(a.session.session_id);
  const beforeB = getSessionRow(b.session.session_id);
  const activityBefore = stoppedActivityCount(b.rustdeskId);
  mediaCalls.length = 0;
  wsMock.clear();

  const missing = await request(
    'POST',
    `/devices/${a.rustdeskId}/screen-cam/preview/pv_beacon_missing/beacon-stop`,
  );
  const mismatch = await request(
    'POST',
    `/devices/${a.rustdeskId}/screen-cam/preview/${b.session.session_id}/beacon-stop`,
  );

  assert.strictEqual(missing.status, 204);
  assert.strictEqual(mismatch.status, 204);
  assert.strictEqual(missing.text, '');
  assert.strictEqual(mismatch.text, '');
  assert.deepStrictEqual(getSessionRow(a.session.session_id), beforeA);
  assert.deepStrictEqual(getSessionRow(b.session.session_id), beforeB);
  assert.deepStrictEqual(mediaCalls, []);
  assert.deepStrictEqual(wsMock.sent, []);
  assert.strictEqual(stoppedActivityCount(b.rustdeskId), activityBefore);
});

test('beacon sobre una sesion ya cerrada conserva 204 sin cuerpo', async () => {
  const ctx = createSession('DEV_HTTP_BEACON_CLOSED');
  await preview.stopPreview(ctx.session.session_id, adminId, {
    expectedRustdeskId: ctx.rustdeskId,
    mediaApi,
  });
  const response = await request(
    'POST',
    `/devices/${ctx.rustdeskId}/screen-cam/preview/${ctx.session.session_id}/beacon-stop`,
  );
  assert.strictEqual(response.status, 204);
  assert.strictEqual(response.text, '');
  assert.strictEqual(getSessionRow(ctx.session.session_id).status, 'stopped');
});

test('beacon espera la promesa de stopPreview cuando la peticion llega', async () => {
  let resolved = false;
  preview.stopPreview = () => new Promise((resolve) => {
    setTimeout(() => {
      resolved = true;
      resolve(null);
    }, 20);
  });
  try {
    const response = await request(
      'POST',
      '/devices/DEV_HTTP_WAIT/screen-cam/preview/pv_http_wait/beacon-stop',
    );
    assert.strictEqual(response.status, 204);
    assert.strictEqual(resolved, true);
  } finally {
    preview.stopPreview = originalStopPreview;
  }
});

test('beacon maneja rechazo inesperado, devuelve 204 y solo loguea datos sanitarios', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  preview.stopPreview = async () => {
    const error = new Error('SQL token=secret https://private.invalid full stack');
    error.code = 'SQLITE_PRIVATE';
    throw error;
  };
  try {
    const response = await request(
      'POST',
      '/devices/DEV_HTTP_LOG/screen-cam/preview/pv_secret_session_full/beacon-stop',
    );
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.text, '');
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(
      warnings[0],
      '[screencam] operation=beacon-stop session=pv_secre code=SQLITE_PRIVATE',
    );
    assert.ok(!warnings[0].includes('token='));
    assert.ok(!warnings[0].includes('private.invalid'));
    assert.ok(!warnings[0].includes('full stack'));
    assert.ok(!warnings[0].includes('pv_secret_session_full'));
  } finally {
    preview.stopPreview = originalStopPreview;
    console.warn = originalWarn;
  }
});

test('DELETE y beacon permanecen detras de requireAuth y requireAdmin', async () => {
  const paths = [
    {
      method: 'DELETE',
      path: '/devices/DEV_HTTP_AUTH/screen-cam/preview/pv_http_auth',
    },
    {
      method: 'POST',
      path: '/devices/DEV_HTTP_AUTH/screen-cam/preview/pv_http_auth/beacon-stop',
    },
  ];
  for (const route of paths) {
    assert.strictEqual((await request(route.method, route.path, null)).status, 401);
    assert.strictEqual((await request(route.method, route.path, clientToken)).status, 403);
  }
});
