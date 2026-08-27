const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('../public/admin/screenCamPreview');
const adminHtml = fs.readFileSync(
  path.resolve(__dirname, '..', 'public', 'admin', 'index.html'),
  'utf8',
);

// ---------- Test doubles ----------

class FakeEventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(name, fn) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(fn);
  }

  removeEventListener(name, fn) {
    this._listeners.get(name)?.delete(fn);
  }

  _emit(name, ...args) {
    for (const fn of [...(this._listeners.get(name) || [])]) fn(...args);
  }

  _listenerCount(name) {
    return this._listeners.get(name)?.size || 0;
  }
}

class FakePeerConnection extends FakeEventTarget {
  constructor(state = 'complete') {
    super();
    this.iceGatheringState = state;
    this.connectionState = 'new';
    this.closed = false;
    this.transceivers = [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.ontrack = null;
  }

  addTransceiver(kind, opts) { this.transceivers.push({ kind, opts }); }

  async createOffer() { return { type: 'offer', sdp: `offer-sdp-${Math.random()}` }; }

  async setLocalDescription(desc) { this.localDescription = desc; }

  async setRemoteDescription(desc) { this.remoteDescription = desc; }

  close() { this.closed = true; this.connectionState = 'closed'; }

  finishGathering() {
    this.iceGatheringState = 'complete';
    this._emit('icegatheringstatechange');
  }

  setConnectionState(state) {
    this.connectionState = state;
    this._emit('connectionstatechange');
  }

  emitTrack(stream) {
    this.ontrack?.({ streams: [stream] });
  }
}

class FakeVideoElement extends FakeEventTarget {
  constructor() {
    super();
    this.srcObject = null;
    this.style = { display: 'none' };
    this.playCalls = 0;
  }

  play() { this.playCalls += 1; return Promise.resolve(); }
}

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutImpl: (fn, ms) => {
      const id = nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutImpl: (id) => { pending.delete(id); },
    pendingCount: () => pending.size,
    pendingDelays: () => [...pending.values()].map((e) => e.ms),
    runAll: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of entries) fn();
    },
  };
}

function createQueueFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      const next = responses.shift();
      if (!next) throw new Error('no hay respuesta programada para este intento');
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => next.body || 'answer-sdp',
      };
    },
  };
}

function flushAsync() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await flushAsync();
}

// ---------- ICE gathering (helper de siempre) ----------

test('espera que ICE termine antes de continuar con WHEP', async () => {
  const pc = new FakePeerConnection('gathering');
  let resolved = false;
  const waiting = helpers.waitForIceGatheringComplete(pc, 100)
    .then(() => { resolved = true; });

  await Promise.resolve();
  assert.strictEqual(resolved, false);
  pc.finishGathering();
  await waiting;
  assert.strictEqual(resolved, true);
  assert.strictEqual(pc._listenerCount('icegatheringstatechange'), 0);
});

test('ICE ya completo no instala listeners innecesarios', async () => {
  const pc = new FakePeerConnection('complete');
  await helpers.waitForIceGatheringComplete(pc, 100);
  assert.strictEqual(pc._listenerCount('icegatheringstatechange'), 0);
});

test('la espera ICE tiene un limite y limpia el listener', async () => {
  const pc = new FakePeerConnection('gathering');
  await assert.rejects(
    helpers.waitForIceGatheringComplete(pc, 5),
    /Tiempo de espera ICE agotado/,
  );
  assert.strictEqual(pc._listenerCount('icegatheringstatechange'), 0);
});

test('el SDP enviado sale de localDescription despues de recopilar candidatos', () => {
  assert.strictEqual(
    helpers.localOfferSdp({ localDescription: { sdp: 'offer-with-candidates' } }),
    'offer-with-candidates',
  );
  assert.throws(() => helpers.localOfferSdp({}), /no genero una oferta SDP/);
});

// ---------- Clasificacion de resultados WHEP y backoff ----------

test('clasifica 2xx como exito, 404/409/503 como transitorio y el resto como definitivo', () => {
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 201 }), 'success');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 200 }), 'success');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 404 }), 'transient_failure');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 409 }), 'transient_failure');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 503 }), 'transient_failure');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 401 }), 'fatal_failure');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 403 }), 'fatal_failure');
  assert.strictEqual(helpers.classifyWhepOutcome({ status: 500 }), 'fatal_failure');
  assert.strictEqual(helpers.classifyWhepOutcome({ aborted: true, status: 404 }), 'cancelled');
});

test('la secuencia de backoff sube y se mantiene en el ultimo valor', () => {
  const delays = [0, 1, 2, 3, 4, 5, 6].map((i) => helpers.whepBackoffMs(i));
  assert.deepStrictEqual(delays, [300, 500, 750, 1000, 1500, 1500, 1500]);
});

// ---------- Gate de primer frame (evita pantalla negra) ----------

test('el gate de primer frame se dispara una sola vez y limpia sus listeners', () => {
  const video = new FakeVideoElement();
  let fired = 0;
  const gate = helpers.attachFirstFrameGate(video, { onFirstFrame: () => { fired += 1; } });
  assert.strictEqual(gate.hasFired(), false);
  video._emit('loadeddata');
  video._emit('playing'); // no deberia disparar onFirstFrame otra vez
  assert.strictEqual(fired, 1);
  assert.strictEqual(gate.hasFired(), true);
  assert.strictEqual(video._listenerCount('loadeddata'), 0);
  assert.strictEqual(video._listenerCount('stalled'), 0);
});

test('el gate reporta stall/error solo si todavia no disparo el primer frame', () => {
  const video = new FakeVideoElement();
  let stalls = 0;
  helpers.attachFirstFrameGate(video, { onFirstFrame: () => {}, onStalled: () => { stalls += 1; } });
  video._emit('stalled');
  assert.strictEqual(stalls, 1);
});

// ---------- Controller de WHEP: reintentos, invariantes, primer frame ----------

function baseControllerConfig(overrides = {}) {
  const timers = overrides.timers || createManualTimers();
  const pcs = [];
  const pcFactory = overrides.pcFactory || (() => {
    const pc = new FakePeerConnection('complete');
    pcs.push(pc);
    return pc;
  });
  return {
    timers,
    pcs,
    config: {
      whepUrl: 'https://example.invalid/pv_test/whep?token=redacted',
      pcFactory,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      isSessionActive: () => true,
      onStatus: () => {},
      onFirstFrame: () => {},
      onTerminal: () => {},
      onTiming: () => {},
      ...overrides.config,
    },
  };
}

test('un 404 transitorio se reintenta y un 201 posterior detiene los reintentos', async () => {
  const { fetchImpl, calls } = createQueueFetch([{ status: 404 }, { status: 201 }]);
  const statuses = [];
  const { timers, pcs, config } = baseControllerConfig({
    config: { fetchImpl, onStatus: (t) => statuses.push(t) },
  });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(timers.pendingCount(), 1);
  assert.deepStrictEqual(timers.pendingDelays(), [300]);

  timers.runAll();
  await settle();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(timers.pendingCount(), 0, 'un 201 no debe dejar ningun reintento programado');
  assert.strictEqual(pcs.length, 2, 'cada intento crea su propia PeerConnection');
  assert.ok(pcs[0].closed, 'la PeerConnection del intento fallido se cierra');
  assert.ok(!pcs[1].closed, 'la PeerConnection exitosa queda viva esperando el primer frame');
});

test('nunca hay mas de una PeerConnection abierta a la vez durante los reintentos', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 404 }, { status: 404 }, { status: 201 }]);
  const { timers, pcs, config } = baseControllerConfig({ config: { fetchImpl } });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  timers.runAll();
  await settle();
  timers.runAll();
  await settle();

  assert.strictEqual(pcs.length, 3);
  const openCount = pcs.filter((pc) => !pc.closed).length;
  assert.strictEqual(openCount, 1, 'solo la ultima PeerConnection (exitosa) debe seguir abierta');
});

test('401 es definitivo: no reintenta y notifica onTerminal', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 401 }]);
  let terminalReason = null;
  const statuses = [];
  const { timers, config } = baseControllerConfig({
    config: { fetchImpl, onTerminal: (r) => { terminalReason = r; }, onStatus: (t, e) => statuses.push([t, e]) },
  });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();

  assert.strictEqual(terminalReason, 'fatal_failure');
  assert.strictEqual(timers.pendingCount(), 0, '401 no debe dejar ningun reintento programado');
  assert.ok(statuses.some(([, isError]) => isError === true));
});

test('403 tambien es definitivo (igual que 401)', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 403 }]);
  let terminalReason = null;
  const { config } = baseControllerConfig({
    config: { fetchImpl, onTerminal: (r) => { terminalReason = r; } },
  });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  assert.strictEqual(terminalReason, 'fatal_failure');
});

test('cancel() aborta el fetch en vuelo y evita cualquier reintento posterior', async () => {
  let rejectFetch;
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url, opts });
    return new Promise((_resolve, reject) => {
      rejectFetch = reject;
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const { timers, config } = baseControllerConfig({ config: { fetchImpl } });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  assert.strictEqual(calls.length, 1);

  controller.cancel();
  await settle();

  assert.strictEqual(timers.pendingCount(), 0);
  timers.runAll(); // no deberia quedar nada que ejecutar, pero por las dudas
  await settle();
  assert.strictEqual(calls.length, 1, 'cancelar no debe disparar ningun intento nuevo');
  void rejectFetch;
});

test('el video permanece oculto hasta el primer frame real y luego se muestra', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 201 }]);
  const video = new FakeVideoElement();
  let firstFrameFired = false;
  const { config, pcs } = baseControllerConfig({
    config: {
      fetchImpl,
      getVideoElement: () => video,
      onFirstFrame: () => { firstFrameFired = true; },
    },
  });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();

  const [pc] = pcs;
  pc.emitTrack({ id: 'stream-1' });
  assert.strictEqual(video.srcObject.id, 'stream-1');
  assert.strictEqual(firstFrameFired, false, 'asignar srcObject no debe mostrar el video todavia');

  video._emit('loadeddata');
  assert.strictEqual(firstFrameFired, true);
});

test('una PeerConnection en estado failed se cierra y se reconstruye', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 201 }, { status: 201 }]);
  const { config, pcs, timers } = baseControllerConfig({ config: { fetchImpl } });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  assert.strictEqual(pcs.length, 1);

  pcs[0].setConnectionState('failed');
  await settle();
  assert.ok(pcs[0].closed);
  assert.strictEqual(timers.pendingCount(), 1, 'la reconstruccion se programa con backoff, no es inmediata');

  timers.runAll();
  await settle();
  assert.strictEqual(pcs.length, 2, 'se crea una PeerConnection nueva para el reintento');
});

test('si la sesion deja de estar activa, el controller no reintenta y termina', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 404 }]);
  let active = true;
  let terminalReason = null;
  const { config, timers } = baseControllerConfig({
    config: {
      fetchImpl,
      isSessionActive: () => active,
      onTerminal: (r) => { terminalReason = r; },
    },
  });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  assert.strictEqual(timers.pendingCount(), 1);

  active = false;
  timers.runAll();
  await settle();

  assert.strictEqual(terminalReason, 'session_inactive');
});

test('los intentos sucesivos no acumulan listeners en el elemento de video compartido', async () => {
  const { fetchImpl } = createQueueFetch([{ status: 201 }, { status: 201 }]);
  const video = new FakeVideoElement();
  const { config, pcs, timers } = baseControllerConfig({
    config: { fetchImpl, getVideoElement: () => video },
  });
  const controller = helpers.createWhepController(config);

  controller.start();
  await settle();
  pcs[0].emitTrack({ id: 'a' });
  assert.strictEqual(video._listenerCount('loadeddata'), 1);

  pcs[0].setConnectionState('failed'); // programa un segundo intento sobre el mismo <video>
  await settle();
  timers.runAll();
  await settle();
  pcs[1].emitTrack({ id: 'b' });

  assert.strictEqual(video._listenerCount('loadeddata'), 1, 'el gate anterior debe haberse liberado, no acumulado');
});

// ---------- Cableado en index.html (lo que sigue viviendo ahi) ----------

test('el frontend usa el controller de WHEP y respeta playback_ready', () => {
  assert.match(adminHtml, /ScreenCamPreview\.createWhepController\(/);
  assert.match(adminHtml, /s\.playback_ready === false/);
});

test('el frontend cancela solicitudes y evita sesiones zombie al cerrar', () => {
  assert.match(adminHtml, /requestAbort:\s*new AbortController\(\)/);
  assert.match(adminHtml, /signal:\s*state\.requestAbort\.signal/);
  assert.match(adminHtml, /state\.requestAbort\.abort\(\)/);
  assert.match(adminHtml, /if \(PREVIEW_STATE !== state\)/);
  assert.match(adminHtml, /state\.controller\?\.cancel\(\)/);
});

test('el cierre de pagina envia una sola orden beacon-stop', () => {
  assert.match(adminHtml, /window\.addEventListener\('pagehide', stopPreviewOnPageExit\)/);
  assert.match(adminHtml, /window\.addEventListener\('beforeunload', stopPreviewOnPageExit\)/);
  assert.match(adminHtml, /state\.beaconSent = true/);
});
