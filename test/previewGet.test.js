// Consulta administrativa segura y de solo lectura de una preview.
const test = require('node:test');
const assert = require('node:assert');

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
const wsMock = installWsMock();
const mediaCalls = [];
const originalKick = mediaApi.kickSrtPublishersForPath;
mediaApi.kickSrtPublishersForPath = async (...args) => {
  mediaCalls.push(args);
  return { status: 'kicked', matched: 1, kicked: 1 };
};

test.after(() => {
  mediaApi.kickSrtPublishersForPath = originalKick;
  wsMock.restore();
  env.cleanup();
});

function createSession(rustdeskId) {
  const owner = seedActiveDevice({ rustdeskId });
  return {
    ...owner,
    session: preview.startPreview(rustdeskId, 1),
  };
}

function activityCount() {
  return db.prepare('select count(*) as count from activity_log').get().count;
}

test('combinacion exacta devuelve exclusivamente la representacion publica vigente', () => {
  const ctx = createSession('DEV_GET_PUBLIC');
  const publicState = preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'publishing' },
  );

  const result = preview.getPreviewForDevice(ctx.session.session_id, ctx.rustdeskId);

  assert.deepStrictEqual(result, publicState);
  assert.deepStrictEqual(Object.keys(result).sort(), [
    'device_id',
    'error',
    'expires_in',
    'playback_url',
    'session_id',
    'status',
  ]);
  assert.ok(result.playback_url);
  assert.ok(!Object.hasOwn(result, 'publish_token'));
  assert.ok(!Object.hasOwn(result, 'read_token'));
});

test('inexistente y dispositivo incorrecto producen el mismo null sin filtrar datos', () => {
  const a = createSession('DEV_GET_NULL_A');
  const b = createSession('DEV_GET_NULL_B');
  const missing = preview.getPreviewForDevice('pv_get_missing', a.rustdeskId);
  const mismatch = preview.getPreviewForDevice(b.session.session_id, a.rustdeskId);

  assert.strictEqual(missing, null);
  assert.strictEqual(mismatch, missing);
  assert.strictEqual(mismatch?.playback_url, undefined);
  assert.strictEqual(mismatch?.publish_token, undefined);
  assert.strictEqual(mismatch?.read_token, undefined);
});

test('sessionId y rustdeskId ausentes, vacios o de solo espacios son inexistentes', () => {
  const invalidPairs = [
    [undefined, 'DEV_GET_INVALID'],
    [null, 'DEV_GET_INVALID'],
    ['', 'DEV_GET_INVALID'],
    ['   ', 'DEV_GET_INVALID'],
    ['pv_get_invalid', undefined],
    ['pv_get_invalid', null],
    ['pv_get_invalid', ''],
    ['pv_get_invalid', '   '],
  ];
  for (const [sessionId, rustdeskId] of invalidPairs) {
    assert.strictEqual(preview.getPreviewForDevice(sessionId, rustdeskId), null);
  }
});

test('la comparacion es exacta, sensible a mayusculas y sin coincidencias parciales', () => {
  const ctx = createSession('Dev_Get_Exact_ABC');
  const id = ctx.session.session_id;

  assert.strictEqual(preview.getPreviewForDevice(id, 'dev_get_exact_abc'), null);
  assert.strictEqual(preview.getPreviewForDevice(id, 'Dev_Get_Exact'), null);
  assert.strictEqual(preview.getPreviewForDevice(id.slice(0, -1), ctx.rustdeskId), null);
  assert.strictEqual(preview.getPreviewForDevice(id.toUpperCase(), ctx.rustdeskId), null);
  assert.deepStrictEqual(
    preview.getPreviewForDevice(id, ctx.rustdeskId),
    ctx.session,
  );
});

test('consulta correcta y cruzada no modifican columnas ni producen efectos secundarios', () => {
  const a = createSession('DEV_GET_READONLY_A');
  const b = createSession('DEV_GET_READONLY_B');
  const beforeA = getSessionRow(a.session.session_id);
  const beforeB = getSessionRow(b.session.session_id);
  const activityBefore = activityCount();
  wsMock.clear();
  mediaCalls.length = 0;

  assert.strictEqual(
    preview.getPreviewForDevice(b.session.session_id, a.rustdeskId),
    null,
  );
  assert.deepStrictEqual(
    preview.getPreviewForDevice(b.session.session_id, b.rustdeskId),
    b.session,
  );

  assert.deepStrictEqual(getSessionRow(a.session.session_id), beforeA);
  assert.deepStrictEqual(getSessionRow(b.session.session_id), beforeB);
  assert.strictEqual(activityCount(), activityBefore);
  assert.deepStrictEqual(wsMock.sent, []);
  assert.deepStrictEqual(mediaCalls, []);
});

test('una sesion terminal del dispositivo correcto sigue siendo consultable sin cambios', () => {
  const ctx = createSession('DEV_GET_TERMINAL');
  forceSessionColumns(ctx.session.session_id, {
    status: 'expired',
    ended_at: '2026-01-02 03:04:05',
    playback_url: null,
  });
  const before = getSessionRow(ctx.session.session_id);

  const result = preview.getPreviewForDevice(ctx.session.session_id, ctx.rustdeskId);

  assert.strictEqual(result.status, 'expired');
  assert.deepStrictEqual(getSessionRow(ctx.session.session_id), before);
});
