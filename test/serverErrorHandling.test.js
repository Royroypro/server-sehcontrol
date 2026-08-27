const test = require('node:test');
const assert = require('node:assert');

const { setupTestEnv } = require('./helpers/env');
const env = setupTestEnv();
const { projectRequire } = require('./helpers/fixtures');
const { createGlobalErrorHandler } = projectRequire('src/server.js');

test.after(() => {
  env.cleanup();
});

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('el middleware global solo registra un mensaje fijo y controlado', () => {
  const calls = [];
  const handler = createGlobalErrorHandler({
    logger: (...args) => calls.push(args),
  });
  const response = responseRecorder();
  const secret = 'token=QUERY_SECRET stack /home/private internal.invalid';

  handler(
    Object.assign(new Error(secret), { code: secret }),
    { method: 'GET', path: '/api/ws', originalUrl: `/api/ws?${secret}` },
    response,
    () => assert.fail('el middleware final no debe delegar'),
  );

  assert.strictEqual(response.statusCode, 500);
  assert.deepStrictEqual(response.body, { error: 'Error interno del servidor' });
  assert.deepStrictEqual(calls, [[
    '[server] operation=request-handler code=internal_error',
  ]]);
  const serialized = JSON.stringify({ calls, body: response.body });
  for (const forbidden of ['QUERY_SECRET', '/home/private', 'internal.invalid', 'stack']) {
    assert.ok(!serialized.includes(forbidden));
  }
});

test('un fallo del logger no altera la respuesta sanitaria', () => {
  const response = responseRecorder();
  const handler = createGlobalErrorHandler({
    logger() {
      throw new Error('logger indisponible');
    },
  });

  assert.doesNotThrow(() => {
    handler(new Error('detalle privado'), {}, response, () => {});
  });
  assert.strictEqual(response.statusCode, 500);
  assert.deepStrictEqual(response.body, { error: 'Error interno del servidor' });
});

test('un error de dominio respondido por su ruta no alcanza el logger global', () => {
  const calls = [];
  const globalHandler = createGlobalErrorHandler({
    logger: (...args) => calls.push(args),
  });
  const response = responseRecorder();
  const domainHandler = (res) => res.status(409).json({
    error: 'Ya hay una previsualizacion abierta para este equipo',
  });

  domainHandler(response);

  assert.strictEqual(response.statusCode, 409);
  assert.deepStrictEqual(response.body, {
    error: 'Ya hay una previsualizacion abierta para este equipo',
  });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(typeof globalHandler, 'function');
});
