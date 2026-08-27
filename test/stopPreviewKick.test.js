// Integracion entre stopPreview() y la expulsion del publisher SRT.
//
// El cliente de MediaMTX se inyecta (options.mediaApi), asi que estas
// pruebas no tocan la red ni dependen de que MediaMTX exista.
const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();

const { projectRequire, seedActiveDevice, getSessionRow } = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');
const { makeMediaApiMock } = require('./helpers/mediaApiMock');

const preview = projectRequire('src/screenCamPreview.js');
const db = projectRequire('src/db/adminDb.js');
const wsMock = installWsMock();

test.after(() => {
  wsMock.restore();
  env.cleanup();
});

test('13) el estado pasa a stopped ANTES de consultar MediaMTX', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_1' });
  const s = preview.startPreview('DEV_KICK_1', 1);

  let statusDuranteElKick = null;
  const mediaApi = {
    async kickSrtPublishersForPath() {
      // Se observa el estado en el momento exacto del kick.
      statusDuranteElKick = getSessionRow(s.session_id).status;
      return { status: 'kicked', matched: 1, kicked: 1 };
    },
  };

  await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_1', mediaApi,
  });
  assert.strictEqual(
    statusDuranteElKick, 'stopped',
    'la sesion debe estar cerrada antes de hablar con MediaMTX',
  );
});

test('13b) durante el kick, un handshake nuevo ya es rechazado', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_1B' });
  const s = preview.startPreview('DEV_KICK_1B', 1);
  const row = getSessionRow(s.session_id);

  let autorizadoDuranteElKick = null;
  const mediaApi = {
    async kickSrtPublishersForPath() {
      autorizadoDuranteElKick = preview.authorizeMedia({
        action: 'publish', path: s.session_id, token: row.publish_token,
      });
      return { status: 'kicked', matched: 1, kicked: 1 };
    },
  };

  await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_1B', mediaApi,
  });
  assert.strictEqual(autorizadoDuranteElKick, false, 'el token ya no debe autorizar');
});

test('14) se llama al cliente de MediaMTX con el session_id como path', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_2' });
  const s = preview.startPreview('DEV_KICK_2', 1);
  const mediaApi = makeMediaApiMock();

  await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_2', mediaApi,
  });
  assert.strictEqual(mediaApi.calls.length, 1, 'debe llamarse exactamente una vez');
  assert.strictEqual(mediaApi.lastPath(), s.session_id, 'el path debe ser el session_id');
});

test('15) MediaMTX caido no revierte el estado ni rompe el cierre logico', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_3' });
  const s = preview.startPreview('DEV_KICK_3', 1);
  const mediaApi = makeMediaApiMock({ status: 'failed', matched: 0, kicked: 0, error: 'timeout' });

  const out = await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_3', mediaApi,
  });
  assert.strictEqual(out.status, 'stopped', 'la respuesta publica sigue siendo stopped');
  assert.strictEqual(getSessionRow(s.session_id).status, 'stopped', 'el estado en base no se revierte');
  assert.strictEqual(out.playback_url, null);
});

test('15b) si el cliente de MediaMTX lanza, tampoco rompe el cierre', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_3B' });
  const s = preview.startPreview('DEV_KICK_3B', 1);
  const mediaApi = makeMediaApiMock();
  mediaApi.setThrows(new Error('conexion rechazada'));

  const out = await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_3B', mediaApi,
  });
  assert.strictEqual(out.status, 'stopped');
  assert.strictEqual(getSessionRow(s.session_id).status, 'stopped');
});

test('16) el evento WebSocket stop se emite aunque el kick falle', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_4' });
  const s = preview.startPreview('DEV_KICK_4', 1);
  const mediaApi = makeMediaApiMock({ status: 'failed', matched: 0, kicked: 0, error: 'list_failed' });

  wsMock.clear();
  await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_4', mediaApi,
  });

  assert.strictEqual(wsMock.sent.length, 1, 'debe emitirse el evento igual');
  const payload = wsMock.sent[0].payload;
  assert.strictEqual(payload.type, 'screen_cam.preview.stop');
  assert.deepStrictEqual(Object.keys(payload).sort(), ['data', 'type']);
  assert.strictEqual(payload.data.session_id, s.session_id);
});

test('17) dos Stop consecutivos son seguros (idempotencia)', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_5' });
  const s = preview.startPreview('DEV_KICK_5', 1);

  const mediaApi = makeMediaApiMock({ status: 'kicked', matched: 1, kicked: 1 });
  const first = await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_5', mediaApi,
  });
  assert.strictEqual(first.status, 'stopped');

  // La segunda vez ya no hay publisher que cerrar.
  mediaApi.setResult({ status: 'not_found', matched: 0, kicked: 0 });
  const second = await preview.stopPreview(s.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_5', mediaApi,
  });
  assert.strictEqual(second.status, 'stopped', 'no debe fallar ni cambiar el estado');
  assert.strictEqual(mediaApi.calls.length, 2);
});

test('18) un Stop no expulsa el path de otra sesion', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_6' });
  seedActiveDevice({ rustdeskId: 'DEV_KICK_7' });
  const a = preview.startPreview('DEV_KICK_6', 1);
  const b = preview.startPreview('DEV_KICK_7', 1);

  const mediaApi = makeMediaApiMock();
  await preview.stopPreview(a.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_6', mediaApi,
  });

  assert.strictEqual(mediaApi.lastPath(), a.session_id);
  assert.notStrictEqual(mediaApi.lastPath(), b.session_id, 'no debe tocarse la otra sesion');
  // Y la sesion B sigue viva.
  assert.strictEqual(getSessionRow(b.session_id).status, 'waiting_client');
});

test('18b) un Stop de una sesion antigua no afecta a la nueva del mismo equipo', async () => {
  seedActiveDevice({ rustdeskId: 'DEV_KICK_8' });
  const vieja = preview.startPreview('DEV_KICK_8', 1);
  const mediaApi = makeMediaApiMock();
  await preview.stopPreview(vieja.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_8', mediaApi,
  });

  // Cerrada la anterior, el equipo admite una sesion nueva.
  const nueva = preview.startPreview('DEV_KICK_8', 1);
  assert.notStrictEqual(nueva.session_id, vieja.session_id);

  // Un stop rezagado de la vieja no debe cerrar la nueva.
  mediaApi.reset();
  await preview.stopPreview(vieja.session_id, 1, {
    expectedRustdeskId: 'DEV_KICK_8', mediaApi,
  });
  assert.strictEqual(mediaApi.lastPath(), vieja.session_id, 'solo se expulsa el path viejo');
  assert.strictEqual(
    getSessionRow(nueva.session_id).status, 'waiting_client',
    'la sesion nueva debe seguir viva',
  );
});

test('19) expectedRustdeskId incorrecto equivale a sesion inexistente y no tiene efectos', async () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_STOP_TARGET_B' });
  seedActiveDevice({ rustdeskId: 'DEV_STOP_URL_A' });
  const target = preview.startPreview('DEV_STOP_TARGET_B', userId);
  preview.updateFromClientForUser(
    userId, target.session_id, 'DEV_STOP_TARGET_B', { status: 'publishing' },
  );
  const before = getSessionRow(target.session_id);
  const mediaApi = makeMediaApiMock();
  wsMock.clear();
  const activityBefore = db.prepare(`
    select count(*) as count from activity_log
    where action = 'screen_cam_preview_stopped' and target_id = ?
  `).get('DEV_STOP_TARGET_B').count;

  let mismatchError;
  let missingError;
  try {
    await preview.stopPreview(target.session_id, userId, {
      expectedRustdeskId: 'DEV_STOP_URL_A', mediaApi,
    });
  } catch (error) {
    mismatchError = error;
  }
  try {
    await preview.stopPreview('pv_missing_stop', userId, {
      expectedRustdeskId: 'DEV_STOP_URL_A', mediaApi,
    });
  } catch (error) {
    missingError = error;
  }

  assert.ok(mismatchError);
  assert.ok(missingError);
  assert.strictEqual(mismatchError.code, 'NOT_FOUND');
  assert.strictEqual(missingError.code, mismatchError.code);
  assert.strictEqual(missingError.message, mismatchError.message);
  assert.strictEqual(mediaApi.calls.length, 0);
  assert.deepStrictEqual(wsMock.sent, []);
  assert.deepStrictEqual(getSessionRow(target.session_id), before);
  assert.strictEqual(db.prepare(`
    select count(*) as count from activity_log
    where action = 'screen_cam_preview_stopped' and target_id = ?
  `).get('DEV_STOP_TARGET_B').count, activityBefore);
});

test('20) expectedRustdeskId es obligatorio y no puede estar vacio', async () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_STOP_REQUIRED' });
  const session = preview.startPreview('DEV_STOP_REQUIRED', userId);
  const mediaApi = makeMediaApiMock();
  const before = getSessionRow(session.session_id);

  for (const options of [
    { mediaApi },
    { expectedRustdeskId: '', mediaApi },
    { expectedRustdeskId: '   ', mediaApi },
  ]) {
    await assert.rejects(
      () => preview.stopPreview(session.session_id, userId, options),
      (error) => error.code === 'NOT_FOUND' && error.message === 'Sesion no encontrada',
    );
  }
  assert.deepStrictEqual(getSessionRow(session.session_id), before);
  assert.strictEqual(mediaApi.calls.length, 0);
});

test('21) intento cruzado no afecta la sesion nueva del dispositivo de la URL', async () => {
  const a = seedActiveDevice({ rustdeskId: 'DEV_STOP_CROSS_A' });
  const b = seedActiveDevice({ rustdeskId: 'DEV_STOP_CROSS_B' });
  const sessionA = preview.startPreview(a.rustdeskId, a.userId);
  const sessionB = preview.startPreview(b.rustdeskId, b.userId);
  const beforeA = getSessionRow(sessionA.session_id);
  const beforeB = getSessionRow(sessionB.session_id);
  const mediaApi = makeMediaApiMock();

  await assert.rejects(
    () => preview.stopPreview(sessionB.session_id, a.userId, {
      expectedRustdeskId: a.rustdeskId, mediaApi,
    }),
    (error) => error.code === 'NOT_FOUND',
  );
  assert.deepStrictEqual(getSessionRow(sessionA.session_id), beforeA);
  assert.deepStrictEqual(getSessionRow(sessionB.session_id), beforeB);
  assert.strictEqual(mediaApi.calls.length, 0);
});
