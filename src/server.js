require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocket } = require('ws');

const membershipSync = require('./membershipSync');
const notifications = require('./notifications');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');
const hbbsHttpRoutes = require('./routes/hbbsHttp');
const clientExtensionsRoutes = require('./routes/clientExtensions');
const publicRoutes = require('./routes/public');
const { initWebSocketServer } = require('./ws');
const {
  startPreviewExpirationScheduler,
  stopPreviewExpirationScheduler,
  DEFAULT_DRAIN_TIMEOUT_MS,
} = require('./screenCamPreviewScheduler');

const WEBSOCKET_CLOSE_TIMEOUT_MS = 2_000;
const HTTP_CLOSE_TIMEOUT_MS = 5_000;
const webSocketCloseOperations = new WeakMap();
const httpCloseOperations = new WeakMap();

function safeServerErrorLog(logger, message) {
  try {
    const result = logger(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // La respuesta HTTP no depende de la disponibilidad del logger.
  }
}

function createGlobalErrorHandler(options = {}) {
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (message) => console.error(message);

  return (err, req, res, next) => {
    safeServerErrorLog(
      logger,
      '[server] operation=request-handler code=internal_error',
    );
    res.status(500).json({ error: 'Error interno del servidor' });
  };
}

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/eula', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'eula.html'));
});

app.get('/ayuda', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ayuda.html'));
});

app.get('/mas-informacion', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'mas-informacion.html'));
});

app.get('/actualizar-planes', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'actualizar-planes.html'));
});

app.get('/index', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use('/api/public', publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
// Protocolo nativo del cliente RustDesk: rutas fijas /api/login, /api/currentUser, etc.
app.use('/api', hbbsHttpRoutes);
// Extensiones no estandar para un cliente modificado (ver docs/CLIENT_INTEGRATION.md)
app.use('/api', clientExtensionsRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(createGlobalErrorHandler());

function safeLifecycleLog(logger, message) {
  try {
    const result = logger(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // El ciclo de vida no depende del logger.
  }
}

function safeUnref(handle) {
  try {
    if (handle && typeof handle.unref === 'function') handle.unref();
  } catch (_) {
    // unref evita que el timer prolongue el proceso, pero no define el resultado.
  }
}

function closeWebSocketServer(wss, options = {}) {
  if (!wss || (typeof wss !== 'object' && typeof wss !== 'function')) {
    return Promise.resolve({
      closed: true,
      timed_out: false,
      clients: 0,
      terminated: 0,
    });
  }
  const existing = webSocketCloseOperations.get(wss);
  if (existing) return existing;

  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs : WEBSOCKET_CLOSE_TIMEOUT_MS;
  const setTimeoutImpl = typeof options.setTimeout === 'function'
    ? options.setTimeout : setTimeout;
  const clearTimeoutImpl = typeof options.clearTimeout === 'function'
    ? options.clearTimeout : clearTimeout;
  const clients = (() => {
    try {
      return Array.from(wss.clients || []);
    } catch (_) {
      return [];
    }
  })();

  let closeTimer = null;
  let settled = false;
  let closeRequestFailed = false;
  let operationResolve;
  const operation = new Promise((resolve) => {
    operationResolve = resolve;
  });
  webSocketCloseOperations.set(wss, operation);

  const finish = (summary) => {
    if (settled) return;
    settled = true;
    if (closeTimer !== null) {
      try {
        clearTimeoutImpl(closeTimer);
      } catch (_) {
        // El resultado ya esta decidido y no depende de clearTimeout.
      }
      closeTimer = null;
    }
    operationResolve(summary);
  };

  try {
    wss.close((error) => {
      finish({
        closed: !error,
        timed_out: false,
        clients: clients.length,
        terminated: 0,
      });
    });
  } catch (_) {
    closeRequestFailed = true;
  }

  for (const socket of clients) {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1001, 'Server shutdown');
      }
    } catch (_) {
      // Un cliente defectuoso no impide solicitar el cierre a los demas.
    }
  }

  if (!settled) {
    const forceClose = () => {
      let terminated = 0;
      let remaining = 0;
      for (const socket of clients) {
        try {
          if (socket && socket.readyState !== WebSocket.CLOSED) {
            remaining += 1;
            socket.terminate();
            terminated += 1;
          }
        } catch (_) {
          // Se intentan todos los sockets y solo se informa una cantidad segura.
        }
      }
      finish({
        closed: !closeRequestFailed && remaining === terminated,
        timed_out: true,
        clients: clients.length,
        terminated,
      });
    };
    try {
      closeTimer = setTimeoutImpl(forceClose, timeoutMs);
      safeUnref(closeTimer);
    } catch (_) {
      forceClose();
    }
  }

  return operation;
}

function closeHttpServer(server, options = {}) {
  if (!server || (typeof server !== 'object' && typeof server !== 'function')
    || typeof server.close !== 'function') {
    return Promise.resolve({ closed: false, timed_out: false, forced: false });
  }
  const existing = httpCloseOperations.get(server);
  if (existing) return existing;

  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs : HTTP_CLOSE_TIMEOUT_MS;
  const setTimeoutImpl = typeof options.setTimeout === 'function'
    ? options.setTimeout : setTimeout;
  const clearTimeoutImpl = typeof options.clearTimeout === 'function'
    ? options.clearTimeout : clearTimeout;
  let closeTimer = null;
  let settled = false;
  let operationResolve;
  const operation = new Promise((resolve) => {
    operationResolve = resolve;
  });
  httpCloseOperations.set(server, operation);

  const finish = (summary) => {
    if (settled) return;
    settled = true;
    if (closeTimer !== null) {
      try {
        clearTimeoutImpl(closeTimer);
      } catch (_) {
        // El resultado ya esta decidido y no depende de clearTimeout.
      }
      closeTimer = null;
    }
    operationResolve(summary);
  };

  try {
    server.close((error) => {
      const alreadyClosed = error?.code === 'ERR_SERVER_NOT_RUNNING';
      finish({
        closed: !error || alreadyClosed,
        timed_out: false,
        forced: false,
      });
    });
  } catch (_) {
    finish({ closed: false, timed_out: false, forced: false });
  }

  if (!settled) {
    const forceClose = () => {
      let forced = false;
      try {
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
          forced = true;
        }
      } catch (_) {
        // Se intenta tambien closeAllConnections cuando este disponible.
      }
      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
          forced = true;
        }
      } catch (_) {
        // El timeout siempre resuelve con un resumen sanitario.
      }
      finish({ closed: false, timed_out: true, forced });
    };
    try {
      closeTimer = setTimeoutImpl(forceClose, timeoutMs);
      safeUnref(closeTimer);
    } catch (_) {
      forceClose();
    }
  }

  return operation;
}

function createShutdownHandler({
  server,
  webSocketServer = null,
  controllers = {},
  stopScheduler = stopPreviewExpirationScheduler,
  closeWebSockets = closeWebSocketServer,
  closeHttp = closeHttpServer,
  removeSignalHandlers = () => {},
  logger = (message) => console.log(message),
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  webSocketCloseTimeoutMs = WEBSOCKET_CLOSE_TIMEOUT_MS,
  httpCloseTimeoutMs = HTTP_CLOSE_TIMEOUT_MS,
} = {}) {
  let shutdownPromise = null;
  return function shutdownServer() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let schedulerStop;
      try {
        // La funcion async marca el scheduler detenido y limpia su timer antes
        // de devolver la promesa que espera el drenaje.
        schedulerStop = Promise.resolve(stopScheduler({
          drain: true,
          drainTimeoutMs,
        })).catch(() => {
          safeLifecycleLog(
            logger,
            '[server] operation=shutdown code=scheduler_stop_failed',
          );
          return { stopped: false, drained: false, timed_out: false };
        });
      } catch (_) {
        safeLifecycleLog(logger, '[server] operation=shutdown code=scheduler_stop_failed');
        schedulerStop = Promise.resolve({
          stopped: false,
          drained: false,
          timed_out: false,
        });
      }

      const stopController = (controller, code) => {
        if (!controller) return true;
        try {
          if (typeof controller.stop !== 'function') throw new TypeError('invalid controller');
          controller.stop();
          return true;
        } catch (_) {
          safeLifecycleLog(logger, `[server] operation=shutdown code=${code}`);
          return false;
        }
      };
      const membershipStopped = stopController(
        controllers.membership,
        'membership_stop_failed',
      );
      const notificationsStopped = stopController(
        controllers.notifications,
        'notifications_stop_failed',
      );

      let webSocketClose;
      try {
        webSocketClose = Promise.resolve(closeWebSockets(webSocketServer, {
          timeoutMs: webSocketCloseTimeoutMs,
        })).catch(() => ({
          closed: false,
          timed_out: false,
          clients: 0,
          terminated: 0,
        }));
      } catch (_) {
        webSocketClose = Promise.resolve({
          closed: false,
          timed_out: false,
          clients: 0,
          terminated: 0,
        });
      }

      let httpClose;
      try {
        httpClose = Promise.resolve(closeHttp(server, {
          timeoutMs: httpCloseTimeoutMs,
        })).catch(() => ({ closed: false, timed_out: false, forced: false }));
      } catch (_) {
        httpClose = Promise.resolve({ closed: false, timed_out: false, forced: false });
      }

      const [rawSchedulerResult, rawWebSocketResult, rawHttpResult] = await Promise.all([
        schedulerStop,
        webSocketClose,
        httpClose,
      ]);
      const schedulerResult = rawSchedulerResult && typeof rawSchedulerResult === 'object'
        ? rawSchedulerResult
        : { stopped: false, drained: false, timed_out: false };
      const webSocketResult = rawWebSocketResult && typeof rawWebSocketResult === 'object'
        ? rawWebSocketResult
        : { closed: false, timed_out: false, clients: 0, terminated: 0 };
      const httpResult = rawHttpResult && typeof rawHttpResult === 'object'
        ? rawHttpResult
        : { closed: false, timed_out: false, forced: false };
      if (!httpResult.closed) {
        safeLifecycleLog(logger, '[server] operation=shutdown code=server_close_failed');
      }
      if (!webSocketResult.closed) {
        safeLifecycleLog(logger, '[server] operation=shutdown code=websocket_close_failed');
      }
      const result = {
        shutdown: true,
        server_closed: httpResult.closed === true,
        server_timed_out: httpResult.timed_out === true,
        websocket_closed: webSocketResult.closed === true,
        websocket_timed_out: webSocketResult.timed_out === true,
        websocket_clients: Number.isSafeInteger(webSocketResult.clients)
          ? webSocketResult.clients : 0,
        websocket_terminated: Number.isSafeInteger(webSocketResult.terminated)
          ? webSocketResult.terminated : 0,
        membership_stopped: membershipStopped,
        notifications_stopped: notificationsStopped,
        scheduler_stopped: schedulerResult.stopped === true,
        cleanup_drained: schedulerResult.drained === true,
        timed_out: schedulerResult.timed_out === true
          || webSocketResult.timed_out === true
          || httpResult.timed_out === true,
      };
      try {
        removeSignalHandlers();
      } catch (_) {
        safeLifecycleLog(logger, '[server] operation=shutdown code=signal_cleanup_failed');
      }
      return result;
    })();
    return shutdownPromise;
  };
}

function registerShutdownSignals({
  processObject = process,
  shutdown,
  logger = (message) => console.log(message),
} = {}) {
  if (!processObject
    || typeof processObject.on !== 'function'
    || typeof processObject.removeListener !== 'function'
    || typeof shutdown !== 'function') {
    throw new TypeError('dependencias de shutdown invalidas');
  }
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      try {
        Promise.resolve(shutdown(signal)).catch(() => {
          safeLifecycleLog(logger, '[server] operation=shutdown code=shutdown_failed');
        });
      } catch (_) {
        safeLifecycleLog(logger, '[server] operation=shutdown code=shutdown_failed');
      }
    };
    handlers.set(signal, handler);
    processObject.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      processObject.removeListener(signal, handler);
    }
    handlers.clear();
  };
}

let runtimeLifecycle = null;

function startServer(options = {}) {
  if (runtimeLifecycle) return runtimeLifecycle;
  const port = options.port ?? process.env.PORT ?? 8899;
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const logger = typeof options.logger === 'function'
    ? options.logger : (message) => console.log(message);
  const listen = typeof options.listen === 'function'
    ? options.listen : (callback) => app.listen(port, host, callback);
  const startScheduler = typeof options.startScheduler === 'function'
    ? options.startScheduler : startPreviewExpirationScheduler;
  const stopScheduler = typeof options.stopScheduler === 'function'
    ? options.stopScheduler : stopPreviewExpirationScheduler;
  const initializeWebSocket = typeof options.initWebSocketServer === 'function'
    ? options.initWebSocketServer : initWebSocketServer;
  const processObject = options.processObject || process;
  let servicesStarted = false;
  let allowServicesToStart = true;
  const controllers = {
    membership: null,
    notifications: null,
  };
  let lifecycle = null;

  const server = listen(() => {
    if (servicesStarted || !allowServicesToStart) return;
    servicesStarted = true;
    safeLifecycleLog(logger, `rustdesk-admin-panel escuchando en http://${host}:${port}`);
    try {
      startScheduler();
    } catch (_) {
      safeLifecycleLog(
        logger,
        '[server] operation=preview-expiration-scheduler code=start_failed',
      );
    }
    try {
      controllers.membership = (options.startPeriodicSync || membershipSync.startPeriodicSync)();
    } catch (_) {
      safeLifecycleLog(logger, '[server] operation=membership-sync code=start_failed');
    }
    try {
      controllers.notifications = (
        options.startAlertScheduler || notifications.startAlertScheduler
      )();
    } catch (_) {
      safeLifecycleLog(logger, '[server] operation=notification-scheduler code=start_failed');
    }
    if (lifecycle) {
      lifecycle.membershipController = controllers.membership;
      lifecycle.notificationController = controllers.notifications;
    }
  });
  const webSocketServer = initializeWebSocket(server);
  safeLifecycleLog(
    logger,
    `WebSocket de tiempo real en ws://localhost:${port}/api/ws?token=<access_token>`,
  );

  let removeSignalHandlers = () => {};
  const baseShutdown = createShutdownHandler({
    server,
    webSocketServer,
    controllers,
    stopScheduler,
    closeWebSockets: options.closeWebSocketServer,
    closeHttp: options.closeHttpServer,
    removeSignalHandlers: () => removeSignalHandlers(),
    logger,
    drainTimeoutMs: options.drainTimeoutMs,
    webSocketCloseTimeoutMs: options.webSocketCloseTimeoutMs,
    httpCloseTimeoutMs: options.httpCloseTimeoutMs,
  });
  const shutdown = (signal) => {
    allowServicesToStart = false;
    return baseShutdown(signal);
  };
  removeSignalHandlers = registerShutdownSignals({
    processObject,
    shutdown,
    logger,
  });
  lifecycle = {
    app,
    server,
    httpServer: server,
    wss: webSocketServer,
    webSocketServer,
    controllers,
    membershipController: controllers.membership,
    notificationController: controllers.notifications,
    shutdown,
    removeSignalHandlers: () => removeSignalHandlers(),
  };
  runtimeLifecycle = lifecycle;
  return runtimeLifecycle;
}

if (require.main === module) startServer();

module.exports = {
  app,
  WEBSOCKET_CLOSE_TIMEOUT_MS,
  HTTP_CLOSE_TIMEOUT_MS,
  startServer,
  closeWebSocketServer,
  closeHttpServer,
  createShutdownHandler,
  createGlobalErrorHandler,
  registerShutdownSignals,
};
