// Caracterizacion de authorizeMedia(): fija el comportamiento ACTUAL de la
// autorizacion que consulta el gateway multimedia. Todas estas pruebas
// deben pasar con el codigo tal como esta hoy.
const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();

const { projectRequire, seedActiveDevice, forceSessionColumns, getSessionRow } = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');
const { makeMediaApiMock } = require('./helpers/mediaApiMock');

const preview = projectRequire('src/screenCamPreview.js');
const wsMock = installWsMock();
// Ninguna prueba debe tocar la red: se inyecta un cliente falso de MediaMTX.
const mediaApi = makeMediaApiMock({ status: 'not_found', matched: 0, kicked: 0 });

test.after(async () => {
  await preview.waitForExpirationCleanup();
  wsMock.restore();
  env.cleanup();
});

// Crea una sesion viva y devuelve sus dos tokens reales desde la base.
function freshSession(rustdeskId) {
  const { userId } = seedActiveDevice({ rustdeskId });
  const session = preview.startPreview(rustdeskId, 1);
  const row = getSessionRow(session.session_id);
  return {
    id: session.session_id,
    userId,
    rustdeskId,
    publishToken: row.publish_token,
    readToken: row.read_token,
  };
}

test('token de publicacion correcto autoriza publish', () => {
  const s = freshSession('DEV_AUTH_1');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: s.publishToken }), true);
});

test('token de lectura correcto autoriza read', () => {
  const s = freshSession('DEV_AUTH_2');
  assert.strictEqual(preview.authorizeMedia({ action: 'read', path: s.id, token: s.readToken }), true);
});

test('token de publicacion NO autoriza read', () => {
  const s = freshSession('DEV_AUTH_3');
  assert.strictEqual(preview.authorizeMedia({ action: 'read', path: s.id, token: s.publishToken }), false);
});

test('token de lectura NO autoriza publish', () => {
  const s = freshSession('DEV_AUTH_4');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: s.readToken }), false);
});

test('token incorrecto rechaza', () => {
  const s = freshSession('DEV_AUTH_5');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: 'token-invalido' }), false);
});

test('path inexistente rechaza', () => {
  const s = freshSession('DEV_AUTH_6');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: 'pv_no_existe', token: s.publishToken }), false);
});

test('token ausente rechaza', () => {
  const s = freshSession('DEV_AUTH_7');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: null }), false);
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: '' }), false);
});

test('sesion stopped rechaza', async () => {
  const s = freshSession('DEV_AUTH_8');
  await preview.stopPreview(s.id, 1, {
    expectedRustdeskId: s.rustdeskId, mediaApi,
  });
  assert.strictEqual(getSessionRow(s.id).status, 'stopped');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: s.publishToken }), false);
});

test('sesion failed rechaza', () => {
  const s = freshSession('DEV_AUTH_9');
  preview.updateFromClientForUser(
    s.userId,
    s.id,
    s.rustdeskId,
    { status: 'failed', error: 'media_server_unreachable' },
  );
  assert.strictEqual(getSessionRow(s.id).status, 'failed');
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: s.publishToken }), false);
});

test('sesion expired rechaza', async () => {
  const s = freshSession('DEV_AUTH_10');
  // Se fuerza el vencimiento en la base en vez de esperar 300s reales.
  forceSessionColumns(s.id, { expires_at: '2000-01-01 00:00:00' });
  assert.strictEqual(preview.authorizeMedia({
    action: 'publish',
    path: s.id,
    token: s.publishToken,
    expirationCleanup: {
      kickSrtPublishersForPath: mediaApi.kickSrtPublishersForPath,
      pushToUser: () => 0,
      logger: () => {},
    },
  }), false);
  await preview.waitForExpirationCleanup();
});

test('sesion viva permite reutilizar el mismo token en mas de un handshake', () => {
  const s = freshSession('DEV_AUTH_11');
  // SRT puede reintentar el handshake: el token se reutiliza dentro de su
  // unica sesion viva.
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: s.publishToken }), true);
  assert.strictEqual(preview.authorizeMedia({ action: 'publish', path: s.id, token: s.publishToken }), true);
  assert.strictEqual(preview.authorizeMedia({ action: 'read', path: s.id, token: s.readToken }), true);
});
