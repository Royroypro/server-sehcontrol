const screenCamPreview = require('./screenCamPreview');

const EXPIRATION_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

let running = false;
let timer = null;
let sweepRunning = false;
let sweepsStarted = 0;
let sweepsFailed = 0;
let sessionsExpired = 0;
let timerFailures = 0;
let dependencies = null;
let stopPromise = null;
let lastStopResult = null;

function defaultLogger(message) {
  console.log(message);
}

function safeLog(logger, message) {
  try {
    const result = logger(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // El scheduler y el shutdown no dependen de la disponibilidad del logger.
  }
}

function schedulerDependencies(options = {}) {
  if (!options || typeof options !== 'object') options = {};
  return {
    expireStaleSessions: typeof options.expireStaleSessions === 'function'
      ? options.expireStaleSessions
      : screenCamPreview.expireStaleSessions,
    waitForExpirationCleanup: typeof options.waitForExpirationCleanup === 'function'
      ? options.waitForExpirationCleanup
      : screenCamPreview.waitForExpirationCleanup,
    setTimeout: typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout,
    clearTimeout: typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout,
    logger: typeof options.logger === 'function' ? options.logger : defaultLogger,
  };
}

function safeUnref(handle) {
  try {
    if (handle && typeof handle.unref === 'function') handle.unref();
  } catch (_) {
    // unref es una optimizacion de ciclo de vida, no una condicion de operacion.
  }
}

function getPreviewExpirationSchedulerState() {
  return {
    running,
    interval_ms: EXPIRATION_SWEEP_INTERVAL_MS,
    timer_scheduled: timer !== null,
    sweep_running: sweepRunning,
    sweeps_started: sweepsStarted,
    sweeps_failed: sweepsFailed,
    sessions_expired: sessionsExpired,
    timer_failures: timerFailures,
  };
}

function runProtectedSweep() {
  if (!running || sweepRunning || !dependencies) return false;
  sweepRunning = true;
  sweepsStarted += 1;
  try {
    const result = dependencies.expireStaleSessions();
    const expired = result && Number.isSafeInteger(result.expired) && result.expired >= 0
      ? result.expired : 0;
    sessionsExpired += expired;
    if (expired > 0) {
      safeLog(
        dependencies.logger,
        `[screencam] operation=preview-expiration-sweep expired=${expired}`,
      );
    }
  } catch (_) {
    sweepsFailed += 1;
    safeLog(
      dependencies.logger,
      '[screencam] operation=preview-expiration-sweep code=sweep_failed',
    );
  } finally {
    sweepRunning = false;
  }
  return true;
}

function scheduleNextSweep() {
  if (!running || !dependencies || timer !== null) return 'not_scheduled';
  const instance = dependencies;
  try {
    const scheduledTimer = instance.setTimeout(() => {
      if (timer === scheduledTimer) timer = null;
      if (!running || dependencies !== instance) return;
      runProtectedSweep();
      scheduleNextSweep();
    }, EXPIRATION_SWEEP_INTERVAL_MS);
    timer = scheduledTimer;
    safeUnref(scheduledTimer);
    return 'scheduled';
  } catch (_) {
    timer = null;
    timerFailures += 1;
    running = false;
    safeLog(
      instance.logger,
      '[screencam] operation=preview-expiration-scheduler code=timer_failed',
    );
    return 'timer_failed';
  }
}

function startPreviewExpirationScheduler(options = {}) {
  if (running) {
    return {
      started: true,
      already_running: true,
      interval_ms: EXPIRATION_SWEEP_INTERVAL_MS,
    };
  }

  dependencies = schedulerDependencies(options);
  running = true;
  timer = null;
  sweepRunning = false;
  sweepsStarted = 0;
  sweepsFailed = 0;
  sessionsExpired = 0;
  stopPromise = null;
  lastStopResult = null;

  runProtectedSweep();
  const scheduleResult = scheduleNextSweep();
  if (scheduleResult === 'timer_failed') {
    return {
      started: false,
      already_running: false,
      interval_ms: EXPIRATION_SWEEP_INTERVAL_MS,
      code: 'timer_failed',
    };
  }
  return {
    started: true,
    already_running: false,
    interval_ms: EXPIRATION_SWEEP_INTERVAL_MS,
  };
}

function normalizedDrainTimeout(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_DRAIN_TIMEOUT_MS;
}

async function drainExpirationCleanup(instance, drainTimeoutMs) {
  let drainTimer = null;
  const waitResult = Promise.resolve()
    .then(() => instance.waitForExpirationCleanup())
    .then(
      () => ({ drained: true, timed_out: false }),
      () => {
        safeLog(
          instance.logger,
          '[screencam] operation=preview-expiration-drain code=drain_failed',
        );
        return { drained: false, timed_out: false };
      },
    );
  const timeoutResult = new Promise((resolve) => {
    try {
      drainTimer = instance.setTimeout(
        () => resolve({ drained: false, timed_out: true }),
        drainTimeoutMs,
      );
      safeUnref(drainTimer);
    } catch (_) {
      resolve({ drained: false, timed_out: true });
    }
  });

  const result = await Promise.race([waitResult, timeoutResult]);
  if (drainTimer !== null) {
    try {
      instance.clearTimeout(drainTimer);
    } catch (_) {
      // Un clearTimeout inyectado defectuoso no cambia el resultado del drenaje.
    }
  }
  return result;
}

async function stopPreviewExpirationScheduler(options = {}) {
  if (stopPromise) return stopPromise;
  if (!running && !dependencies) {
    return lastStopResult || { stopped: true, drained: true, timed_out: false };
  }

  const instance = dependencies || schedulerDependencies();
  const shouldDrain = !options || typeof options !== 'object' || options.drain !== false;
  const drainTimeoutMs = normalizedDrainTimeout(options && options.drainTimeoutMs);

  running = false;
  if (timer !== null) {
    try {
      instance.clearTimeout(timer);
    } catch (_) {
      // El estado detenido evita reprogramar aunque el timer no pueda limpiarse.
    }
    timer = null;
  }

  const currentStop = (async () => {
    const drainResult = shouldDrain
      ? await drainExpirationCleanup(instance, drainTimeoutMs)
      : { drained: false, timed_out: false };
    const result = {
      stopped: true,
      drained: drainResult.drained,
      timed_out: drainResult.timed_out,
    };
    if (dependencies === instance && !running) {
      dependencies = null;
      sweepRunning = false;
    }
    lastStopResult = result;
    return result;
  })();
  stopPromise = currentStop;
  currentStop.finally(() => {
    if (stopPromise === currentStop) stopPromise = null;
  }).catch(() => {});
  return currentStop;
}

module.exports = {
  EXPIRATION_SWEEP_INTERVAL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  startPreviewExpirationScheduler,
  stopPreviewExpirationScheduler,
  getPreviewExpirationSchedulerState,
};
