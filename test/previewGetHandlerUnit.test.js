// Pruebas unitarias (sin red, sin DB) del enriquecimiento playback_ready
// del handler GET de previsualizacion (Tarea 2). previewGetRoutes.test.js
// ya cubre la ruta real de punta a punta; este archivo fija el contrato
// exacto de como isPathPublisherReady se traduce a playback_ready.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
test.after(() => env.cleanup());

const adminRouter = require(path.resolve(__dirname, '..', 'src', 'routes', 'admin.js'));
const { createScreenCamPreviewGetHandler } = adminRouter;

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; if (this.statusCode == null) this.statusCode = 200; return this; },
  };
}

function req(rustdeskId, sessionId) {
  return { params: { rustdeskId, sessionId } };
}

test('no consulta a MediaMTX cuando la sesion todavia no esta ready', async () => {
  let calls = 0;
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => ({ session_id: 'pv_1', status: 'waiting_client', playback_url: null }),
    isPathPublisherReady: () => { calls += 1; return Promise.resolve({ ready: true, error: null }); },
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_1'), res);

  assert.strictEqual(calls, 0, 'no tiene sentido preguntar disponibilidad si todavia no hay playback_url');
  assert.strictEqual(res.body.playback_ready, false);
});

test('playback_ready=true cuando MediaMTX confirma publisher', async () => {
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => ({ session_id: 'pv_1', status: 'ready', playback_url: 'https://x/whep' }),
    isPathPublisherReady: async (sessionId) => {
      assert.strictEqual(sessionId, 'pv_1');
      return { ready: true, error: null };
    },
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_1'), res);
  assert.strictEqual(res.body.playback_ready, true);
});

test('playback_ready=false cuando MediaMTX confirma explicitamente que NO hay publisher', async () => {
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => ({ session_id: 'pv_1', status: 'ready', playback_url: 'https://x/whep' }),
    isPathPublisherReady: async () => ({ ready: false, error: null }),
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_1'), res);
  assert.strictEqual(res.body.playback_ready, false);
});

test('playback_ready=true (fail-open) cuando la disponibilidad es desconocida', async () => {
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => ({ session_id: 'pv_1', status: 'ready', playback_url: 'https://x/whep' }),
    isPathPublisherReady: async () => ({ ready: null, error: 'timeout' }),
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_1'), res);
  assert.strictEqual(res.body.playback_ready, true, 'nunca debe bloquear la reproduccion por un chequeo fallido');
});

test('playback_ready=true (fail-open) si la consulta de disponibilidad lanza una excepcion', async () => {
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => ({ session_id: 'pv_1', status: 'ready', playback_url: 'https://x/whep' }),
    isPathPublisherReady: async () => { throw new Error('deberia estar contenido'); },
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_1'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.playback_ready, true);
});

test('sesion inexistente sigue devolviendo 404 sin consultar disponibilidad', async () => {
  let calls = 0;
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => null,
    isPathPublisherReady: () => { calls += 1; return Promise.resolve({ ready: true, error: null }); },
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_missing'), res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(calls, 0);
});

test('un fallo inesperado en getPreviewForDevice sigue devolviendo 500 sanitario', async () => {
  const logs = [];
  const handler = createScreenCamPreviewGetHandler({
    getPreviewForDevice: () => { throw new Error('token=SECRET /home/private'); },
    isPathPublisherReady: async () => ({ ready: true, error: null }),
    logger: (...args) => logs.push(args),
  });

  const res = responseRecorder();
  await handler(req('DEV', 'pv_1'), res);
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: 'Error interno del servidor' });
  const serialized = JSON.stringify({ logs, body: res.body });
  assert.ok(!serialized.includes('SECRET'));
  assert.ok(!serialized.includes('/home/private'));
});
