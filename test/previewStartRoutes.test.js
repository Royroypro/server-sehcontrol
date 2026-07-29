const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire, seedActiveDevice } = require('./helpers/fixtures');

const db = projectRequire('src/db/adminDb.js');
const adminRouter = projectRequire('src/routes/admin.js');
const { createScreenCamPreviewStartHandler } = adminRouter;

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const knownErrors = [
  ['NOT_FOUND', 404, 'Equipo no encontrado'],
  ['FORBIDDEN', 403, 'No tienes permiso para abrir una previsualizacion'],
  ['NOT_ACTIVE', 409, 'ScreenCam no esta activo en este equipo'],
  ['ALREADY_ACTIVE', 409, 'Ya hay una previsualizacion abierta para este equipo'],
  [
    'MEDIA_NOT_CONFIGURED',
    503,
    'El gateway multimedia no esta configurado en este servidor',
  ],
];

for (const [code, status, message] of knownErrors) {
  test(`preview start traduce ${code} con contrato publico fijo`, () => {
    const logs = [];
    const response = responseRecorder();
    const handler = createScreenCamPreviewStartHandler({
      assertPermission() {},
      startPreview() {
        throw Object.assign(
          new Error('token=PRIVATE_TOKEN /home/private stack internal.invalid'),
          { code },
        );
      },
      logger: (...args) => logs.push(args),
    });

    handler(
      {
        user: { role: 'admin', sub: 7 },
        params: { rustdeskId: 'PRIVATE_DEVICE_ID' },
      },
      response,
    );

    assert.strictEqual(response.statusCode, status);
    assert.deepStrictEqual(response.body, { error: message });
    assert.deepStrictEqual(logs, []);
    const serialized = JSON.stringify(response.body);
    for (const secret of ['PRIVATE_TOKEN', '/home/private', 'stack', 'internal.invalid']) {
      assert.ok(!serialized.includes(secret));
    }
  });
}

test('preview start convierte una excepcion inesperada en 500 sanitario', () => {
  const calls = [];
  const response = responseRecorder();
  const handler = createScreenCamPreviewStartHandler({
    assertPermission() {},
    startPreview() {
      throw Object.assign(
        new Error('token=PRIVATE_TOKEN /home/private stack internal.invalid'),
        { code: 'SQLITE_PRIVATE_FAILURE' },
      );
    },
    logger: (...args) => calls.push(args),
  });

  handler(
    {
      user: { role: 'admin', sub: 8 },
      params: { rustdeskId: 'PRIVATE_DEVICE_ID' },
    },
    response,
  );

  assert.strictEqual(response.statusCode, 500);
  assert.deepStrictEqual(response.body, { error: 'Error interno del servidor' });
  assert.deepStrictEqual(calls, [[
    '[screencam] operation=screen-cam-preview-start code=internal_error',
  ]]);
  const serialized = JSON.stringify({ calls, body: response.body });
  for (const secret of [
    'PRIVATE_TOKEN',
    'PRIVATE_DEVICE_ID',
    'SQLITE_PRIVATE_FAILURE',
    '/home/private',
    'internal.invalid',
    'stack',
  ]) {
    assert.ok(!serialized.includes(secret));
  }
});

test('un objeto con message pero sin codigo conocido sigue siendo 500', () => {
  const calls = [];
  const response = responseRecorder();
  const handler = createScreenCamPreviewStartHandler({
    assertPermission() {},
    startPreview() {
      throw {
        message: 'Bad request secret-access-token secret-read-token',
        stack: 'Error: SELECT token at /home/private',
      };
    },
    logger: (...args) => calls.push(args),
  });

  handler(
    {
      user: { role: 'admin', sub: 8 },
      params: { rustdeskId: 'PRIVATE_DEVICE_ID' },
    },
    response,
  );

  assert.strictEqual(response.statusCode, 500);
  assert.deepStrictEqual(response.body, { error: 'Error interno del servidor' });
  assert.deepStrictEqual(calls, [[
    '[screencam] operation=screen-cam-preview-start code=internal_error',
  ]]);
  const serialized = JSON.stringify({ calls, body: response.body });
  for (const secret of [
    'Bad request',
    'secret-access-token',
    'secret-read-token',
    'SELECT',
    'Error:',
    'at /home/',
  ]) {
    assert.ok(!serialized.includes(secret));
  }
});

test('preview start conserva el contrato de exito del servicio', () => {
  const expected = {
    session_id: 'pv_public_session',
    rustdesk_id: 'DEV_PUBLIC',
    status: 'pending',
    playback_url: 'https://public.invalid/media/path',
  };
  const response = responseRecorder();
  const handler = createScreenCamPreviewStartHandler({
    assertPermission(permission, context) {
      assert.strictEqual(permission, 'screen_cam.open_preview');
      assert.deepStrictEqual(context, {
        role: 'admin',
        userId: 9,
        rustdeskId: 'DEV_PUBLIC',
      });
    },
    startPreview(rustdeskId, userId) {
      assert.strictEqual(rustdeskId, 'DEV_PUBLIC');
      assert.strictEqual(userId, 9);
      return expected;
    },
    logger: () => assert.fail('el exito no debe registrar errores'),
  });

  handler(
    { user: { role: 'admin', sub: 9 }, params: { rustdeskId: 'DEV_PUBLIC' } },
    response,
  );

  assert.strictEqual(response.statusCode, 201);
  assert.deepStrictEqual(response.body, expected);
});

const adminId = db.prepare(`
  insert into users (email, password_hash, role, status)
  values ('preview-start-admin@test.local', 'test-hash', 'admin', 'active')
`).run().lastInsertRowid;
const adminToken = jwt.sign(
  { sub: adminId, email: 'preview-start-admin@test.local', role: 'admin' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' },
);
const client = seedActiveDevice({ rustdeskId: 'DEV_START_HTTP_CLIENT' });
const clientToken = jwt.sign(
  { sub: client.userId, email: 'preview-start-client@test.local', role: 'client' },
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
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  env.cleanup();
});

async function request(pathname, token) {
  const response = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method: 'POST',
    headers: token ? { Cookie: `token=${token}` } : {},
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

test('la ruta real conserva autenticacion administrativa y exito 201', async () => {
  const pathname = '/devices/DEV_START_HTTP_CLIENT/screen-cam/preview';
  assert.strictEqual((await request(pathname, null)).status, 401);
  assert.strictEqual((await request(pathname, clientToken)).status, 403);

  const response = await request(pathname, adminToken);
  assert.strictEqual(response.status, 201);
  assert.strictEqual(response.body.device_id, 'DEV_START_HTTP_CLIENT');
  assert.strictEqual(response.body.status, 'waiting_client');
  assert.ok(response.body.session_id);
  assert.strictEqual(response.body.playback_url, null);
  assert.ok(!Object.hasOwn(response.body, 'publish_token'));
  assert.ok(!Object.hasOwn(response.body, 'read_token'));
});
