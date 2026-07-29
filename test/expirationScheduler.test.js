const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire } = require('./helpers/fixtures');
const scheduler = projectRequire('src/screenCamPreviewScheduler.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const handles = [];
  return {
    handles,
    setTimeout(callback, milliseconds) {
      const handle = {
        callback,
        milliseconds,
        cleared: false,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        },
      };
      handles.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cleared = true;
    },
    fire(handle) {
      assert.strictEqual(handle.cleared, false);
      handle.cleared = true;
      handle.callback();
    },
    pending(milliseconds) {
      return handles.filter((handle) => (
        !handle.cleared && handle.milliseconds === milliseconds
      ));
    },
  };
}

test.afterEach(async () => {
  await scheduler.stopPreviewExpirationScheduler({ drain: false });
});

test.after(() => {
  env.cleanup();
});

test('start barre inmediatamente, programa 30000 ms con unref y es idempotente', () => {
  const timers = fakeTimers();
  let sweeps = 0;
  let waits = 0;
  const options = {
    expireStaleSessions: () => {
      sweeps += 1;
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => {
      waits += 1;
      return Promise.resolve();
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  };

  assert.deepStrictEqual(scheduler.startPreviewExpirationScheduler(options), {
    started: true,
    already_running: false,
    interval_ms: 30_000,
  });
  assert.strictEqual(sweeps, 1);
  assert.strictEqual(waits, 0);
  assert.strictEqual(timers.pending(30_000).length, 1);
  assert.strictEqual(timers.pending(30_000)[0].unrefCalls, 1);

  assert.deepStrictEqual(scheduler.startPreviewExpirationScheduler(options), {
    started: true,
    already_running: true,
    interval_ms: 30_000,
  });
  assert.strictEqual(sweeps, 1);
  assert.strictEqual(timers.pending(30_000).length, 1);
});

test('cada callback barre y deja exactamente un siguiente timeout recursivo', () => {
  const timers = fakeTimers();
  let sweeps = 0;
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => {
      sweeps += 1;
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  });

  const first = timers.pending(30_000)[0];
  timers.fire(first);
  assert.strictEqual(sweeps, 2);
  assert.strictEqual(timers.pending(30_000).length, 1);
  const second = timers.pending(30_000)[0];
  assert.notStrictEqual(second, first);
  assert.strictEqual(second.unrefCalls, 1);
  timers.fire(second);
  assert.strictEqual(sweeps, 3);
  assert.strictEqual(timers.handles.filter((handle) => handle.milliseconds === 30_000).length, 3);
});

test('fallos de barrido y logger quedan sanitizados sin detener el scheduler', () => {
  const timers = fakeTimers();
  const logs = [];
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => {
      throw new Error('sqlite path token private');
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: (message) => {
      logs.push(String(message));
      throw new Error('logger unavailable');
    },
  });

  timers.fire(timers.pending(30_000)[0]);
  const state = scheduler.getPreviewExpirationSchedulerState();
  assert.strictEqual(state.running, true);
  assert.strictEqual(state.sweeps_started, 2);
  assert.strictEqual(state.sweeps_failed, 2);
  assert.strictEqual(timers.handles.filter((handle) => handle.milliseconds === 30_000).length, 2);
  assert.deepStrictEqual(logs, [
    '[screencam] operation=preview-expiration-sweep code=sweep_failed',
    '[screencam] operation=preview-expiration-sweep code=sweep_failed',
  ]);
});

test('cero expiraciones no loguea y expiraciones actualizan metricas seguras copiadas', () => {
  const timers = fakeTimers();
  const logs = [];
  const results = [0, 3];
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => ({ expired: results.shift() }),
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: (message) => logs.push(String(message)),
  });
  assert.deepStrictEqual(logs, []);

  timers.fire(timers.pending(30_000)[0]);
  assert.deepStrictEqual(logs, [
    '[screencam] operation=preview-expiration-sweep expired=3',
  ]);
  const state = scheduler.getPreviewExpirationSchedulerState();
  assert.deepStrictEqual(state, {
    running: true,
    interval_ms: 30_000,
    timer_scheduled: true,
    sweep_running: false,
    sweeps_started: 2,
    sweeps_failed: 0,
    sessions_expired: 3,
    timer_failures: 0,
  });
  state.sessions_expired = 999;
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().sessions_expired, 3);
  assert.ok(!JSON.stringify(state).includes('pv_'));
});

test('start durante un barrido no reentra y no espera la cola para programar', () => {
  const timers = fakeTimers();
  let sweeps = 0;
  let waits = 0;
  const options = {
    expireStaleSessions: () => {
      sweeps += 1;
      scheduler.startPreviewExpirationScheduler(options);
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => {
      waits += 1;
      return Promise.resolve();
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  };

  scheduler.startPreviewExpirationScheduler(options);
  assert.strictEqual(sweeps, 1);
  assert.strictEqual(waits, 0);
  assert.strictEqual(timers.pending(30_000).length, 1);
});

test('stop limpia el timeout, es idempotente y permite un start nuevo', async () => {
  const timers = fakeTimers();
  let sweeps = 0;
  const options = {
    expireStaleSessions: () => {
      sweeps += 1;
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  };
  scheduler.startPreviewExpirationScheduler(options);
  const firstTimer = timers.pending(30_000)[0];

  assert.deepStrictEqual(
    await scheduler.stopPreviewExpirationScheduler(),
    { stopped: true, drained: true, timed_out: false },
  );
  assert.strictEqual(firstTimer.cleared, true);
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().running, false);
  assert.deepStrictEqual(
    await scheduler.stopPreviewExpirationScheduler(),
    { stopped: true, drained: true, timed_out: false },
  );

  scheduler.startPreviewExpirationScheduler(options);
  assert.strictEqual(sweeps, 2);
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().sweeps_started, 1);
  assert.strictEqual(timers.pending(30_000).length, 1);
});

test('stop durante callback impide reprogramar el timeout siguiente', async () => {
  const timers = fakeTimers();
  let stopFromSweep;
  let sweeps = 0;
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => {
      sweeps += 1;
      if (sweeps === 2) {
        stopFromSweep = scheduler.stopPreviewExpirationScheduler({ drain: false });
      }
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  });
  const periodic = timers.pending(30_000)[0];

  timers.fire(periodic);
  await stopFromSweep;
  assert.strictEqual(sweeps, 2);
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().running, false);
  assert.strictEqual(timers.handles.filter((handle) => handle.milliseconds === 30_000).length, 1);
});

test('un drenaje anterior que termina tarde no detiene un start nuevo', async () => {
  const oldTimers = fakeTimers();
  const oldCleanup = deferred();
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => ({ expired: 0 }),
    waitForExpirationCleanup: () => oldCleanup.promise,
    setTimeout: oldTimers.setTimeout,
    clearTimeout: oldTimers.clearTimeout,
    logger: () => {},
  });
  const oldStop = scheduler.stopPreviewExpirationScheduler({ drainTimeoutMs: 5_000 });

  const newTimers = fakeTimers();
  let newSweeps = 0;
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => {
      newSweeps += 1;
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: newTimers.setTimeout,
    clearTimeout: newTimers.clearTimeout,
    logger: () => {},
  });
  oldCleanup.resolve();
  assert.deepStrictEqual(await oldStop, {
    stopped: true,
    drained: true,
    timed_out: false,
  });

  assert.strictEqual(newSweeps, 1);
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().running, true);
  assert.strictEqual(newTimers.pending(30_000).length, 1);
});

test('stop espera una cola activa y retorna cuando termina', async () => {
  const timers = fakeTimers();
  const cleanup = deferred();
  let waits = 0;
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => ({ expired: 0 }),
    waitForExpirationCleanup: () => {
      waits += 1;
      return cleanup.promise;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  });

  let resolved = false;
  const stopping = scheduler.stopPreviewExpirationScheduler({
    drain: true,
    drainTimeoutMs: 5_000,
  }).then((result) => {
    resolved = true;
    return result;
  });
  await Promise.resolve();
  assert.strictEqual(waits, 1);
  assert.strictEqual(resolved, false);
  const drainTimer = timers.pending(5_000)[0];
  assert.strictEqual(drainTimer.unrefCalls, 1);

  cleanup.resolve();
  assert.deepStrictEqual(await stopping, {
    stopped: true,
    drained: true,
    timed_out: false,
  });
  assert.strictEqual(drainTimer.cleared, true);
});

test('timeout de drenaje retorna seguro, usa unref y dos stops comparten el drenaje', async () => {
  const timers = fakeTimers();
  const cleanup = deferred();
  let waits = 0;
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => ({ expired: 0 }),
    waitForExpirationCleanup: () => {
      waits += 1;
      return cleanup.promise;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  });

  const first = scheduler.stopPreviewExpirationScheduler({ drainTimeoutMs: 123 });
  const second = scheduler.stopPreviewExpirationScheduler({ drainTimeoutMs: 123 });
  await Promise.resolve();
  assert.strictEqual(waits, 1);
  const drainTimer = timers.pending(123)[0];
  assert.strictEqual(drainTimer.unrefCalls, 1);
  timers.fire(drainTimer);
  assert.deepStrictEqual(await first, {
    stopped: true,
    drained: false,
    timed_out: true,
  });
  assert.deepStrictEqual(await second, {
    stopped: true,
    drained: false,
    timed_out: true,
  });
  cleanup.resolve();
});

test('rechazo del helper de espera queda sanitizado y sin unhandled rejection', async () => {
  const timers = fakeTimers();
  const logs = [];
  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => ({ expired: 0 }),
    waitForExpirationCleanup: () => Promise.reject(new Error('private queue details')),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: (message) => logs.push(String(message)),
  });

  assert.deepStrictEqual(await scheduler.stopPreviewExpirationScheduler(), {
    stopped: true,
    drained: false,
    timed_out: false,
  });
  assert.deepStrictEqual(logs, [
    '[screencam] operation=preview-expiration-drain code=drain_failed',
  ]);
});

test('fallo de setTimeout durante Start deja estado detenido y recuperable', async () => {
  const logs = [];
  let sweeps = 0;
  const failuresBefore = scheduler.getPreviewExpirationSchedulerState().timer_failures;
  const privateError = 'SELECT token=secret at /home/private';

  let result;
  assert.doesNotThrow(() => {
    result = scheduler.startPreviewExpirationScheduler({
      expireStaleSessions: () => {
        sweeps += 1;
        return { expired: 0 };
      },
      waitForExpirationCleanup: () => Promise.resolve(),
      setTimeout() {
        throw new Error(privateError);
      },
      clearTimeout: () => assert.fail('no existe un timer que limpiar'),
      logger: (...args) => logs.push(args),
    });
  });

  assert.deepStrictEqual(result, {
    started: false,
    already_running: false,
    interval_ms: 30_000,
    code: 'timer_failed',
  });
  assert.strictEqual(sweeps, 1, 'el barrido inmediato debe conservarse');
  assert.deepStrictEqual(logs, [[
    '[screencam] operation=preview-expiration-scheduler code=timer_failed',
  ]]);
  assert.ok(!JSON.stringify(logs).includes(privateError));
  assert.deepStrictEqual(scheduler.getPreviewExpirationSchedulerState(), {
    running: false,
    interval_ms: 30_000,
    timer_scheduled: false,
    sweep_running: false,
    sweeps_started: 1,
    sweeps_failed: 0,
    sessions_expired: 0,
    timer_failures: failuresBefore + 1,
  });

  const timers = fakeTimers();
  const recovered = scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => {
      sweeps += 1;
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: () => {},
  });
  assert.deepStrictEqual(recovered, {
    started: true,
    already_running: false,
    interval_ms: 30_000,
  });
  assert.strictEqual(sweeps, 2, 'el reinicio debe ejecutar otro barrido inmediato');
  assert.strictEqual(timers.pending(30_000).length, 1);
  assert.strictEqual(
    scheduler.getPreviewExpirationSchedulerState().timer_failures,
    failuresBefore + 1,
  );

  await scheduler.stopPreviewExpirationScheduler({ drain: false });
  assert.strictEqual(scheduler.getPreviewExpirationSchedulerState().running, false);
  assert.strictEqual(timers.pending(30_000).length, 0);
  assert.strictEqual(
    scheduler.getPreviewExpirationSchedulerState().timer_failures,
    failuresBefore + 1,
  );
});

test('logger defectuoso no rompe la recuperacion tras timer_failed', () => {
  const failuresBefore = scheduler.getPreviewExpirationSchedulerState().timer_failures;
  assert.doesNotThrow(() => {
    const result = scheduler.startPreviewExpirationScheduler({
      expireStaleSessions: () => ({ expired: 0 }),
      waitForExpirationCleanup: () => Promise.resolve(),
      setTimeout() {
        throw new Error('private timer details');
      },
      clearTimeout: () => {},
      logger() {
        throw new Error('private logger details');
      },
    });
    assert.deepStrictEqual(result, {
      started: false,
      already_running: false,
      interval_ms: 30_000,
      code: 'timer_failed',
    });
  });
  const state = scheduler.getPreviewExpirationSchedulerState();
  assert.strictEqual(state.running, false);
  assert.strictEqual(state.timer_scheduled, false);
  assert.strictEqual(state.timer_failures, failuresBefore + 1);
});

test('fallo al reprogramar despues de un sweep no reintenta en bucle', async () => {
  const handles = [];
  const logs = [];
  let scheduleCalls = 0;
  let sweeps = 0;
  const failuresBefore = scheduler.getPreviewExpirationSchedulerState().timer_failures;
  const setTimeoutImpl = (callback, milliseconds) => {
    scheduleCalls += 1;
    if (scheduleCalls === 2) {
      throw new Error('secret periodic timer failure');
    }
    const handle = {
      callback,
      milliseconds,
      cleared: false,
      unref() {},
    };
    handles.push(handle);
    return handle;
  };

  scheduler.startPreviewExpirationScheduler({
    expireStaleSessions: () => {
      sweeps += 1;
      return { expired: 0 };
    },
    waitForExpirationCleanup: () => Promise.resolve(),
    setTimeout: setTimeoutImpl,
    clearTimeout: (handle) => {
      handle.cleared = true;
    },
    logger: (...args) => logs.push(args),
  });

  assert.strictEqual(handles.length, 1);
  handles[0].cleared = true;
  assert.doesNotThrow(() => handles[0].callback());

  const state = scheduler.getPreviewExpirationSchedulerState();
  assert.strictEqual(sweeps, 2, 'el sweep periodico debe terminar');
  assert.strictEqual(state.sweeps_started, 2);
  assert.strictEqual(state.running, false);
  assert.strictEqual(state.timer_scheduled, false);
  assert.strictEqual(state.timer_failures, failuresBefore + 1);
  assert.strictEqual(scheduleCalls, 2, 'no debe existir retry inmediato');
  assert.strictEqual(handles.length, 1, 'no debe quedar otro handle');
  assert.deepStrictEqual(logs, [[
    '[screencam] operation=preview-expiration-scheduler code=timer_failed',
  ]]);

  assert.deepStrictEqual(
    await scheduler.stopPreviewExpirationScheduler({ drain: false }),
    { stopped: true, drained: false, timed_out: false },
  );
  assert.strictEqual(
    scheduler.getPreviewExpirationSchedulerState().timer_failures,
    failuresBefore + 1,
  );
});
