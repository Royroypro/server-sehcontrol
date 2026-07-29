const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire } = require('./helpers/fixtures');
const scheduler = projectRequire('src/screenCamPreviewScheduler.js');
const signalListenersBeforeImport = {
  SIGTERM: process.listenerCount('SIGTERM'),
  SIGINT: process.listenerCount('SIGINT'),
};
const {
  startServer,
  closeWebSocketServer,
  closeHttpServer,
  createShutdownHandler,
  registerShutdownSignals,
} = projectRequire('src/server.js');

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeTimeouts() {
  const handles = [];
  const cleared = [];
  return {
    handles,
    cleared,
    setTimeout(callback, milliseconds) {
      const handle = {
        callback,
        milliseconds,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        },
      };
      handles.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
    fire(handle) {
      handle.callback();
    },
  };
}

function emptyWebSocketServer() {
  return {
    clients: new Set(),
    closeCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      callback();
    },
  };
}

test.after(async () => {
  await scheduler.stopPreviewExpirationScheduler({ drain: false });
  env.cleanup();
});

test('importar server.js no escucha, no inicia scheduler ni registra señales', () => {
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().running, false);
  assert.strictEqual(
    process.listenerCount('SIGTERM'),
    signalListenersBeforeImport.SIGTERM,
  );
  assert.strictEqual(
    process.listenerCount('SIGINT'),
    signalListenersBeforeImport.SIGINT,
  );
});

test('bootstrap conserva servidores y controladores y los detiene exactamente una vez', async () => {
  const fakeProcess = new EventEmitter();
  const fakeServer = {
    closeCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      callback();
    },
  };
  const fakeWss = emptyWebSocketServer();
  let listeningCallback;
  let schedulerStarts = 0;
  let schedulerStops = 0;
  let membershipStarts = 0;
  let membershipStops = 0;
  let notificationStarts = 0;
  let notificationStops = 0;
  const membershipController = {
    stop() {
      membershipStops += 1;
    },
  };
  const notificationController = {
    stop() {
      notificationStops += 1;
    },
  };

  const lifecycle = startServer({
    port: 0,
    host: '127.0.0.1',
    processObject: fakeProcess,
    listen(callback) {
      listeningCallback = callback;
      return fakeServer;
    },
    initWebSocketServer(server) {
      assert.strictEqual(server, fakeServer);
      return fakeWss;
    },
    startPeriodicSync() {
      membershipStarts += 1;
      return membershipController;
    },
    startAlertScheduler() {
      notificationStarts += 1;
      return notificationController;
    },
    startScheduler() {
      schedulerStarts += 1;
    },
    stopScheduler: async (options) => {
      schedulerStops += 1;
      assert.deepStrictEqual(options, { drain: true, drainTimeoutMs: 5_000 });
      return { stopped: true, drained: true, timed_out: false };
    },
    logger: () => {},
  });

  assert.strictEqual(lifecycle.server, fakeServer);
  assert.strictEqual(lifecycle.httpServer, fakeServer);
  assert.strictEqual(lifecycle.wss, fakeWss);
  assert.strictEqual(lifecycle.webSocketServer, fakeWss);
  assert.strictEqual(lifecycle.membershipController, null);
  assert.strictEqual(lifecycle.notificationController, null);
  assert.strictEqual(fakeProcess.listenerCount('SIGTERM'), 1);
  assert.strictEqual(fakeProcess.listenerCount('SIGINT'), 1);

  listeningCallback();
  listeningCallback();
  assert.strictEqual(schedulerStarts, 1);
  assert.strictEqual(membershipStarts, 1);
  assert.strictEqual(notificationStarts, 1);
  assert.strictEqual(lifecycle.membershipController, membershipController);
  assert.strictEqual(lifecycle.notificationController, notificationController);
  assert.strictEqual(lifecycle.controllers.membership, membershipController);
  assert.strictEqual(lifecycle.controllers.notifications, notificationController);
  assert.strictEqual(startServer(), lifecycle);

  const firstShutdown = lifecycle.shutdown('SIGTERM');
  const secondShutdown = lifecycle.shutdown('SIGINT');
  assert.strictEqual(firstShutdown, secondShutdown);
  assert.deepStrictEqual(await firstShutdown, {
    shutdown: true,
    server_closed: true,
    server_timed_out: false,
    websocket_closed: true,
    websocket_timed_out: false,
    websocket_clients: 0,
    websocket_terminated: 0,
    membership_stopped: true,
    notifications_stopped: true,
    scheduler_stopped: true,
    cleanup_drained: true,
    timed_out: false,
  });
  assert.strictEqual(schedulerStops, 1);
  assert.strictEqual(membershipStops, 1);
  assert.strictEqual(notificationStops, 1);
  assert.strictEqual(fakeWss.closeCalls, 1);
  assert.strictEqual(fakeServer.closeCalls, 1);
  assert.strictEqual(fakeProcess.listenerCount('SIGTERM'), 0);
  assert.strictEqual(fakeProcess.listenerCount('SIGINT'), 0);
});

test('SIGTERM y SIGINT comparten shutdown, operaciones y limpieza de listeners', async () => {
  const fakeProcess = new EventEmitter();
  const drain = deferred();
  const webSocketClose = deferred();
  const httpClose = deferred();
  let schedulerStops = 0;
  let webSocketStops = 0;
  let httpStops = 0;
  let membershipStops = 0;
  let notificationStops = 0;
  let remove = () => {};
  const shutdown = createShutdownHandler({
    server: {},
    webSocketServer: {},
    controllers: {
      membership: { stop: () => { membershipStops += 1; } },
      notifications: { stop: () => { notificationStops += 1; } },
    },
    stopScheduler() {
      schedulerStops += 1;
      return drain.promise;
    },
    closeWebSockets() {
      webSocketStops += 1;
      return webSocketClose.promise;
    },
    closeHttp() {
      httpStops += 1;
      return httpClose.promise;
    },
    removeSignalHandlers: () => remove(),
    logger: () => {},
  });
  remove = registerShutdownSignals({
    processObject: fakeProcess,
    shutdown,
    logger: () => {},
  });

  fakeProcess.emit('SIGTERM');
  fakeProcess.emit('SIGINT');
  assert.strictEqual(schedulerStops, 1);
  assert.strictEqual(webSocketStops, 1);
  assert.strictEqual(httpStops, 1);
  assert.strictEqual(membershipStops, 1);
  assert.strictEqual(notificationStops, 1);

  drain.resolve({ stopped: true, drained: true, timed_out: false });
  webSocketClose.resolve({ closed: true, timed_out: false, clients: 1, terminated: 0 });
  httpClose.resolve({ closed: true, timed_out: false, forced: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(fakeProcess.listenerCount('SIGTERM'), 0);
  assert.strictEqual(fakeProcess.listenerCount('SIGINT'), 0);
});

test('un fallo en cada componente no evita intentar los demas ni filtra errores', async () => {
  const logs = [];
  let removeCalls = 0;
  let exitCalls = 0;
  const originalExit = process.exit;
  process.exit = () => {
    exitCalls += 1;
  };
  try {
    const shutdown = createShutdownHandler({
      server: {},
      webSocketServer: {},
      controllers: {
        membership: { stop: () => { throw new Error('membership private'); } },
        notifications: { stop: () => { throw new Error('notification private'); } },
      },
      stopScheduler() {
        throw new Error('queue private');
      },
      closeWebSockets() {
        throw new Error('socket private');
      },
      closeHttp() {
        throw new Error('http private');
      },
      removeSignalHandlers() {
        removeCalls += 1;
      },
      logger: (message) => logs.push(String(message)),
    });

    const result = await shutdown('SIGTERM');
    assert.deepStrictEqual(result, {
      shutdown: true,
      server_closed: false,
      server_timed_out: false,
      websocket_closed: false,
      websocket_timed_out: false,
      websocket_clients: 0,
      websocket_terminated: 0,
      membership_stopped: false,
      notifications_stopped: false,
      scheduler_stopped: false,
      cleanup_drained: false,
      timed_out: false,
    });
    assert.deepStrictEqual(logs, [
      '[server] operation=shutdown code=scheduler_stop_failed',
      '[server] operation=shutdown code=membership_stop_failed',
      '[server] operation=shutdown code=notifications_stop_failed',
      '[server] operation=shutdown code=server_close_failed',
      '[server] operation=shutdown code=websocket_close_failed',
    ]);
    assert.ok(logs.every((message) => !message.includes('private')));
    assert.strictEqual(removeCalls, 1);
    assert.strictEqual(exitCalls, 0);
  } finally {
    process.exit = originalExit;
  }
});

test('cierres WebSocket y HTTP se inician mientras el drenaje sigue pendiente', async () => {
  const drain = deferred();
  const operations = [];
  const shutdown = createShutdownHandler({
    server: {},
    webSocketServer: {},
    controllers: {
      membership: { stop: () => operations.push('membership') },
      notifications: { stop: () => operations.push('notifications') },
    },
    stopScheduler() {
      operations.push('scheduler');
      return drain.promise;
    },
    closeWebSockets() {
      operations.push('websocket');
      return Promise.resolve({ closed: true, timed_out: false, clients: 0, terminated: 0 });
    },
    closeHttp() {
      operations.push('http');
      return Promise.resolve({ closed: true, timed_out: false, forced: false });
    },
    logger: () => {},
  });

  let finished = false;
  const stopping = shutdown('SIGINT').then((result) => {
    finished = true;
    return result;
  });
  assert.deepStrictEqual(operations, [
    'scheduler',
    'membership',
    'notifications',
    'websocket',
    'http',
  ]);
  assert.strictEqual(finished, false);
  drain.resolve({ stopped: true, drained: false, timed_out: true });
  const result = await stopping;
  assert.strictEqual(result.timed_out, true);
  assert.strictEqual(result.cleanup_drained, false);
});

test('closeWebSocketServer cierra cooperativamente y comparte la operacion', async () => {
  const timers = fakeTimeouts();
  let closeCallback;
  const socket = {
    readyState: WebSocket.OPEN,
    closeCalls: [],
    terminateCalls: 0,
    close(code, reason) {
      this.closeCalls.push([code, reason]);
      this.readyState = WebSocket.CLOSING;
    },
    terminate() {
      this.terminateCalls += 1;
      this.readyState = WebSocket.CLOSED;
    },
  };
  const wss = {
    clients: new Set([socket]),
    closeCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      closeCallback = callback;
    },
  };
  const options = {
    timeoutMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  const first = closeWebSocketServer(wss, options);
  const second = closeWebSocketServer(wss, options);
  assert.strictEqual(first, second);
  assert.strictEqual(wss.closeCalls, 1);
  assert.deepStrictEqual(socket.closeCalls, [[1001, 'Server shutdown']]);
  assert.strictEqual(timers.handles[0].milliseconds, 2000);
  assert.strictEqual(timers.handles[0].unrefCalls, 1);

  socket.readyState = WebSocket.CLOSED;
  closeCallback();
  assert.deepStrictEqual(await first, {
    closed: true,
    timed_out: false,
    clients: 1,
    terminated: 0,
  });
  assert.strictEqual(socket.terminateCalls, 0);
  assert.deepStrictEqual(timers.cleared, [timers.handles[0]]);
});

test('closeWebSocketServer fuerza clientes restantes y tolera sockets defectuosos', async () => {
  const timers = fakeTimeouts();
  const broken = {
    readyState: WebSocket.OPEN,
    close() {
      throw new Error('private close');
    },
    terminate() {
      throw new Error('private terminate');
    },
  };
  const forced = {
    readyState: WebSocket.OPEN,
    closeCalls: 0,
    terminateCalls: 0,
    close() {
      this.closeCalls += 1;
      this.readyState = WebSocket.CLOSING;
    },
    terminate() {
      this.terminateCalls += 1;
      this.readyState = WebSocket.CLOSED;
    },
  };
  const alreadyClosed = {
    readyState: WebSocket.CLOSED,
    closeCalls: 0,
    terminateCalls: 0,
    close() {
      this.closeCalls += 1;
    },
    terminate() {
      this.terminateCalls += 1;
    },
  };
  const wss = {
    clients: new Set([broken, forced, alreadyClosed]),
    close() {},
  };
  const closing = closeWebSocketServer(wss, {
    timeoutMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  timers.fire(timers.handles[0]);
  assert.deepStrictEqual(await closing, {
    closed: false,
    timed_out: true,
    clients: 3,
    terminated: 1,
  });
  assert.strictEqual(forced.closeCalls, 1);
  assert.strictEqual(forced.terminateCalls, 1);
  assert.strictEqual(alreadyClosed.closeCalls, 0);
  assert.strictEqual(alreadyClosed.terminateCalls, 0);
});

test('closeHttpServer resuelve cooperativamente y limpia el timeout', async () => {
  const timers = fakeTimeouts();
  let closeCallback;
  const server = {
    closeCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      closeCallback = callback;
    },
  };
  const closing = closeHttpServer(server, {
    timeoutMs: 5000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  assert.strictEqual(server.closeCalls, 1);
  assert.strictEqual(timers.handles[0].milliseconds, 5000);
  assert.strictEqual(timers.handles[0].unrefCalls, 1);
  closeCallback();
  assert.deepStrictEqual(await closing, {
    closed: true,
    timed_out: false,
    forced: false,
  });
  assert.deepStrictEqual(timers.cleared, [timers.handles[0]]);
});

test('closeHttpServer acota el cierre y usa APIs seguras al vencer', async () => {
  const timers = fakeTimeouts();
  const server = {
    closeCalls: 0,
    idleCalls: 0,
    allCalls: 0,
    close() {
      this.closeCalls += 1;
    },
    closeIdleConnections() {
      this.idleCalls += 1;
    },
    closeAllConnections() {
      this.allCalls += 1;
    },
  };
  const first = closeHttpServer(server, {
    timeoutMs: 5000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const second = closeHttpServer(server);
  assert.strictEqual(first, second);
  timers.fire(timers.handles[0]);
  assert.deepStrictEqual(await first, {
    closed: false,
    timed_out: true,
    forced: true,
  });
  assert.strictEqual(server.closeCalls, 1);
  assert.strictEqual(server.idleCalls, 1);
  assert.strictEqual(server.allCalls, 1);
});
