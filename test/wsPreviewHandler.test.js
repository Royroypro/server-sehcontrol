// Contrato y respuesta del handler preview cliente -> servidor sin abrir sockets.
const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const path = require('node:path');
const ws = require(path.resolve(__dirname, '..', 'src', 'ws.js'));

test.after(() => env.cleanup());

function socketRecorder() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
  };
}

function previewStub(result = null) {
  return {
    calls: [],
    updateFromClientForUser(...args) {
      this.calls.push(args);
      return result;
    },
  };
}

test('pasa userId autenticado, session_id y rustdesk_id a la funcion segura', () => {
  const socket = socketRecorder();
  const preview = previewStub(null);
  ws.handleClientEvent(77, {
    event: 'screen_cam.preview.started',
    session_id: 'pv_handler_1',
    rustdesk_id: 'DEV_HANDLER_1',
  }, socket, preview);
  assert.deepStrictEqual(preview.calls, [[
    77,
    'pv_handler_1',
    'DEV_HANDLER_1',
    { status: 'publishing', error: undefined },
  ]]);
});

for (const invalidMessage of [
  { event: 'screen_cam.preview.started', session_id: 'pv_handler_missing' },
  { event: 'screen_cam.preview.started', session_id: 'pv_handler_empty', rustdesk_id: '' },
  { event: 'screen_cam.preview.started', session_id: 'pv_handler_blank', rustdesk_id: '   ' },
  { event: 'screen_cam.preview.started', session_id: 'pv_handler_object', rustdesk_id: {} },
]) {
  test('rustdesk_id valido es obligatorio y los datos incompletos no responden', () => {
    const socket = socketRecorder();
    const preview = previewStub({ status: 'ready' });
    ws.handleClientEvent(77, invalidMessage, socket, preview);
    assert.strictEqual(preview.calls.length, 0);
    assert.deepStrictEqual(socket.sent, []);
  });
}

test('sesion ajena y sesion inexistente no reciben state', () => {
  for (const sessionId of ['pv_foreign', 'pv_missing']) {
    const socket = socketRecorder();
    const preview = previewStub(null);
    ws.handleClientEvent(77, {
      event: 'screen_cam.preview.started',
      session_id: sessionId,
      rustdesk_id: 'DEV_HANDLER_DENIED',
    }, socket, preview);
    assert.deepStrictEqual(socket.sent, []);
  }
});

test('propietario autorizado recibe screen_cam.preview.state con type + data', () => {
  const state = {
    session_id: 'pv_handler_owner',
    device_id: 'DEV_HANDLER_OWNER',
    status: 'ready',
    playback_url: 'https://media.invalid/session/whep?token=opaque',
  };
  const socket = socketRecorder();
  const preview = previewStub(state);
  ws.handleClientEvent(77, {
    event: 'screen_cam.preview.started',
    session_id: state.session_id,
    rustdesk_id: state.device_id,
  }, socket, preview);
  assert.deepStrictEqual(socket.sent, [{
    type: 'screen_cam.preview.state',
    data: state,
  }]);
  assert.ok(!('read_token' in socket.sent[0].data));
  assert.strictEqual(socket.sent[0].data.playback_url, state.playback_url);
});

test('cliente -> servidor conserva event en la raiz para los cuatro eventos', () => {
  const expected = new Map([
    ['screen_cam.preview.connecting', 'connecting'],
    ['screen_cam.preview.started', 'publishing'],
    ['screen_cam.preview.failed', 'failed'],
    ['screen_cam.preview.stopped', 'stopped'],
  ]);
  for (const [event, status] of expected) {
    const socket = socketRecorder();
    const preview = previewStub(null);
    const message = {
      event,
      session_id: 'pv_handler_contract',
      rustdesk_id: 'DEV_HANDLER_CONTRACT',
    };
    ws.handleClientEvent(77, message, socket, preview);
    assert.strictEqual(preview.calls[0][3].status, status);
    assert.ok('event' in message);
    assert.ok(!('type' in message));
    assert.ok(!('data' in message));
  }
});

test('connecting, failed y stopped sin resultado autorizado no generan respuesta', () => {
  for (const event of [
    'screen_cam.preview.connecting',
    'screen_cam.preview.failed',
    'screen_cam.preview.stopped',
  ]) {
    const socket = socketRecorder();
    const preview = previewStub(null);
    ws.handleClientEvent(77, {
      event,
      session_id: 'pv_handler_terminal',
      rustdesk_id: 'DEV_HANDLER_TERMINAL',
      error: 'safe_code',
    }, socket, preview);
    assert.deepStrictEqual(socket.sent, []);
  }
});
