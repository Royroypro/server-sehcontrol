// Expiracion SQLite atomica y limpieza asincrona con concurrencia acotada.
const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const {
  projectRequire,
  seedActiveDevice,
  forceSessionColumns,
  getSessionRow,
} = require('./helpers/fixtures');
const { installWsMock } = require('./helpers/wsMock');

const db = projectRequire('src/db/adminDb.js');
const preview = projectRequire('src/screenCamPreview.js');
const wsMock = installWsMock();

test.after(async () => {
  await preview.waitForExpirationCleanup();
  wsMock.restore();
  env.cleanup();
});

function createSession(rustdeskId) {
  const owner = seedActiveDevice({ rustdeskId });
  const session = preview.startPreview(rustdeskId, owner.userId);
  return { ...owner, session, row: () => getSessionRow(session.session_id) };
}

function setRelativeCreatedAt(sessionId, secondsAgo) {
  db.prepare(`
    update screen_cam_preview_sessions
    set created_at = datetime('now', ?)
    where id = ?
  `).run(`-${secondsAgo} seconds`, sessionId);
}

function harness(overrides = {}) {
  const kicks = [];
  const pushes = [];
  const logs = [];
  return {
    kicks,
    pushes,
    logs,
    options: {
      kickSrtPublishersForPath: overrides.kick || (async (sessionId) => {
        kicks.push(sessionId);
        return { status: 'not_found', matched: 0, kicked: 0 };
      }),
      pushToUser: overrides.push || ((ownerUserId, payload) => {
        pushes.push({ ownerUserId, payload });
        return 1;
      }),
      logger: overrides.logger || ((message) => logs.push(String(message))),
    },
  };
}

function cleanupTasks(prefix, count) {
  return Array.from({ length: count }, (_value, index) => ({
    id: `pv_${prefix}_${String(index).padStart(4, '0')}`,
    rustdesk_id: `DEV_${prefix}_${index}`,
    cause: 'ttl',
  }));
}

test('estadisticas iniciales son seguras, independientes y con concurrencia dos', async () => {
  const stats = preview.getExpirationCleanupStats();
  assert.deepStrictEqual(stats, {
    pending: 0,
    active: 0,
    tracked: 0,
    concurrency: 2,
    oldest_pending_ms: 0,
    high_watermark: 0,
    completed: 0,
    abandoned: 0,
  });
  stats.pending = 999;
  assert.strictEqual(preview.getExpirationCleanupStats().pending, 0);
  await preview.waitForExpirationCleanup();
});

test('TTL total expira waiting_client, publishing y ready y conserva 300 segundos', async () => {
  assert.strictEqual(preview.SESSION_TTL_SECONDS, 300);
  const rows = [
    createSession('DEV_EXP_TTL_WAITING'),
    createSession('DEV_EXP_TTL_PUBLISHING'),
    createSession('DEV_EXP_TTL_READY'),
  ];
  forceSessionColumns(rows[1].session.session_id, { status: 'publishing' });
  forceSessionColumns(rows[2].session.session_id, {
    status: 'ready',
    playback_url: 'http://127.0.0.1/media/private-token',
  });
  for (const ctx of rows) {
    forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  }
  const h = harness();

  const result = preview.expireStaleSessions(h.options);

  assert.strictEqual(result.expired, 3);
  assert.deepStrictEqual(Object.keys(result), ['expired']);
  for (const ctx of rows) {
    assert.strictEqual(ctx.row().status, 'expired');
    assert.strictEqual(ctx.row().playback_url, null);
  }
  await preview.waitForExpirationCleanup();
  assert.deepStrictEqual(new Set(h.kicks), new Set(rows.map((ctx) => ctx.session.session_id)));
  assert.ok(h.logs.every((line) => line.includes('cause=ttl')));
});

test('espera inicial de 120s expira creating y waiting_client con causa diferenciada', async () => {
  const creating = createSession('DEV_EXP_INITIAL_CREATING');
  const waiting = createSession('DEV_EXP_INITIAL_WAITING');
  forceSessionColumns(creating.session.session_id, { status: 'creating' });
  setRelativeCreatedAt(creating.session.session_id, 121);
  setRelativeCreatedAt(waiting.session.session_id, 121);
  const h = harness();

  const result = preview.expireStaleSessions(h.options);

  assert.strictEqual(result.expired, 2);
  assert.strictEqual(creating.row().status, 'expired');
  assert.strictEqual(waiting.row().status, 'expired');
  await preview.waitForExpirationCleanup();
  assert.ok(h.logs.every((line) => line.includes('cause=initial_wait')));
});

test('119s no expira y publishing/ready ignoran la espera inicial aun con mas de 120s', () => {
  const waiting = createSession('DEV_EXP_119_WAITING');
  const publishing = createSession('DEV_EXP_OLD_PUBLISHING');
  const ready = createSession('DEV_EXP_OLD_READY');
  setRelativeCreatedAt(waiting.session.session_id, 119);
  setRelativeCreatedAt(publishing.session.session_id, 121);
  setRelativeCreatedAt(ready.session.session_id, 121);
  forceSessionColumns(publishing.session.session_id, { status: 'publishing' });
  forceSessionColumns(ready.session.session_id, { status: 'ready' });
  const h = harness();

  const result = preview.expireStaleSessions(h.options);

  assert.strictEqual(result.expired, 0);
  assert.strictEqual(waiting.row().status, 'waiting_client');
  assert.strictEqual(publishing.row().status, 'publishing');
  assert.strictEqual(ready.row().status, 'ready');
  assert.deepStrictEqual(h.kicks, []);
  assert.deepStrictEqual(h.pushes, []);
  // Evita que la fila de 119s cruce el umbral durante pruebas posteriores
  // que comparten esta base temporal.
  forceSessionColumns(waiting.session.session_id, { status: 'stopped' });
});

test('stopped, failed y expired no se modifican ni generan limpieza', () => {
  const terminalRows = ['stopped', 'failed', 'expired'].map((status) => {
    const ctx = createSession(`DEV_EXP_TERMINAL_${status.toUpperCase()}`);
    forceSessionColumns(ctx.session.session_id, {
      status,
      error: status === 'failed' ? 'first_failure' : null,
      ended_at: '2025-01-02 03:04:05',
      expires_at: '2000-01-01 00:00:00',
    });
    return { ctx, before: ctx.row() };
  });
  const h = harness();

  const result = preview.expireStaleSessions(h.options);

  assert.strictEqual(result.expired, 0);
  for (const { ctx, before } of terminalRows) assert.deepStrictEqual(ctx.row(), before);
  assert.deepStrictEqual(h.kicks, []);
  assert.deepStrictEqual(h.pushes, []);
});

test('expiracion limpia playback_url y conserva ended_at y error existentes', async () => {
  const ctx = createSession('DEV_EXP_FIELDS');
  forceSessionColumns(ctx.session.session_id, {
    status: 'ready',
    expires_at: '2000-01-01 00:00:00',
    ended_at: '2025-01-02 03:04:05',
    playback_url: 'http://127.0.0.1/media/private-token',
    error: 'first_error',
  });
  const h = harness();

  preview.expireStaleSessions(h.options);

  assert.strictEqual(ctx.row().status, 'expired');
  assert.strictEqual(ctx.row().playback_url, null);
  assert.strictEqual(ctx.row().ended_at, '2025-01-02 03:04:05');
  assert.strictEqual(ctx.row().error, 'first_error');
  await preview.waitForExpirationCleanup();
});

test('cada fila se devuelve una vez y una segunda llamada no duplica kick ni Stop', async () => {
  const ctx = createSession('DEV_EXP_ONCE');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  const h = harness();

  const first = preview.expireStaleSessions(h.options);
  const second = preview.expireStaleSessions(h.options);

  assert.strictEqual(first.expired, 1);
  assert.deepStrictEqual(Object.keys(first), ['expired']);
  assert.strictEqual(second.expired, 0);
  await preview.waitForExpirationCleanup();
  assert.deepStrictEqual(h.kicks, [ctx.session.session_id]);
  assert.strictEqual(h.pushes.length, 1);
});

test('expireStaleSessions es sincrona, no espera red y rechaza handshakes antes del kick', async () => {
  const ctx = createSession('DEV_EXP_NONBLOCKING');
  const raw = ctx.row();
  forceSessionColumns(ctx.session.session_id, {
    status: 'ready',
    expires_at: '2000-01-01 00:00:00',
  });
  let releaseKick;
  const kicks = [];
  const h = harness({
    kick: (sessionId) => {
      kicks.push(sessionId);
      assert.strictEqual(ctx.row().status, 'expired');
      return new Promise((resolve) => {
        releaseKick = () => resolve({ status: 'kicked', matched: 1, kicked: 1 });
      });
    },
  });

  const result = preview.expireStaleSessions(h.options);

  assert.ok(!(result instanceof Promise));
  assert.strictEqual(result.expired, 1);
  assert.deepStrictEqual(kicks, [], 'la red empieza en una microtarea posterior');
  assert.strictEqual(ctx.row().status, 'expired');
  assert.strictEqual(preview.authorizeMedia({
    action: 'publish', path: ctx.session.session_id, token: raw.publish_token,
  }), false);
  assert.strictEqual(preview.authorizeMedia({
    action: 'read', path: ctx.session.session_id, token: raw.read_token,
  }), false);
  await Promise.resolve();
  assert.deepStrictEqual(kicks, [ctx.session.session_id]);
  releaseKick();
  await preview.waitForExpirationCleanup();
});

test('pool inicia dos tareas FIFO y no inicia la tercera hasta liberar un slot', async () => {
  const first = createSession('DEV_EXP_QUEUE_FIRST');
  const second = createSession('DEV_EXP_QUEUE_SECOND');
  const third = createSession('DEV_EXP_QUEUE_THIRD');
  for (const ctx of [first, second, third]) {
    forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  }
  const releases = new Map();
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const finishes = [];
  let markThirdStarted;
  const thirdStarted = new Promise((resolve) => {
    markThirdStarted = resolve;
  });
  const h = harness({
    kick: async (sessionId) => {
      starts.push(sessionId);
      if (sessionId === third.session.session_id) markThirdStarted();
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (sessionId !== third.session.session_id) {
        await new Promise((resolve) => {
          releases.set(sessionId, resolve);
        });
      }
      active -= 1;
      finishes.push(sessionId);
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
  });

  const result = preview.expireStaleSessions(h.options);
  await Promise.resolve();
  assert.deepStrictEqual(starts, [
    first.session.session_id,
    second.session.session_id,
  ]);
  assert.strictEqual(preview.getExpirationCleanupStats().active, 2);
  let waiterResolved = false;
  const waiter = preview.waitForExpirationCleanup().then(() => {
    waiterResolved = true;
  });

  releases.get(second.session.session_id)();
  await thirdStarted;
  assert.deepStrictEqual(starts, [
    first.session.session_id,
    second.session.session_id,
    third.session.session_id,
  ]);
  assert.strictEqual(waiterResolved, false, 'el primer slot libre no resuelve el waiter');
  releases.get(first.session.session_id)();
  await waiter;

  assert.strictEqual(result.expired, 3);
  assert.strictEqual(maxActive, 2);
  assert.deepStrictEqual(finishes, [
    second.session.session_id,
    third.session.session_id,
    first.session.session_id,
  ]);
  assert.deepStrictEqual(preview.getExpirationCleanupStats().active, 0);
});

test('tareas nuevas se anexan con ambos workers activos y el pool reinicia tras vaciarse', async () => {
  const [first, second, third, fourth, fifth] = cleanupTasks('POOL_APPEND', 5);
  const blocked = new Set([first.id, second.id]);
  const releases = new Map();
  const starts = [];
  let active = 0;
  let maxActive = 0;
  const options = {
    kickSrtPublishersForPath: async (sessionId) => {
      starts.push(sessionId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (blocked.has(sessionId)) {
        await new Promise((resolve) => releases.set(sessionId, resolve));
      }
      active -= 1;
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
    findOwnerByRustdeskId: () => null,
    pushToUser: () => 1,
    logger: () => {},
  };

  preview.enqueueExpirationCleanupForTests([first, second], options);
  await Promise.resolve();
  assert.deepStrictEqual(starts, [first.id, second.id]);
  assert.strictEqual(preview.getExpirationCleanupStats().active, 2);

  let waiterResolved = false;
  const waiter = preview.waitForExpirationCleanup().then(() => {
    waiterResolved = true;
  });
  preview.enqueueExpirationCleanupForTests([third, fourth], options);
  assert.strictEqual(preview.getExpirationCleanupStats().pending, 2);
  assert.strictEqual(waiterResolved, false);
  releases.get(first.id)();
  releases.get(second.id)();
  await waiter;

  assert.deepStrictEqual(starts, [first.id, second.id, third.id, fourth.id]);
  assert.strictEqual(maxActive, 2);
  const drainedStats = preview.getExpirationCleanupStats();
  assert.strictEqual(drainedStats.pending, 0);
  assert.strictEqual(drainedStats.active, 0);
  assert.strictEqual(drainedStats.tracked, 0);
  assert.strictEqual(drainedStats.oldest_pending_ms, 0);

  preview.enqueueExpirationCleanupForTests([fifth], options);
  await preview.waitForExpirationCleanup();
  assert.deepStrictEqual(starts, [first.id, second.id, third.id, fourth.id, fifth.id]);
  assert.strictEqual(preview.getExpirationCleanupStats().active, 0);
});

test('kick failed, not_found o excepcion siguen emitiendo Stop y no cortan la cola', async () => {
  const rows = [
    createSession('DEV_EXP_KICK_FAILED'),
    createSession('DEV_EXP_KICK_THROW'),
    createSession('DEV_EXP_KICK_NOT_FOUND'),
  ];
  for (const ctx of rows) {
    forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  }
  const calls = [];
  const h = harness({
    kick: async (sessionId) => {
      calls.push(sessionId);
      if (sessionId === rows[0].session.session_id) {
        return { status: 'failed', matched: 1, kicked: 0, error: 'timeout' };
      }
      if (sessionId === rows[1].session.session_id
        && calls.filter((id) => id === sessionId).length === 1) {
        throw new Error('raw secret');
      }
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
  });

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  assert.strictEqual(calls.length, 4);
  assert.strictEqual(calls.filter((id) => id === rows[0].session.session_id).length, 1);
  assert.strictEqual(calls.filter((id) => id === rows[1].session.session_id).length, 2);
  assert.strictEqual(calls.filter((id) => id === rows[2].session.session_id).length, 1);
  assert.strictEqual(h.pushes.length, 3);
  assert.ok(h.logs.some((line) => line.includes('kick=failed')));
  assert.ok(h.logs.some((line) => line.includes('kick=not_found')));
});

test('Stop ocurre despues del kick, usa type+data y no filtra campos internos', async () => {
  const ctx = createSession('DEV_EXP_STOP_PAYLOAD');
  const raw = ctx.row();
  forceSessionColumns(ctx.session.session_id, {
    status: 'ready',
    expires_at: '2000-01-01 00:00:00',
    playback_url: 'http://127.0.0.1/media/private-token',
  });
  const order = [];
  const pushes = [];
  const h = harness({
    kick: async () => {
      order.push('kick');
      assert.strictEqual(ctx.row().status, 'expired');
      return { status: 'kicked', matched: 1, kicked: 1 };
    },
    push: (ownerUserId, payload) => {
      order.push('stop');
      pushes.push({ ownerUserId, payload });
      assert.strictEqual(ctx.row().status, 'expired');
      return 1;
    },
  });

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  assert.deepStrictEqual(order, ['kick', 'stop']);
  assert.deepStrictEqual(pushes, [{
    ownerUserId: ctx.userId,
    payload: {
      type: 'screen_cam.preview.stop',
      data: {
        session_id: ctx.session.session_id,
        rustdesk_id: ctx.rustdeskId,
      },
    },
  }]);
  const serialized = JSON.stringify(pushes[0].payload);
  for (const secret of [
    raw.publish_token, raw.read_token, 'playback_url', 'query', 'initial_wait',
  ]) {
    assert.ok(!serialized.includes(secret));
  }
});

test('fallo de WebSocket no corta la cola y dispositivo eliminado conserva el kick', async () => {
  const failingPush = createSession('DEV_EXP_PUSH_FAIL');
  const following = createSession('DEV_EXP_PUSH_NEXT');
  const deleted = createSession('DEV_EXP_DEVICE_DELETED');
  for (const ctx of [failingPush, following, deleted]) {
    forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  }
  db.prepare('delete from devices where rustdesk_id = ?').run(deleted.rustdeskId);
  const kicked = [];
  const pushedDevices = [];
  const pushAttempts = new Map();
  const h = harness({
    kick: async (sessionId) => {
      kicked.push(sessionId);
      return { status: 'kicked', matched: 1, kicked: 1 };
    },
    push: (ownerUserId, payload) => {
      pushAttempts.set(
        payload.data.session_id,
        (pushAttempts.get(payload.data.session_id) || 0) + 1,
      );
      if (payload.data.session_id === failingPush.session.session_id) {
        throw new Error('socket secret');
      }
      pushedDevices.push(payload.data.rustdesk_id);
      return 1;
    },
  });

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  assert.strictEqual(kicked.length, 3);
  assert.strictEqual(
    kicked.filter((id) => id === failingPush.session.session_id).length,
    1,
  );
  assert.strictEqual(pushAttempts.get(failingPush.session.session_id), 3);
  assert.ok(kicked.includes(deleted.session.session_id));
  assert.deepStrictEqual(pushedDevices, [following.rustdeskId]);
  assert.ok(h.logs.some((line) => (
    line.includes('cleanup_abandoned=1')
      && line.includes('attempts=3')
      && line.includes('code=websocket_error')
  )));
});

test('logging de expiracion queda limitado a datos sanitarios', async () => {
  const ctx = createSession('DEV_EXP_LOG_SECRET_DEVICE');
  const raw = ctx.row();
  forceSessionColumns(ctx.session.session_id, {
    expires_at: '2000-01-01 00:00:00',
    playback_url: 'http://private.invalid/whep?token=read-secret',
  });
  const h = harness({
    kick: async () => ({
      status: 'failed',
      matched: 1,
      kicked: 0,
      error: 'raw token=https://private.invalid stack',
    }),
  });

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  assert.strictEqual(h.logs.length, 1);
  const line = h.logs[0];
  assert.ok(line.includes('operation=expiration-cleanup'));
  assert.ok(line.includes('cause=ttl'));
  assert.ok(line.includes('kick=failed'));
  assert.ok(line.includes('code=unexpected'));
  for (const secret of [
    ctx.session.session_id,
    ctx.rustdeskId,
    raw.publish_token,
    raw.read_token,
    'private.invalid',
    'token=',
    'stack',
    'playback_url',
    'streamid',
    'remoteAddr',
  ]) {
    assert.ok(!line.includes(secret));
  }
});

test('commit no resuelve dependencias y un fallo de resolucion abandona tras tres intentos', async () => {
  const ctx = createSession('DEV_EXP_DEPENDENCY_RETRY');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  const logs = [];
  let dependencyReads = 0;
  const options = new Proxy({}, {
    get(_target, property) {
      if (property === 'kickSrtPublishersForPath') {
        dependencyReads += 1;
        throw new Error('raw dependency secret');
      }
      if (property === 'logger') return (message) => logs.push(String(message));
      return undefined;
    },
  });

  const result = preview.expireStaleSessions(options);

  assert.deepStrictEqual(result, { expired: 1 });
  assert.strictEqual(ctx.row().status, 'expired');
  assert.strictEqual(dependencyReads, 0, 'el retorno sucede antes de leer dependencias');
  await preview.waitForExpirationCleanup();

  assert.strictEqual(dependencyReads, preview.MAX_CLEANUP_ATTEMPTS);
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].includes('cleanup_abandoned=1'));
  assert.ok(logs[0].includes('attempts=3'));
  assert.ok(logs[0].includes('code=dependency_error'));
  assert.ok(!logs[0].includes(ctx.session.session_id));
  assert.ok(!logs[0].includes('raw dependency secret'));
});

test('B y C avanzan antes del retry de A sin ejecutar A en dos workers', async () => {
  const first = createSession('DEV_EXP_RETRY_ORDER_FIRST');
  const second = createSession('DEV_EXP_RETRY_ORDER_SECOND');
  const third = createSession('DEV_EXP_RETRY_ORDER_THIRD');
  for (const ctx of [first, second, third]) {
    forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  }
  const calls = [];
  const activeIds = new Set();
  let active = 0;
  let maxActive = 0;
  let firstAttempts = 0;
  let h;
  h = harness({
    kick: async (sessionId) => {
      calls.push(sessionId);
      assert.strictEqual(activeIds.has(sessionId), false);
      activeIds.add(sessionId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      if (sessionId === first.session.session_id && firstAttempts++ === 0) {
        preview.enqueueExpirationCleanupForTests([{
          id: first.session.session_id,
          rustdesk_id: first.rustdeskId,
          cause: 'ttl',
        }], h.options);
        active -= 1;
        activeIds.delete(sessionId);
        throw new Error('first attempt');
      }
      active -= 1;
      activeIds.delete(sessionId);
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
  });

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  assert.deepStrictEqual(calls, [
    first.session.session_id,
    second.session.session_id,
    third.session.session_id,
    first.session.session_id,
  ]);
  assert.strictEqual(maxActive, 2);
  assert.strictEqual(h.pushes.length, 3);
});

test('abandono libera el ID y el helper puede encolar nuevamente la misma sesion', async () => {
  const ctx = createSession('DEV_EXP_RETRY_RELEASE_ID');
  const logs = [];
  let failedCalls = 0;
  const statsBefore = preview.getExpirationCleanupStats();
  preview.enqueueExpirationCleanupForTests([{
    id: ctx.session.session_id,
    rustdesk_id: ctx.rustdeskId,
    cause: 'ttl',
  }], {
    kickSrtPublishersForPath: async () => {
      failedCalls += 1;
      throw new Error('infrastructure failure');
    },
    pushToUser: () => 1,
    logger: (message) => logs.push(String(message)),
  });
  await preview.waitForExpirationCleanup();

  assert.strictEqual(failedCalls, preview.MAX_CLEANUP_ATTEMPTS);
  assert.ok(logs.some((line) => line.includes('cleanup_abandoned=1')));
  let stats = preview.getExpirationCleanupStats();
  assert.strictEqual(stats.abandoned, statsBefore.abandoned + 1);
  assert.strictEqual(stats.pending, 0);
  assert.strictEqual(stats.active, 0);
  assert.strictEqual(stats.tracked, 0);

  let recoveredCalls = 0;
  preview.enqueueExpirationCleanupForTests([{
    id: ctx.session.session_id,
    rustdesk_id: ctx.rustdeskId,
    cause: 'ttl',
  }], {
    kickSrtPublishersForPath: async () => {
      recoveredCalls += 1;
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
    pushToUser: () => 1,
    logger: () => {},
  });
  await preview.waitForExpirationCleanup();
  assert.strictEqual(recoveredCalls, 1);
  stats = preview.getExpirationCleanupStats();
  assert.strictEqual(stats.completed, statsBefore.completed + 1);
  assert.strictEqual(stats.abandoned, statsBefore.abandoned + 1);
});

test('dos tareas con el mismo ID producen un solo cleanup', async () => {
  const [task] = cleanupTasks('DUPLICATE_ID', 1);
  let calls = 0;
  const options = {
    kickSrtPublishersForPath: async () => {
      calls += 1;
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
    findOwnerByRustdeskId: () => null,
    pushToUser: () => 1,
    logger: () => {},
  };

  preview.enqueueExpirationCleanupForTests([task, { ...task }], options);
  await preview.waitForExpirationCleanup();

  assert.strictEqual(calls, 1);
});

test('estadisticas reflejan pending, active, edad, maximo y completados con reloj controlado', async () => {
  const tasks = cleanupTasks('METRICS_PRIVATE_TOKEN', 3);
  const before = preview.getExpirationCleanupStats();
  const releases = new Map();
  let now = 100;
  const restoreClock = preview.setExpirationCleanupClockForTests(() => now);
  try {
    preview.enqueueExpirationCleanupForTests(tasks, {
      kickSrtPublishersForPath: async (sessionId) => {
        if (sessionId !== tasks[2].id) {
          await new Promise((resolve) => releases.set(sessionId, resolve));
        }
        return { status: 'not_found', matched: 0, kicked: 0 };
      },
      findOwnerByRustdeskId: () => null,
      pushToUser: () => 1,
      logger: () => {},
    });

    let stats = preview.getExpirationCleanupStats();
    assert.strictEqual(stats.pending, 3);
    assert.strictEqual(stats.active, 0);
    assert.strictEqual(stats.tracked, 3);
    assert.strictEqual(stats.oldest_pending_ms, 0);
    assert.ok(stats.high_watermark >= Math.max(before.high_watermark, 3));

    now = 175;
    stats = preview.getExpirationCleanupStats();
    assert.strictEqual(stats.oldest_pending_ms, 75);
    await Promise.resolve();
    stats = preview.getExpirationCleanupStats();
    assert.strictEqual(stats.pending, 1);
    assert.strictEqual(stats.active, 2);
    assert.strictEqual(stats.tracked, 3);
    assert.strictEqual(stats.oldest_pending_ms, 75);

    releases.get(tasks[0].id)();
    releases.get(tasks[1].id)();
    await preview.waitForExpirationCleanup();
    stats = preview.getExpirationCleanupStats();
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.active, 0);
    assert.strictEqual(stats.tracked, 0);
    assert.strictEqual(stats.oldest_pending_ms, 0);
    assert.strictEqual(stats.completed, before.completed + 3);
    assert.ok(stats.high_watermark >= Math.max(before.high_watermark, 3));
    const serialized = JSON.stringify(stats);
    for (const forbidden of ['pv_', 'DEV_', 'token', 'url', 'cause', 'error', 'task']) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()));
    }
  } finally {
    restoreClock();
  }
});

test('backlog advierte solo al cruzar 25 y 100, se rearma y tolera logger fallido', async () => {
  const scheduled = [];
  const logs = [];
  const restoreScheduler = preview.setExpirationCleanupMicrotaskForTests((callback) => {
    scheduled.push(callback);
  });
  const options = {
    kickSrtPublishersForPath: async () => (
      { status: 'not_found', matched: 0, kicked: 0 }
    ),
    findOwnerByRustdeskId: () => null,
    pushToUser: () => 1,
    logger: (message) => {
      const line = String(message);
      if (line.includes('operation=expiration-cleanup-backlog')) logs.push(line);
    },
  };
  const runScheduledPool = async () => {
    assert.strictEqual(scheduled.length, 1);
    scheduled.shift()();
    await preview.waitForExpirationCleanup();
  };
  try {
    preview.enqueueExpirationCleanupForTests(cleanupTasks('WARN_24_SECRET', 24), options);
    assert.strictEqual(logs.length, 0);
    await runScheduledPool();
    assert.strictEqual(logs.length, 0);

    preview.enqueueExpirationCleanupForTests(cleanupTasks('WARN_27_SECRET', 27), options);
    assert.strictEqual(logs.length, 0, 'el log se difiere fuera del enqueue sincrono');
    await runScheduledPool();
    assert.strictEqual(logs.filter((line) => line.includes('level=warning')).length, 1);
    assert.strictEqual(logs.filter((line) => line.includes('level=critical')).length, 0);

    preview.enqueueExpirationCleanupForTests(cleanupTasks('CRITICAL_FIRST_SECRET', 101), options);
    await runScheduledPool();
    assert.strictEqual(logs.filter((line) => line.includes('level=warning')).length, 2);
    assert.strictEqual(logs.filter((line) => line.includes('level=critical')).length, 1);

    preview.enqueueExpirationCleanupForTests(cleanupTasks('CRITICAL_SECOND_SECRET', 101), options);
    await runScheduledPool();
    assert.strictEqual(logs.filter((line) => line.includes('level=warning')).length, 3);
    assert.strictEqual(logs.filter((line) => line.includes('level=critical')).length, 2);

    for (const line of logs) {
      assert.match(
        line,
        /^\[screencam\] operation=expiration-cleanup-backlog level=(warning|critical) pending=\d+ active=\d+ high_watermark=\d+ oldest_pending_ms=\d+$/,
      );
      for (const forbidden of [
        'WARN_', 'CRITICAL_', 'DEV_', 'token=', '/whep', 'http:', 'https:', 'query', 'path',
      ]) {
        assert.ok(!line.includes(forbidden));
      }
    }

    const completedBeforeThrowingLogger = preview.getExpirationCleanupStats().completed;
    preview.enqueueExpirationCleanupForTests(cleanupTasks('LOGGER_THROW_SECRET', 25), {
      ...options,
      logger: () => {
        throw new Error('private logger failure');
      },
    });
    await runScheduledPool();
    assert.strictEqual(
      preview.getExpirationCleanupStats().completed,
      completedBeforeThrowingLogger + 25,
    );
  } finally {
    restoreScheduler();
  }
});

test('fallo posterior al kick reintenta solo propietario y Stop', async () => {
  const ctx = createSession('DEV_EXP_PARTIAL_OWNER');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  let kicks = 0;
  let ownerLookups = 0;
  let stops = 0;
  const h = harness({
    kick: async () => {
      kicks += 1;
      return { status: 'kicked', matched: 1, kicked: 1 };
    },
  });
  h.options.findOwnerByRustdeskId = () => {
    ownerLookups += 1;
    if (ownerLookups === 1) throw new Error('database temporarily unavailable');
    return { owner_user_id: ctx.userId };
  };
  h.options.pushToUser = () => {
    stops += 1;
    return 1;
  };

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  assert.strictEqual(kicks, 1);
  assert.strictEqual(ownerLookups, 2);
  assert.strictEqual(stops, 1);
});

test('Stop emitido no se duplica aunque el logger falle', async () => {
  const ctx = createSession('DEV_EXP_STOP_ONCE_LOGGER_FAIL');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  let kicks = 0;
  let stops = 0;

  preview.expireStaleSessions({
    kickSrtPublishersForPath: async () => {
      kicks += 1;
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
    pushToUser: () => {
      stops += 1;
      return 1;
    },
    logger: () => {
      throw new Error('logger failure');
    },
  });
  await preview.waitForExpirationCleanup();

  assert.strictEqual(kicks, 1);
  assert.strictEqual(stops, 1);
});

test('failed, not_found, sin dispositivo y WebSocket sin sockets no generan retry', async () => {
  const failed = createSession('DEV_EXP_CONTROLLED_FAILED');
  const notFound = createSession('DEV_EXP_CONTROLLED_NOT_FOUND');
  const deleted = createSession('DEV_EXP_CONTROLLED_DELETED');
  const noSockets = createSession('DEV_EXP_CONTROLLED_NO_SOCKETS');
  for (const ctx of [failed, notFound, deleted, noSockets]) {
    forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  }
  db.prepare('delete from devices where rustdesk_id = ?').run(deleted.rustdeskId);
  const calls = new Map();
  const pushes = new Map();
  const h = harness({
    kick: async (sessionId) => {
      calls.set(sessionId, (calls.get(sessionId) || 0) + 1);
      if (sessionId === failed.session.session_id) {
        return { status: 'failed', matched: 0, kicked: 0, error: 'timeout' };
      }
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
    push: (_ownerUserId, payload) => {
      const id = payload.data.session_id;
      pushes.set(id, (pushes.get(id) || 0) + 1);
      return id === noSockets.session.session_id ? 0 : 1;
    },
  });

  preview.expireStaleSessions(h.options);
  await preview.waitForExpirationCleanup();

  for (const ctx of [failed, notFound, deleted, noSockets]) {
    assert.strictEqual(calls.get(ctx.session.session_id), 1);
  }
  assert.strictEqual(pushes.has(deleted.session.session_id), false);
  assert.strictEqual(pushes.get(noSockets.session.session_id), 1);
});

test('queueMicrotask fallida conserva la tarea y una llamada posterior reinicia el worker', async () => {
  const ctx = createSession('DEV_EXP_MICROTASK_RESTART');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  let schedules = 0;
  let kicks = 0;
  const restore = preview.setExpirationCleanupMicrotaskForTests(() => {
    schedules += 1;
    throw new Error('scheduler unavailable');
  });
  try {
    const result = preview.expireStaleSessions({
      kickSrtPublishersForPath: async () => {
        kicks += 1;
        return { status: 'not_found', matched: 0, kicked: 0 };
      },
      pushToUser: () => 1,
      logger: () => {},
    });
    assert.deepStrictEqual(result, { expired: 1 });
    assert.strictEqual(ctx.row().status, 'expired');
    assert.strictEqual(schedules, 1);
    assert.strictEqual(kicks, 0);
    assert.strictEqual(preview.getExpirationCleanupStats().pending, 1);
    assert.strictEqual(preview.getExpirationCleanupStats().active, 0);
    assert.strictEqual(preview.getExpirationCleanupStats().tracked, 1);
  } finally {
    restore();
  }

  let waiterResolved = false;
  const waiter = preview.waitForExpirationCleanup().then(() => {
    waiterResolved = true;
  });
  await Promise.resolve();
  assert.strictEqual(waiterResolved, false);
  preview.expireStaleSessions();
  await waiter;
  assert.strictEqual(kicks, 1);
  assert.strictEqual(preview.getExpirationCleanupStats().pending, 0);
  assert.strictEqual(preview.getExpirationCleanupStats().active, 0);
  assert.strictEqual(preview.getExpirationCleanupStats().tracked, 0);
});

test('waitForExpirationCleanup incluye retries y admite varios waiters', async () => {
  const ctx = createSession('DEV_EXP_MULTI_WAITER');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  let attempts = 0;
  preview.expireStaleSessions({
    kickSrtPublishersForPath: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('retry');
      return { status: 'not_found', matched: 0, kicked: 0 };
    },
    pushToUser: () => 1,
    logger: () => {},
  });

  const completions = [];
  const first = preview.waitForExpirationCleanup().then(() => completions.push('first'));
  const second = preview.waitForExpirationCleanup().then(() => completions.push('second'));
  await Promise.all([first, second]);

  assert.strictEqual(attempts, 3);
  assert.deepStrictEqual(new Set(completions), new Set(['first', 'second']));
  await preview.waitForExpirationCleanup();
});

test('excepciones inesperadas no producen unhandledRejection ni dejan trabajo pendiente', async () => {
  const ctx = createSession('DEV_EXP_NO_UNHANDLED');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  const h = harness({
    kick: async () => {
      throw new Error('kick exploded');
    },
    push: async () => {
      throw new Error('push exploded');
    },
    logger: async () => {
      throw new Error('logger exploded');
    },
  });
  try {
    preview.expireStaleSessions(h.options);
    await preview.waitForExpirationCleanup();
    await Promise.resolve();
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});
