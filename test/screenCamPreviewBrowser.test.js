'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fmtpParameter,
  isH264MainPacketizationMode1,
  preferH264MainCodec,
  createWhepController,
} = require('../public/admin/screenCamPreview.js');

function codec(mimeType, sdpFmtpLine = '') {
  return { mimeType, clockRate: 90000, sdpFmtpLine };
}

test('detecta H264 Main packetization-mode 1 sin depender del orden de fmtp', () => {
  const main = codec(
    'video/H264',
    'level-asymmetry-allowed=1; profile-level-id=4D001F; packetization-mode=1',
  );
  const baseline = codec(
    'video/H264',
    'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
  );

  assert.equal(fmtpParameter(main, 'profile-level-id'), '4d001f');
  assert.equal(isH264MainPacketizationMode1(main), true);
  assert.equal(isH264MainPacketizationMode1(baseline), false);
});

test('coloca H264 Main primero y conserva todos los codecs de respaldo', () => {
  const vp8 = codec('video/VP8');
  const baseline = codec('video/H264', 'packetization-mode=1;profile-level-id=42e01f');
  const rtx = codec('video/rtx', 'apt=96');
  const main = codec('video/H264', 'profile-level-id=4d001f;packetization-mode=1');
  const original = [vp8, baseline, rtx, main];
  let applied = null;
  const transceiver = {
    setCodecPreferences(codecs) {
      applied = codecs;
    },
  };

  assert.equal(preferH264MainCodec(transceiver, { codecs: original }), true);
  assert.deepEqual(applied, [main, vp8, baseline, rtx]);
  assert.deepEqual(original, [vp8, baseline, rtx, main]);
});

test('mantiene la negociacion por defecto si Main no esta disponible', () => {
  const baseline = codec('video/H264', 'packetization-mode=1;profile-level-id=42e01f');
  let calls = 0;
  const transceiver = {
    setCodecPreferences() {
      calls += 1;
    },
  };

  assert.equal(preferH264MainCodec(transceiver, { codecs: [baseline] }), false);
  assert.equal(calls, 0);
});

test('el controller aplica la preferencia Main antes de crear la oferta WHEP', async () => {
  const events = [];
  const main = codec('video/H264', 'profile-level-id=4d001f;packetization-mode=1');
  let notifyFetch;
  const fetchCalled = new Promise((resolve) => { notifyFetch = resolve; });
  const transceiver = {
    setCodecPreferences(codecs) {
      events.push(['preferences', codecs]);
    },
  };
  const pc = {
    iceGatheringState: 'complete',
    connectionState: 'new',
    addEventListener() {},
    addTransceiver() {
      events.push(['transceiver']);
      return transceiver;
    },
    async createOffer() {
      events.push(['offer']);
      return { type: 'offer', sdp: 'v=0\r\n' };
    },
    async setLocalDescription(offer) {
      this.localDescription = offer;
    },
    async setRemoteDescription() {},
    close() {},
  };
  const controller = createWhepController({
    whepUrl: 'https://example.invalid/whep',
    pcFactory: () => pc,
    getVideoCapabilities: () => ({ codecs: [codec('video/VP8'), main] }),
    waitForIceGathering: async () => {},
    fetchImpl: async () => {
      events.push(['fetch']);
      notifyFetch();
      return { status: 201, ok: true, text: async () => 'v=0\r\n' };
    },
  });

  controller.start();
  await fetchCalled;
  assert.deepEqual(events[0], ['transceiver']);
  assert.deepEqual(events[1], ['preferences', [main, codec('video/VP8')]]);
  assert.deepEqual(events[2], ['offer']);
  controller.cancel();
});
