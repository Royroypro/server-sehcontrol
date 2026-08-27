// Caracterizacion del ciclo de vida de las sesiones de previsualizacion.
// Describe el comportamiento actual, incluida la ventana inicial de 120s.
const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();

const { projectRequire, seedActiveDevice, forceSessionColumns, getSessionRow } = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');
const { makeMediaApiMock } = require('./helpers/mediaApiMock');

const preview = projectRequire('src/screenCamPreview.js');
const wsMock = installWsMock();
const mediaApi = makeMediaApiMock();
const expirationCleanup = {
  kickSrtPublishersForPath: mediaApi.kickSrtPublishersForPath,
  pushToUser: () => 0,
  logger: () => {},
};

test.after(async () => {
  await preview.waitForExpirationCleanup();
  wsMock.restore();
  env.cleanup();
});

test('la sesion se crea en waiting_client', () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_1' });
  const s = preview.startPreview('DEV_SES_1', 1);
  assert.strictEqual(s.status, 'waiting_client');
  assert.match(s.session_id, /^pv_[0-9a-f]{10}$/);
  assert.strictEqual(s.device_id, 'DEV_SES_1');
  assert.strictEqual(s.playback_url, null, 'todavia no hay URL: el cliente no publico');
});

test('el TTL total es de 300 segundos', () => {
  assert.strictEqual(preview.SESSION_TTL_SECONDS, 300);
  seedActiveDevice({ rustdeskId: 'DEV_SES_2' });
  const s = preview.startPreview('DEV_SES_2', 1);
  // expires_in se calcula redondeando, asi que se admite 1s de margen.
  assert.ok(s.expires_in >= 299 && s.expires_in <= 300, `expires_in fue ${s.expires_in}`);
});

test('ALREADY_ACTIVE cuando ya hay una sesion viva para ese dispositivo', () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_3' });
  preview.startPreview('DEV_SES_3', 1);
  assert.throws(
    () => preview.startPreview('DEV_SES_3', 1),
    (err) => err.code === 'ALREADY_ACTIVE',
  );
});

test('MEDIA_NOT_CONFIGURED cuando falta MEDIA_PUBLISH_URL', () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_4' });
  const original = process.env.MEDIA_PUBLISH_URL;
  delete process.env.MEDIA_PUBLISH_URL;
  try {
    assert.throws(
      () => preview.startPreview('DEV_SES_4', 1),
      (err) => err.code === 'MEDIA_NOT_CONFIGURED',
    );
  } finally {
    process.env.MEDIA_PUBLISH_URL = original;
  }
});

test('con MEDIA_PLAYBACK_BASE definido, publishing pasa a ready con playback_url', () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_SES_5' });
  const s = preview.startPreview('DEV_SES_5', 1);
  const updated = preview.updateFromClientForUser(
    userId, s.session_id, 'DEV_SES_5', { status: 'publishing' },
  );
  assert.strictEqual(updated.status, 'ready');
  assert.ok(updated.playback_url.includes(s.session_id));
  assert.ok(updated.playback_url.includes('/whep?token='), 'la URL lleva el token de lectura');
});

test('sin MEDIA_PLAYBACK_BASE, publishing se queda en publishing y sin URL', () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_SES_6' });
  const s = preview.startPreview('DEV_SES_6', 1);
  const original = process.env.MEDIA_PLAYBACK_BASE;
  delete process.env.MEDIA_PLAYBACK_BASE;
  try {
    const updated = preview.updateFromClientForUser(
      userId, s.session_id, 'DEV_SES_6', { status: 'publishing' },
    );
    assert.strictEqual(updated.status, 'publishing');
    assert.strictEqual(updated.playback_url, null);
  } finally {
    process.env.MEDIA_PLAYBACK_BASE = original;
  }
});

test('transicion a failed guarda el error', () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_SES_7' });
  const s = preview.startPreview('DEV_SES_7', 1);
  const updated = preview.updateFromClientForUser(
    userId,
    s.session_id,
    'DEV_SES_7',
    { status: 'failed', error: 'media_server_unreachable' },
  );
  assert.strictEqual(updated, null, 'los estados terminales no generan ACK');
  assert.strictEqual(getSessionRow(s.session_id).status, 'failed');
  assert.strictEqual(getSessionRow(s.session_id).error, 'media_server_unreachable');
});

test('transicion a stopped por evento del cliente', () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_SES_8' });
  const s = preview.startPreview('DEV_SES_8', 1);
  const updated = preview.updateFromClientForUser(
    userId, s.session_id, 'DEV_SES_8', { status: 'stopped' },
  );
  assert.strictEqual(updated, null, 'los estados terminales no generan ACK');
  assert.strictEqual(getSessionRow(s.session_id).status, 'stopped');
});

test('stopPreview cierra la sesion y limpia playback_url', async () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_SES_9' });
  const s = preview.startPreview('DEV_SES_9', 1);
  preview.updateFromClientForUser(
    userId, s.session_id, 'DEV_SES_9', { status: 'publishing' },
  );
  const stopped = await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_SES_9', mediaApi,
  });
  assert.strictEqual(stopped.status, 'stopped');
  assert.strictEqual(stopped.playback_url, null);
  assert.ok(getSessionRow(s.session_id).ended_at, 'queda registrado cuando termino');
});

test('stopPreview sobre una sesion inexistente lanza NOT_FOUND', async () => {
  await assert.rejects(
    () => preview.stopPreview('pv_no_existe', 1, {
      expectedRustdeskId: 'DEV_NO_EXISTE', mediaApi,
    }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('expireStaleSessions marca expired lo que paso su expires_at', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_10' });
  const s = preview.startPreview('DEV_SES_10', 1);
  forceSessionColumns(s.session_id, { expires_at: '2000-01-01 00:00:00' });
  preview.expireStaleSessions(expirationCleanup);
  await preview.waitForExpirationCleanup();
  assert.strictEqual(getSessionRow(s.session_id).status, 'expired');
});

test('expireStaleSessions cierra una sesion que nunca publico tras la ventana de espera de 120s', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_11' });
  const s = preview.startPreview('DEV_SES_11', 1);
  // Sigue dentro del TTL de 300s, pero lleva mas de 120s en waiting_client.
  forceSessionColumns(s.session_id, { created_at: '2000-01-01 00:00:00' });
  preview.expireStaleSessions(expirationCleanup);
  await preview.waitForExpirationCleanup();
  assert.strictEqual(getSessionRow(s.session_id).status, 'expired');
});

test('expireStaleSessions NO toca una sesion viva', () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_12' });
  const s = preview.startPreview('DEV_SES_12', 1);
  preview.expireStaleSessions(expirationCleanup);
  assert.strictEqual(getSessionRow(s.session_id).status, 'waiting_client');
});

test('tras expirar, el dispositivo admite una sesion nueva', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_SES_13' });
  const first = preview.startPreview('DEV_SES_13', 1);
  forceSessionColumns(first.session_id, { expires_at: '2000-01-01 00:00:00' });
  const second = preview.startPreview('DEV_SES_13', 1, { expirationCleanup });
  await preview.waitForExpirationCleanup();
  assert.notStrictEqual(second.session_id, first.session_id);
  assert.strictEqual(second.status, 'waiting_client');
});

test('startPreview exige que ScreenCam este activo en el equipo', () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_SES_14' });
  const policy = projectRequire('src/screenCamPolicy.js');
  policy.deactivateDevice(userId, 'DEV_SES_14');
  assert.throws(
    () => preview.startPreview('DEV_SES_14', 1),
    (err) => err.code === 'NOT_ACTIVE',
  );
});

test('startPreview sobre un equipo inexistente lanza NOT_FOUND', () => {
  assert.throws(
    () => preview.startPreview('DEV_QUE_NO_EXISTE', 1),
    (err) => err.code === 'NOT_FOUND',
  );
});
