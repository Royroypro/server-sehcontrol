const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('../public/admin/screenCamPreview');
const adminHtml = fs.readFileSync(
  path.resolve(__dirname, '..', 'public', 'admin', 'index.html'),
  'utf8',
);

class FakePeerConnection {
  constructor(state = 'gathering') {
    this.iceGatheringState = state;
    this.listeners = new Set();
  }

  addEventListener(name, listener) {
    if (name === 'icegatheringstatechange') this.listeners.add(listener);
  }

  removeEventListener(name, listener) {
    if (name === 'icegatheringstatechange') this.listeners.delete(listener);
  }

  finishGathering() {
    this.iceGatheringState = 'complete';
    for (const listener of this.listeners) listener();
  }
}

test('espera que ICE termine antes de continuar con WHEP', async () => {
  const pc = new FakePeerConnection();
  let resolved = false;
  const waiting = helpers.waitForIceGatheringComplete(pc, 100)
    .then(() => { resolved = true; });

  await Promise.resolve();
  assert.strictEqual(resolved, false);
  pc.finishGathering();
  await waiting;
  assert.strictEqual(resolved, true);
  assert.strictEqual(pc.listeners.size, 0);
});

test('ICE ya completo no instala listeners innecesarios', async () => {
  const pc = new FakePeerConnection('complete');
  await helpers.waitForIceGatheringComplete(pc, 100);
  assert.strictEqual(pc.listeners.size, 0);
});

test('la espera ICE tiene un limite y limpia el listener', async () => {
  const pc = new FakePeerConnection();
  await assert.rejects(
    helpers.waitForIceGatheringComplete(pc, 5),
    /Tiempo de espera ICE agotado/,
  );
  assert.strictEqual(pc.listeners.size, 0);
});

test('el SDP enviado sale de localDescription despues de recopilar candidatos', () => {
  assert.strictEqual(
    helpers.localOfferSdp({ localDescription: { sdp: 'offer-with-candidates' } }),
    'offer-with-candidates',
  );
  assert.throws(() => helpers.localOfferSdp({}), /no genero una oferta SDP/);
  assert.match(adminHtml, /body:\s*ScreenCamPreview\.localOfferSdp\(pc\)/);
  assert.doesNotMatch(adminHtml, /body:\s*offer\.sdp/);
});

test('el frontend cancela solicitudes y evita sesiones zombie al cerrar', () => {
  assert.match(adminHtml, /requestAbort:\s*new AbortController\(\)/);
  assert.match(adminHtml, /signal:\s*state\.requestAbort\.signal/);
  assert.match(adminHtml, /state\.requestAbort\.abort\(\)/);
  assert.match(adminHtml, /if \(PREVIEW_STATE !== state\)/);
});

test('el cierre de pagina envia una sola orden beacon-stop', () => {
  assert.match(adminHtml, /window\.addEventListener\('pagehide', stopPreviewOnPageExit\)/);
  assert.match(adminHtml, /window\.addEventListener\('beforeunload', stopPreviewOnPageExit\)/);
  assert.match(adminHtml, /state\.beaconSent = true/);
});
