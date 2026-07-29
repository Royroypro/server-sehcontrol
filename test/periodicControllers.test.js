const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire } = require('./helpers/fixtures');
const membershipSync = projectRequire('src/membershipSync.js');
const notifications = projectRequire('src/notifications.js');

function fakeIntervals() {
  const handles = [];
  const cleared = [];
  return {
    handles,
    cleared,
    setInterval(callback, milliseconds) {
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
    clearInterval(handle) {
      cleared.push(handle);
    },
    fire(handle) {
      handle.callback();
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test.after(() => {
  env.cleanup();
});

for (const {
  name,
  start,
  taskOption,
} of [
  {
    name: 'membresia',
    start: membershipSync.startPeriodicSync,
    taskOption: 'syncAll',
  },
  {
    name: 'notificaciones',
    start: notifications.startAlertScheduler,
    taskOption: 'generateExpiryAlerts',
  },
]) {
  test(`${name}: start, unref y stop idempotente controlan el unico intervalo`, () => {
    const timers = fakeIntervals();
    let executions = 0;
    const controller = start(1234, {
      [taskOption]: () => {
        executions += 1;
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      logger: () => {},
    });

    assert.deepStrictEqual(Object.keys(controller), ['stop']);
    assert.strictEqual(JSON.stringify(controller), '{}');
    assert.strictEqual(executions, 1, 'la ejecucion inicial se conserva');
    assert.strictEqual(timers.handles.length, 1);
    assert.strictEqual(timers.handles[0].milliseconds, 1234);
    assert.strictEqual(timers.handles[0].unrefCalls, 1);

    timers.fire(timers.handles[0]);
    assert.strictEqual(executions, 2);
    assert.strictEqual(controller.stop(), true);
    assert.deepStrictEqual(timers.cleared, [timers.handles[0]]);

    timers.fire(timers.handles[0]);
    assert.strictEqual(executions, 2, 'un callback ya encolado no ejecuta trabajo tras stop');
    assert.strictEqual(controller.stop(), false);
    assert.strictEqual(timers.cleared.length, 1, 'clearInterval se invoca exactamente una vez');
  });

  test(`${name}: una ejecucion activa puede terminar sin iniciar otra tras stop`, async () => {
    const timers = fakeIntervals();
    const active = deferred();
    let executions = 0;
    const controller = start(100, {
      [taskOption]: () => {
        executions += 1;
        return active.promise;
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      logger: () => {},
    });

    controller.stop();
    active.resolve();
    await active.promise;
    timers.fire(timers.handles[0]);
    assert.strictEqual(executions, 1);
  });

  test(`${name}: rechazos asincronos quedan manejados sin datos crudos`, async () => {
    const timers = fakeIntervals();
    const logs = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = start(100, {
        [taskOption]: () => Promise.reject(new Error('private-token-in-error')),
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        logger: (message) => logs.push(String(message)),
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      controller.stop();
      assert.deepStrictEqual(unhandled, []);
      assert.ok(logs.every((message) => !message.includes('private-token-in-error')));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
}
