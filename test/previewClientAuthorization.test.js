// Autorizacion y maquina de estados para eventos preview cliente -> servidor.
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
const { makeMediaApiMock } = require('./helpers/mediaApiMock');

const preview = projectRequire('src/screenCamPreview.js');
const db = projectRequire('src/db/adminDb.js');
const wsMock = installWsMock();
const mediaApi = makeMediaApiMock();

test.after(async () => {
  await preview.waitForExpirationCleanup();
  wsMock.restore();
  env.cleanup();
});

function createSession(rustdeskId, requestedBy = null) {
  const { userId } = seedActiveDevice({ rustdeskId });
  const session = preview.startPreview(rustdeskId, requestedBy ?? userId);
  return { userId, rustdeskId, session, row: () => getSessionRow(session.session_id) };
}

function started(ctx, overrides = {}) {
  return preview.updateFromClientForUser(
    overrides.userId ?? ctx.userId,
    overrides.sessionId ?? ctx.session.session_id,
    overrides.rustdeskId ?? ctx.rustdeskId,
    { status: 'publishing' },
  );
}

test('el propietario actualiza su propia sesion y recibe estado', () => {
  const ctx = createSession('DEV_SAFE_OWNER');
  const out = started(ctx);
  assert.ok(out);
  assert.strictEqual(out.session_id, ctx.session.session_id);
  assert.strictEqual(out.device_id, ctx.rustdeskId);
  assert.strictEqual(out.status, 'ready');
  assert.ok(!('read_token' in out));
});

test('otro usuario no puede actualizar ni observar la sesion', () => {
  const ctx = createSession('DEV_SAFE_FOREIGN_TARGET');
  const foreign = seedActiveDevice({ rustdeskId: 'DEV_SAFE_FOREIGN_ACTOR' });
  const before = ctx.row();
  const out = started(ctx, { userId: foreign.userId });
  assert.strictEqual(out, null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('el propietario con rustdesk_id incorrecto no puede actualizar', () => {
  const ctx = createSession('DEV_SAFE_WRONG_ID');
  const before = ctx.row();
  const out = started(ctx, { rustdeskId: 'DEV_SAFE_WRONG_ID_OTHER' });
  assert.strictEqual(out, null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('sesion inexistente devuelve el mismo null que una sesion ajena', () => {
  const ctx = createSession('DEV_SAFE_INDISTINGUISHABLE');
  const foreign = seedActiveDevice({ rustdeskId: 'DEV_SAFE_INDISTINGUISHABLE_FOREIGN' });
  const missing = preview.updateFromClientForUser(
    foreign.userId, 'pv_no_existe', ctx.rustdeskId, { status: 'publishing' },
  );
  const unauthorized = started(ctx, { userId: foreign.userId });
  assert.strictEqual(missing, null);
  assert.strictEqual(unauthorized, missing);
});

test('un dispositivo eliminado deja la sesion huerfana e inactualizable', () => {
  const ctx = createSession('DEV_SAFE_ORPHAN');
  db.prepare('delete from devices where rustdesk_id = ?').run(ctx.rustdeskId);
  const before = ctx.row();
  assert.strictEqual(started(ctx), null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('requested_by no concede autorizacion sobre la sesion', () => {
  const owner = seedActiveDevice({ rustdeskId: 'DEV_SAFE_REQUEST_OWNER' });
  const requester = seedActiveDevice({ rustdeskId: 'DEV_SAFE_REQUEST_ADMIN' });
  const session = preview.startPreview(owner.rustdeskId, requester.userId);
  const denied = preview.updateFromClientForUser(
    requester.userId, session.session_id, owner.rustdeskId, { status: 'publishing' },
  );
  assert.strictEqual(denied, null);
  assert.strictEqual(getSessionRow(session.session_id).status, 'waiting_client');
  assert.ok(preview.updateFromClientForUser(
    owner.userId, session.session_id, owner.rustdeskId, { status: 'publishing' },
  ));
});

test('conocer session_id no basta y no filtra playback_url ni read_token', () => {
  const ctx = createSession('DEV_SAFE_NO_LEAK');
  const ownerState = started(ctx);
  assert.ok(ownerState.playback_url);
  const foreign = seedActiveDevice({ rustdeskId: 'DEV_SAFE_NO_LEAK_FOREIGN' });
  const leaked = started(ctx, { userId: foreign.userId });
  assert.strictEqual(leaked, null);
  const serialized = JSON.stringify(leaked);
  assert.ok(!serialized.includes('playback_url'));
  assert.ok(!serialized.includes('read_token'));
});

test('waiting_client -> started -> ready', () => {
  const ctx = createSession('DEV_STATE_WAITING');
  assert.strictEqual(ctx.row().status, 'waiting_client');
  assert.strictEqual(started(ctx).status, 'ready');
});

test('connecting autorizado es informativo y una sesion vencida se cierra sin ACK', () => {
  const live = createSession('DEV_STATE_CONNECTING');
  const before = live.row();
  assert.strictEqual(preview.updateFromClientForUser(
    live.userId,
    live.session.session_id,
    live.rustdeskId,
    { status: 'connecting' },
  ), null);
  assert.deepStrictEqual(live.row(), before);

  const expired = createSession('DEV_STATE_CONNECTING_EXPIRED');
  forceSessionColumns(expired.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  assert.strictEqual(preview.updateFromClientForUser(
    expired.userId,
    expired.session.session_id,
    expired.rustdeskId,
    { status: 'connecting' },
  ), null);
  assert.strictEqual(expired.row().status, 'expired');
});

test('publishing -> started es idempotente y no genera URL', () => {
  const ctx = createSession('DEV_STATE_PUBLISHING');
  const original = process.env.MEDIA_PLAYBACK_BASE;
  delete process.env.MEDIA_PLAYBACK_BASE;
  try {
    assert.strictEqual(started(ctx).status, 'publishing');
  } finally {
    process.env.MEDIA_PLAYBACK_BASE = original;
  }
  const before = ctx.row();
  const duplicate = started(ctx);
  assert.strictEqual(duplicate.status, 'publishing');
  assert.strictEqual(duplicate.playback_url, null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('ready -> started es idempotente y no regenera la URL', () => {
  const ctx = createSession('DEV_STATE_READY');
  const first = started(ctx);
  const before = ctx.row();
  const duplicate = started(ctx);
  assert.strictEqual(duplicate.status, 'ready');
  assert.strictEqual(duplicate.playback_url, first.playback_url);
  assert.deepStrictEqual(ctx.row(), before);
});

for (const terminal of ['stopped', 'failed', 'expired']) {
  test(`${terminal} -> started permanece terminal`, () => {
    const ctx = createSession(`DEV_STATE_${terminal.toUpperCase()}_START`);
    forceSessionColumns(ctx.session.session_id, {
      status: terminal,
      ended_at: '2025-01-02 03:04:05',
      error: terminal === 'failed' ? 'first_failure' : null,
    });
    const before = ctx.row();
    assert.strictEqual(started(ctx), null);
    assert.deepStrictEqual(ctx.row(), before);
  });
}

test('stopped -> failed permanece stopped', () => {
  const ctx = createSession('DEV_STATE_STOP_FAILED');
  forceSessionColumns(ctx.session.session_id, {
    status: 'stopped', ended_at: '2025-01-02 03:04:05',
  });
  const before = ctx.row();
  const out = preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'failed', error: 'late_failure' },
  );
  assert.strictEqual(out, null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('expired -> failed permanece expired', () => {
  const ctx = createSession('DEV_STATE_EXPIRED_FAILED');
  forceSessionColumns(ctx.session.session_id, {
    status: 'expired', ended_at: '2025-01-02 03:04:05',
  });
  const before = ctx.row();
  preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'failed', error: 'late_failure' },
  );
  assert.deepStrictEqual(ctx.row(), before);
});

test('failed -> stopped permanece failed', () => {
  const ctx = createSession('DEV_STATE_FAILED_STOP');
  forceSessionColumns(ctx.session.session_id, {
    status: 'failed', error: 'first_failure', ended_at: '2025-01-02 03:04:05',
  });
  const before = ctx.row();
  preview.updateFromClientForUser(
    ctx.userId, ctx.session.session_id, ctx.rustdeskId, { status: 'stopped' },
  );
  assert.deepStrictEqual(ctx.row(), before);
});

test('stopped duplicado no reescribe ended_at', () => {
  const ctx = createSession('DEV_STATE_STOP_DUP');
  preview.updateFromClientForUser(
    ctx.userId, ctx.session.session_id, ctx.rustdeskId, { status: 'stopped' },
  );
  const before = ctx.row();
  preview.updateFromClientForUser(
    ctx.userId, ctx.session.session_id, ctx.rustdeskId, { status: 'stopped' },
  );
  assert.deepStrictEqual(ctx.row(), before);
});

test('failed duplicado conserva el primer error y ended_at', () => {
  const ctx = createSession('DEV_STATE_FAILED_DUP');
  preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'failed', error: 'first_failure' },
  );
  const before = ctx.row();
  preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'failed', error: 'second_failure' },
  );
  assert.deepStrictEqual(ctx.row(), before);
});

test('sesion vencida en estado vivo se marca expired y no acepta started', () => {
  const ctx = createSession('DEV_STATE_EXPIRED_LIVE');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  assert.strictEqual(started(ctx), null);
  assert.strictEqual(ctx.row().status, 'expired');
  assert.strictEqual(ctx.row().playback_url, null);
});

test('evento retrasado de una sesion antigua no modifica la nueva', () => {
  const ctx = createSession('DEV_STATE_DELAYED');
  preview.updateFromClientForUser(
    ctx.userId, ctx.session.session_id, ctx.rustdeskId, { status: 'stopped' },
  );
  const newer = preview.startPreview(ctx.rustdeskId, ctx.userId);
  const newBefore = getSessionRow(newer.session_id);
  assert.strictEqual(started(ctx), null);
  assert.strictEqual(ctx.row().status, 'stopped');
  assert.deepStrictEqual(getSessionRow(newer.session_id), newBefore);
});

test('Stop que gana la carrera no puede ser sobrescrito por started', async () => {
  const ctx = createSession('DEV_STATE_STOP_RACE');
  await preview.stopPreview(ctx.session.session_id, ctx.userId, {
    expectedRustdeskId: ctx.rustdeskId, mediaApi,
  });
  const before = ctx.row();
  assert.strictEqual(started(ctx), null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('expiracion que gana la carrera no puede ser sobrescrita por started', async () => {
  const ctx = createSession('DEV_STATE_EXPIRE_RACE');
  forceSessionColumns(ctx.session.session_id, { expires_at: '2000-01-01 00:00:00' });
  preview.expireStaleSessions({
    kickSrtPublishersForPath: mediaApi.kickSrtPublishersForPath,
    pushToUser: () => 0,
    logger: () => {},
  });
  await preview.waitForExpirationCleanup();
  const before = ctx.row();
  assert.strictEqual(started(ctx), null);
  assert.deepStrictEqual(ctx.row(), before);
});

test('failed rechaza objetos y limita codigos de error seguros a 100 caracteres', () => {
  const invalid = createSession('DEV_ERROR_OBJECT');
  preview.updateFromClientForUser(
    invalid.userId,
    invalid.session.session_id,
    invalid.rustdeskId,
    { status: 'failed', error: { message: 'secret' } },
  );
  assert.strictEqual(invalid.row().status, 'waiting_client');

  const limited = createSession('DEV_ERROR_LIMIT');
  preview.updateFromClientForUser(
    limited.userId,
    limited.session.session_id,
    limited.rustdeskId,
    { status: 'failed', error: 'x'.repeat(150) },
  );
  assert.strictEqual(limited.row().error, 'x'.repeat(100));
});

test('failed no almacena URLs, tokens ni texto estructurado', () => {
  const ctx = createSession('DEV_ERROR_SAFE');
  preview.updateFromClientForUser(
    ctx.userId,
    ctx.session.session_id,
    ctx.rustdeskId,
    { status: 'failed', error: 'https://host/path?token=secret' },
  );
  assert.strictEqual(ctx.row().error, 'unknown');
});
