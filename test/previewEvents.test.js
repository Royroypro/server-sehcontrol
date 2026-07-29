// ============================================================
// PRUEBAS DE REGRESION — YA CORREGIDAS, ACTUAN COMO GUARDA
// ============================================================
//
// Estas dos pruebas nacieron fallando: describian el formato final acordado
// mientras el codigo emitia `event` en la raiz, sin envoltorio `data`.
// Con la correccion aplicada en src/screenCamPreview.js ahora pasan, y
// quedan como guarda para que nadie vuelva al formato viejo.
//
// Las expectativas NO se relajaron para hacerlas pasar: se corrigio el
// codigo productivo. Solo cambio el titulo ("falla hoy" -> "guarda"), que
// ya no describia la realidad.
//
// Formato esperado:
//   { type: 'screen_cam.preview.start', data: { session_id, rustdesk_id,
//     publish_url, publish_token, stream_name, expires_in } }
//   { type: 'screen_cam.preview.stop',  data: { session_id, rustdesk_id } }
//
// Reglas adicionales: sin `event` en la raiz, sin `stream_id`, y
// `publish_token` una sola vez en todo el payload.
const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();

const { projectRequire, seedActiveDevice } = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');
const { makeMediaApiMock } = require('./helpers/mediaApiMock');

const preview = projectRequire('src/screenCamPreview.js');
const wsMock = installWsMock();
const mediaApi = makeMediaApiMock();

test.after(() => {
  wsMock.restore();
  env.cleanup();
});

// Cuenta cuantas veces aparece un valor en todo el payload, a cualquier
// profundidad. Sirve para exigir que el token no se duplique.
function countValueOccurrences(node, value) {
  if (node === value) return 1;
  if (Array.isArray(node)) return node.reduce((n, v) => n + countValueOccurrences(v, value), 0);
  if (node && typeof node === 'object') {
    return Object.values(node).reduce((n, v) => n + countValueOccurrences(v, value), 0);
  }
  return 0;
}

test('REGRESION (guarda): start se emite como {type, data}', () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_EVT_1' });
  wsMock.clear();
  const session = preview.startPreview('DEV_EVT_1', 1);

  assert.strictEqual(wsMock.sent.length, 1, 'se empuja exactamente un evento al crear la sesion');
  const payload = wsMock.sent[0].payload;

  // El evento sigue yendo al propietario del dispositivo, no a quien lo pidio.
  assert.strictEqual(wsMock.sent[0].userId, userId, 'el destinatario debe ser el propietario del equipo');

  assert.strictEqual(payload.type, 'screen_cam.preview.start', 'debe usar `type`, como el resto de los eventos del servidor');
  assert.ok(!('event' in payload), 'no debe existir `event` en la raiz');
  assert.ok(payload.data && typeof payload.data === 'object', 'los datos van dentro de `data`');

  // Todo el detalle de la preview vive dentro de `data`, no suelto en la raiz.
  assert.strictEqual(payload.data.session_id, session.session_id);
  assert.strictEqual(payload.data.rustdesk_id, 'DEV_EVT_1');
  assert.strictEqual(payload.data.stream_name, session.session_id);
  assert.strictEqual(payload.data.expires_in, 300);
  assert.ok(payload.data.publish_url, 'debe llevar publish_url');
  assert.ok(payload.data.publish_token, 'debe llevar publish_token');

  // Sin campos sueltos en la raiz mas alla de type/data.
  assert.deepStrictEqual(Object.keys(payload).sort(), ['data', 'type']);

  // No se agrega stream_id en esta etapa.
  assert.ok(!('stream_id' in payload.data), 'no debe agregarse stream_id todavia');

  // El token no debe repetirse en el payload.
  assert.strictEqual(
    countValueOccurrences(payload, payload.data.publish_token), 1,
    'publish_token debe aparecer una sola vez',
  );

  // Lo mismo sobre el objeto ya serializado, que es lo que viaja por el
  // socket. Se cuenta sin volcar el token en el mensaje de la asercion.
  const serialized = JSON.stringify(payload);
  const occurrences = serialized.split(payload.data.publish_token).length - 1;
  assert.strictEqual(occurrences, 1, 'publish_token debe aparecer una sola vez en el JSON serializado');
});

test('REGRESION (guarda): stop se emite como {type, data}', async () => {
  const { userId } = seedActiveDevice({ rustdeskId: 'DEV_EVT_2' });
  const session = preview.startPreview('DEV_EVT_2', 1);
  wsMock.clear();
  await preview.stopPreview(session.session_id, 1, {
    expectedRustdeskId: 'DEV_EVT_2', mediaApi,
  });

  assert.strictEqual(wsMock.sent.length, 1, 'se empuja exactamente un evento al detener');
  const payload = wsMock.sent[0].payload;

  assert.strictEqual(wsMock.sent[0].userId, userId, 'el destinatario debe ser el propietario del equipo');

  assert.strictEqual(payload.type, 'screen_cam.preview.stop', 'debe usar `type`');
  assert.ok(!('event' in payload), 'no debe existir `event` en la raiz');
  assert.ok(payload.data && typeof payload.data === 'object', 'los datos van dentro de `data`');

  assert.strictEqual(payload.data.session_id, session.session_id);
  assert.strictEqual(payload.data.rustdesk_id, 'DEV_EVT_2');

  assert.deepStrictEqual(Object.keys(payload).sort(), ['data', 'type']);
  assert.ok(!('publish_token' in payload.data), 'el stop no debe reenviar el token');
});

// ------------------------------------------------------------------
// Regresion documental: la guia que leen los desarrolladores del
// cliente debe describir el mismo formato que emite el servidor. Si
// alguien cambia uno sin el otro, estas pruebas lo detectan.
// Solo leen el archivo del repo; sin red y sin imprimir tokens.
// ------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

function readIntegrationDoc() {
  return fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'CLIENT_INTEGRATION.md'), 'utf8');
}

test('la documentacion describe start y stop con type + data', () => {
  const doc = readIntegrationDoc();
  assert.ok(doc.includes('"type": "screen_cam.preview.start"'), 'debe documentar el start con `type`');
  assert.ok(doc.includes('"type": "screen_cam.preview.stop"'), 'debe documentar el stop con `type`');
  // Los dos ejemplos deben llevar el envoltorio `data`.
  const startBlock = doc.slice(doc.indexOf('"type": "screen_cam.preview.start"'));
  assert.ok(startBlock.slice(0, 400).includes('"data"'), 'el ejemplo de start debe traer `data`');
  const stopBlock = doc.slice(doc.indexOf('"type": "screen_cam.preview.stop"'));
  assert.ok(stopBlock.slice(0, 400).includes('"data"'), 'el ejemplo de stop debe traer `data`');
});

test('la documentacion NO describe start/stop con event en la raiz', () => {
  const doc = readIntegrationDoc();
  assert.ok(
    !doc.includes('"event": "screen_cam.preview.start"'),
    'el start ya no se emite con `event`: no debe seguir documentado asi',
  );
  assert.ok(
    !doc.includes('"event": "screen_cam.preview.stop"'),
    'el stop ya no se emite con `event`: no debe seguir documentado asi',
  );
});

test('la documentacion conserva event en la raiz para cliente -> servidor', () => {
  const doc = readIntegrationDoc();
  assert.ok(
    doc.includes('"event": "screen_cam.preview.started"'),
    'los estados que manda el cliente siguen usando `event`',
  );
  assert.ok(
    doc.includes('"event": "screen_cam.preview.failed"'),
    'el estado failed del cliente sigue usando `event`',
  );
});

test('la documentacion exige rustdesk_id en los estados cliente -> servidor', () => {
  const doc = readIntegrationDoc();
  const started = doc.slice(doc.indexOf('"event": "screen_cam.preview.started"'));
  const failed = doc.slice(doc.indexOf('"event": "screen_cam.preview.failed"'));
  assert.ok(started.slice(0, 250).includes('"rustdesk_id"'));
  assert.ok(failed.slice(0, 300).includes('"rustdesk_id"'));
  assert.match(doc, /rustdesk_id` es obligatorio/);
  assert.match(doc, /conocer solo el `session_id` no autoriza/);
});

test('la documentacion distingue explicitamente los dos sentidos', () => {
  const doc = readIntegrationDoc();
  assert.match(doc, /Servidor\s*→\s*cliente:\s*type\s*\+\s*data/);
  assert.match(doc, /Cliente\s*→\s*servidor:\s*event en la ra[ií]z/);
});

test('la documentacion explica cuando ignorar un stop', () => {
  const doc = readIntegrationDoc();
  assert.ok(doc.includes('Ignoren el stop'), 'debe indicar cuando descartar un stop');
  assert.match(doc, /sesi[oó]n anterior ya cerrada/, 'debe cubrir el stop rezagado');
});
