// Pruebas del cliente de la API de MediaMTX.
//
// Levantan un servidor HTTP real, atado exclusivamente a 127.0.0.1 y con
// puerto aleatorio (puerto 0). No usan Docker, ni MediaMTX real, ni salen
// de loopback. Cada prueba cierra su servidor.
//
// El `fetch` no se parchea globalmente: el modulo acepta `fetchImpl` por
// opciones, asi que basta con pasarle el nativo apuntando al servidor local.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const mediaApi = require(path.resolve(__dirname, '..', 'src', 'mediaMtxApi.js'));

// Arranca un servidor de prueba y devuelve su URL base y un cierre.
// `handler(req, res, ctx)` recibe un ctx donde se acumulan las rutas
// pedidas, para poder afirmar sobre ellas.
async function withServer(handler, run) {
  const ctx = { requests: [] };
  const server = http.createServer((req, res) => {
    ctx.requests.push({ method: req.method, url: req.url });
    handler(req, res, ctx);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, ctx);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function listResponse(items, itemCount = items.length) {
  return {
    pageCount: Math.ceil(itemCount / 100),
    itemCount,
    items,
  };
}

function fillerItems(count, prefix = 'filler') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    state: 'read',
    path: 'otro',
  }));
}

function expectedSummary({
  status,
  matched,
  kicked,
  alreadyGone = 0,
  failed = 0,
  error = null,
}) {
  return {
    status,
    matched,
    kicked,
    already_gone: alreadyGone,
    failed,
    error,
  };
}

async function runKickScenario(behaviors, options = {}) {
  const streamPath = options.streamPath || 'pv_partial';
  return withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse(
          Object.keys(behaviors).map((id) => ({ id, state: 'publish', path: streamPath })),
        ));
      }
      const id = decodeURIComponent(req.url.slice(req.url.lastIndexOf('/') + 1));
      const behavior = behaviors[id];
      if (behavior === 'success') return sendJson(res, 200, {});
      if (behavior === 'gone') return sendJson(res, 404, {});
      if (behavior === 'timeout') {
        setTimeout(() => {
          try { res.end(); } catch (_) { /* solicitud ya abortada */ }
        }, 500).unref();
        return undefined;
      }
      return sendJson(res, 500, {});
    },
    async (apiUrl, ctx) => {
      const result = await mediaApi.kickSrtPublishersForPath(streamPath, {
        apiUrl,
        timeoutMs: options.timeoutMs || 50,
      });
      const posts = ctx.requests
        .filter((request) => request.method === 'POST')
        .map((request) => decodeURIComponent(request.url.slice(request.url.lastIndexOf('/') + 1)));
      return { result, posts };
    },
  );
}

// El token nunca debe salir del servidor de prueba hacia el resumen.
const SECRET_QUERY = 'token=SECRETO_QUE_NO_DEBE_FILTRARSE';

test('1) lista sin conexiones -> not_found', async () => {
  await withServer(
    (req, res) => sendJson(res, 200, listResponse([])),
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000001', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'not_found', matched: 0, kicked: 0,
      }));
    },
  );
});

test('2) publisher con path exacto -> hace POST kick', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse([
          { id: 'uuid-1', state: 'publish', path: 'pv_0000000002', query: SECRET_QUERY },
        ]));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000002', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 1, kicked: 1,
      }));
      const kick = ctx.requests.find((r) => r.url.includes('/kick/'));
      assert.strictEqual(kick.method, 'POST');
      assert.strictEqual(kick.url, '/v3/srtconns/kick/uuid-1');
    },
  );
});

test('3) reader con el mismo path -> NO se expulsa', async () => {
  await withServer(
    (req, res) => sendJson(res, 200, listResponse([
      { id: 'uuid-reader', state: 'read', path: 'pv_0000000003', query: SECRET_QUERY },
    ])),
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000003', { apiUrl });
      assert.strictEqual(out.status, 'not_found');
      assert.strictEqual(ctx.requests.filter((r) => r.url.includes('/kick/')).length, 0);
    },
  );
});

test('4) publisher de otro path -> NO se expulsa (sin coincidencia parcial)', async () => {
  await withServer(
    (req, res) => sendJson(res, 200, listResponse([
      // Prefijo del buscado: no debe considerarse coincidencia.
      { id: 'uuid-otro', state: 'publish', path: 'pv_0000000004_extra', query: SECRET_QUERY },
      { id: 'uuid-otro2', state: 'publish', path: 'otro_path', query: SECRET_QUERY },
    ])),
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000004', { apiUrl });
      assert.strictEqual(out.status, 'not_found');
      assert.strictEqual(ctx.requests.filter((r) => r.url.includes('/kick/')).length, 0);
    },
  );
});

test('5) varios publishers del mismo path -> expulsa todos', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse([
          { id: 'uuid-a', state: 'publish', path: 'pv_0000000005', query: SECRET_QUERY },
          { id: 'uuid-b', state: 'publish', path: 'pv_0000000005', query: SECRET_QUERY },
          { id: 'uuid-r', state: 'read', path: 'pv_0000000005', query: SECRET_QUERY },
        ]));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000005', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 2, kicked: 2,
      }));
      const kicks = ctx.requests.filter((r) => r.url.includes('/kick/')).map((r) => r.url);
      assert.deepStrictEqual(kicks.sort(), ['/v3/srtconns/kick/uuid-a', '/v3/srtconns/kick/uuid-b']);
    },
  );
});

test('6) 404 al kick -> idempotente, no es fallo', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse([
          { id: 'uuid-ya-cerrado', state: 'publish', path: 'pv_0000000006', query: SECRET_QUERY },
        ]));
      }
      return sendJson(res, 404, { error: 'not found' });
    },
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000006', { apiUrl });
      assert.strictEqual(out.status, 'not_found');
      assert.strictEqual(out.matched, 1);
      assert.strictEqual(out.kicked, 0);
      assert.strictEqual(out.already_gone, 1);
      assert.strictEqual(out.failed, 0);
      assert.strictEqual(out.error, null, 'un 404 no debe reportarse como error');
    },
  );
});

test('7) error 500 en list -> failed', async () => {
  await withServer(
    (req, res) => sendJson(res, 500, { error: 'boom' }),
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000007', { apiUrl });
      assert.strictEqual(out.status, 'failed');
      assert.strictEqual(out.error, 'list_failed');
    },
  );
});

test('8) JSON invalido -> failed', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{ esto no es json valido');
    },
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000008', { apiUrl });
      assert.strictEqual(out.status, 'failed');
      assert.strictEqual(out.error, 'invalid_response');
    },
  );
});

test('8b) respuesta sin items -> invalid_response', async () => {
  await withServer(
    (req, res) => sendJson(res, 200, { pageCount: 1, itemCount: 0 }),
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000008b', { apiUrl });
      assert.strictEqual(out.status, 'failed');
      assert.strictEqual(out.error, 'invalid_response');
    },
  );
});

const invalidListResponses = [
  ['pageCount negativo', { itemCount: 0, pageCount: -1, items: [] }],
  ['pageCount decimal', { itemCount: 0, pageCount: 1.5, items: [] }],
  ['pageCount string', { itemCount: 0, pageCount: '0', items: [] }],
  ['pageCount null', { itemCount: 0, pageCount: null, items: [] }],
  ['pageCount ausente', { itemCount: 0, items: [] }],
  ['itemCount negativo', { itemCount: -1, pageCount: 0, items: [] }],
  ['itemCount decimal', { itemCount: 1.5, pageCount: 1, items: [] }],
  ['itemCount string', { itemCount: '0', pageCount: 0, items: [] }],
  ['itemCount null', { itemCount: null, pageCount: 0, items: [] }],
  ['itemCount ausente', { pageCount: 0, items: [] }],
  ['items ausente', { itemCount: 0, pageCount: 0 }],
  ['items no array', { itemCount: 0, pageCount: 0, items: {} }],
  ['mas de 100 items', { itemCount: 101, pageCount: 2, items: fillerItems(101) }],
  ['itemCount 0 con pageCount 1', { itemCount: 0, pageCount: 1, items: [] }],
  ['itemCount 100 con pageCount 0', { itemCount: 100, pageCount: 0, items: fillerItems(100) }],
  ['itemCount 101 con pageCount 1', { itemCount: 101, pageCount: 1, items: fillerItems(100) }],
  ['longitud incoherente', { itemCount: 100, pageCount: 1, items: fillerItems(99) }],
];

for (const [name, body] of invalidListResponses) {
  test(`respuesta paginada invalida: ${name}`, async () => {
    await withServer(
      (req, res) => sendJson(res, 200, body),
      async (apiUrl) => {
        const out = await mediaApi.kickSrtPublishersForPath('pv_invalid_matrix', { apiUrl });
        assert.strictEqual(out.status, 'failed');
        assert.strictEqual(out.error, 'invalid_response');
      },
    );
  });
}

for (const [name, value, field] of [
  ['pageCount NaN', Number.NaN, 'pageCount'],
  ['pageCount infinito', Number.POSITIVE_INFINITY, 'pageCount'],
  ['itemCount NaN', Number.NaN, 'itemCount'],
  ['itemCount infinito', Number.POSITIVE_INFINITY, 'itemCount'],
]) {
  test(`respuesta paginada invalida directa: ${name}`, async () => {
    const body = { itemCount: 0, pageCount: 0, items: [] };
    body[field] = value;
    const fetchImpl = async () => ({
      ok: true,
      async json() { return body; },
    });
    const out = await mediaApi.kickSrtPublishersForPath('pv_invalid_direct', { fetchImpl });
    assert.strictEqual(out.status, 'failed');
    assert.strictEqual(out.error, 'invalid_response');
  });
}

test('respuesta valida: 100 elementos forman una pagina completa', async () => {
  await withServer(
    (req, res) => sendJson(res, 200, listResponse(fillerItems(100), 100)),
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_full_page', { apiUrl });
      assert.strictEqual(out.status, 'not_found');
    },
  );
});

test('respuesta valida: 101 elementos recorren una pagina completa y una parcial', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        if (page === 0) return sendJson(res, 200, listResponse(fillerItems(100), 101));
        return sendJson(res, 200, listResponse([
          { id: 'partial-target', state: 'publish', path: 'pv_partial_page' },
        ], 101));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_partial_page', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 1, kicked: 1,
      }));
      assert.strictEqual(ctx.requests.filter((request) => request.method === 'GET').length, 2);
    },
  );
});

test('respuesta valida: pagina que queda fuera de rango devuelve items vacio', async () => {
  await withServer(
    (req, res) => {
      const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
      if (page === 0) return sendJson(res, 200, listResponse(fillerItems(100, 'range-0'), 201));
      if (page === 1) return sendJson(res, 200, listResponse(fillerItems(100, 'range-1'), 201));
      // Entre solicitudes la lista se redujo: para este snapshot la pagina 2
      // esta fuera del rango, pero sigue siendo una respuesta valida.
      return sendJson(res, 200, listResponse([], 150));
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_out_of_range', { apiUrl });
      assert.strictEqual(out.status, 'not_found');
      assert.strictEqual(ctx.requests.filter((request) => request.method === 'GET').length, 3);
    },
  );
});

test('pagina posterior invalida conserva y expulsa IDs previos', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        if (page === 0) {
          const items = fillerItems(100, 'valid-before-invalid');
          items[10] = { id: 'target-before-invalid', state: 'publish', path: 'pv_late_invalid' };
          return sendJson(res, 200, listResponse(items, 101));
        }
        return sendJson(res, 200, { itemCount: 101, pageCount: '2', items: [{}] });
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_late_invalid', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'failed',
        matched: 1,
        kicked: 1,
        error: 'invalid_response',
      }));
      assert.ok(ctx.requests.some((request) => request.url.endsWith('/kick/target-before-invalid')));
    },
  );
});

test('fallo HTTP posterior conserva y expulsa IDs previos', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        if (page === 0) {
          const items = fillerItems(100, 'valid-before-http');
          items[20] = { id: 'target-before-http', state: 'publish', path: 'pv_late_http' };
          return sendJson(res, 200, listResponse(items, 101));
        }
        return sendJson(res, 500, {});
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_late_http', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'failed',
        matched: 1,
        kicked: 1,
        error: 'list_failed',
      }));
      assert.ok(ctx.requests.some((request) => request.url.endsWith('/kick/target-before-http')));
    },
  );
});

test('timeout posterior conserva y expulsa IDs previos', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        if (page === 0) {
          const items = fillerItems(100, 'valid-before-timeout');
          items[30] = { id: 'target-before-timeout', state: 'publish', path: 'pv_late_timeout' };
          return sendJson(res, 200, listResponse(items, 101));
        }
        setTimeout(() => {
          try { res.end(); } catch (_) { /* solicitud ya abortada */ }
        }, 500).unref();
        return undefined;
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_late_timeout', {
        apiUrl,
        timeoutMs: 50,
      });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'failed',
        matched: 1,
        kicked: 1,
        error: 'timeout',
      }));
      assert.ok(ctx.requests.some((request) => request.url.endsWith('/kick/target-before-timeout')));
    },
  );
});

test('9) timeout -> failed', async () => {
  await withServer(
    (req, res) => {
      // Nunca responde: fuerza el AbortSignal.timeout del cliente.
      setTimeout(() => { try { res.end(); } catch (_) { /* ya cerrado */ } }, 5000).unref();
    },
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000009', { apiUrl, timeoutMs: 150 });
      assert.strictEqual(out.status, 'failed');
      assert.strictEqual(out.error, 'timeout');
    },
  );
});

test('10) paginacion -> encuentra el publisher en una pagina posterior', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        if (page === 0) {
          return sendJson(res, 200, listResponse(fillerItems(100, 'page-0'), 201));
        }
        if (page === 1) {
          return sendJson(res, 200, listResponse(fillerItems(100, 'page-1'), 201));
        }
        return sendJson(res, 200, listResponse(
          [{ id: 'uuid-p2', state: 'publish', path: 'pv_0000000010', query: SECRET_QUERY }],
          201,
        ));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000010', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 1, kicked: 1,
      }));
      const listCalls = ctx.requests.filter((r) => r.url.startsWith('/v3/srtconns/list'));
      assert.strictEqual(listCalls.length, 3, 'debe recorrer las tres paginas');
      assert.ok(ctx.requests.some((r) => r.url === '/v3/srtconns/kick/uuid-p2'));
    },
  );
});

test('10b) mas de 20 paginas -> kick best-effort y failed/page_limit', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        const items = fillerItems(100, `limit-${page}`);
        if (page === 3) {
          items[25] = { id: 'publisher-dentro-limite', state: 'publish', path: 'pv_000000010b' };
        }
        // El publisher de la pagina 20 nunca debe observarse.
        if (page === 20) {
          items[0] = { id: 'publisher-fuera-limite', state: 'publish', path: 'pv_000000010b' };
        }
        return sendJson(res, 200, listResponse(items, 2100));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_000000010b', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'failed',
        matched: 1,
        kicked: 1,
        error: 'page_limit',
      }));
      const gets = ctx.requests.filter((request) => request.method === 'GET');
      assert.strictEqual(gets.length, mediaApi.MAX_PAGES, 'debe hacer exactamente 20 GET');
      assert.ok(gets.every((request) => !request.url.includes('page=20&')));
      assert.ok(ctx.requests.some((request) => request.url.endsWith('/kick/publisher-dentro-limite')));
      assert.ok(ctx.requests.every((request) => !request.url.includes('publisher-fuera-limite')));
    },
  );
});

test('ID duplicado dentro de una pagina produce un solo POST', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse([
          { id: 'dup-in-page', state: 'publish', path: 'pv_dup_inside' },
          { id: 'dup-in-page', state: 'publish', path: 'pv_dup_inside' },
        ]));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_dup_inside', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 1, kicked: 1,
      }));
      const posts = ctx.requests.filter((request) => request.method === 'POST');
      assert.strictEqual(posts.length, 1);
      assert.ok(posts[0].url.endsWith('/kick/dup-in-page'));
    },
  );
});

test('ID duplicado entre paginas produce un solo POST', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        if (page === 0) {
          const items = fillerItems(100, 'dup-pages');
          items[0] = { id: 'dup-across-pages', state: 'publish', path: 'pv_dup_pages' };
          return sendJson(res, 200, listResponse(items, 101));
        }
        return sendJson(res, 200, listResponse([
          { id: 'dup-across-pages', state: 'publish', path: 'pv_dup_pages' },
        ], 101));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_dup_pages', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 1, kicked: 1,
      }));
      assert.strictEqual(ctx.requests.filter((request) => request.method === 'POST').length, 1);
    },
  );
});

test('varios IDs repetidos conservan el primer orden de aparicion', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse([
          { id: 'second', state: 'publish', path: 'pv_dup_order' },
          { id: 'first', state: 'publish', path: 'pv_dup_order' },
          { id: 'second', state: 'publish', path: 'pv_dup_order' },
          { id: 'third', state: 'publish', path: 'pv_dup_order' },
          { id: 'first', state: 'publish', path: 'pv_dup_order' },
        ]));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl, ctx) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_dup_order', { apiUrl });
      assert.deepStrictEqual(out, expectedSummary({
        status: 'kicked', matched: 3, kicked: 3,
      }));
      const posts = ctx.requests
        .filter((request) => request.method === 'POST')
        .map((request) => decodeURIComponent(request.url.slice(request.url.lastIndexOf('/') + 1)));
      assert.deepStrictEqual(posts, ['second', 'first', 'third']);
    },
  );
});

test('11) URL no loopback -> se rechaza SIN emitir ninguna solicitud', async () => {
  // Se monta un servidor solo para comprobar que NO recibe nada.
  await withServer(
    (req, res) => sendJson(res, 200, listResponse([])),
    async (apiUrl, ctx) => {
      const rechazadas = [
        'http://10.0.0.5:9997',
        'http://example.com:9997',
        'https://127.0.0.1:9997',          // https no permitido
        'http://user:pass@127.0.0.1:9997', // credenciales
        'http://127.0.0.1:9997?x=1',       // query
        'http://127.0.0.1:9997#frag',      // fragment
        'http://127.0.0.1:9997/internal',
        'http://127.0.0.1:9997/unexpected/base',
        'http://localhost:9997/api',
        'http://[::1]:9997/internal',
        'no-es-una-url',
      ];
      for (const bad of rechazadas) {
        const out = await mediaApi.kickSrtPublishersForPath('pv_0000000011', { apiUrl: bad });
        assert.strictEqual(out.status, 'failed', `deberia rechazar ${bad}`);
        assert.strictEqual(out.error, 'invalid_api_url', `deberia rechazar ${bad}`);
      }
      assert.strictEqual(ctx.requests.length, 0, 'no debe emitirse ninguna solicitud');
      // Y las loopback validas si se aceptan.
      assert.ok(mediaApi.resolveApiUrl('http://localhost:9997'));
      assert.ok(mediaApi.resolveApiUrl('http://localhost:9997/'));
      assert.ok(mediaApi.resolveApiUrl('http://127.0.0.1'), 'sin puerto se resuelve a 9997');
      assert.ok(mediaApi.resolveApiUrl(`${apiUrl}/`), 'la barra final es valida');
      assert.strictEqual(mediaApi.resolveApiUrl('http://127.0.0.1'), 'http://127.0.0.1:9997');
      assert.strictEqual(mediaApi.resolveApiUrl('http://[::1]:9997/'), 'http://[::1]:9997');
      // apiUrl vacio no debe caer al servidor de prueba.
      assert.strictEqual(ctx.requests.length, 0);
    },
  );
});

test('12) el resumen no filtra query, token ni datos de la conexion', async () => {
  await withServer(
    (req, res) => {
      if (req.url.startsWith('/v3/srtconns/list')) {
        return sendJson(res, 200, listResponse([
          {
            id: 'uuid-12', state: 'publish', path: 'pv_0000000012',
            query: SECRET_QUERY, remoteAddr: '203.0.113.9:5555',
          },
        ]));
      }
      return sendJson(res, 200, {});
    },
    async (apiUrl) => {
      const out = await mediaApi.kickSrtPublishersForPath('pv_0000000012', { apiUrl });
      const serialized = JSON.stringify(out);
      assert.ok(!serialized.includes('SECRETO_QUE_NO_DEBE_FILTRARSE'), 'no debe aparecer el token');
      assert.ok(!serialized.includes('token='), 'no debe aparecer el query');
      assert.ok(!serialized.includes('203.0.113.9'), 'no debe aparecer la direccion remota');
      assert.ok(!serialized.includes('uuid-12'), 'no debe aparecer el id de la conexion');
      assert.deepStrictEqual(
        Object.keys(out).sort(),
        ['already_gone', 'error', 'failed', 'kicked', 'matched', 'status'],
      );
    },
  );
});

for (const statusCode of [302, 307]) {
  test(`redirect ${statusCode} durante GET list no se sigue`, async () => {
    await withServer(
      (req, res) => sendJson(res, 200, { reached: true }),
      async (targetUrl, targetCtx) => {
        await withServer(
          (req, res) => {
            res.writeHead(statusCode, { Location: `${targetUrl}/redirect-target` });
            res.end();
          },
          async (apiUrl) => {
            const out = await mediaApi.kickSrtPublishersForPath('pv_redirect_list', { apiUrl });
            assert.strictEqual(out.status, 'failed');
            assert.strictEqual(out.error, 'list_failed');
            assert.strictEqual(targetCtx.requests.length, 0, 'el destino no debe recibir solicitudes');
            assert.ok(!JSON.stringify(out).includes(targetUrl), 'el resultado no debe exponer Location');
          },
        );
      },
    );
  });
}

for (const statusCode of [301, 303]) {
  test(`redirect ${statusCode} durante GET queda sanitario y no se sigue`, async () => {
    await withServer(
      (req, res) => sendJson(res, 200, { reached: true }),
      async (targetUrl, targetCtx) => {
        await withServer(
          (req, res) => {
            res.writeHead(statusCode, {
              Location: `${targetUrl}/secret-path?token=secret-read-token`,
            });
            res.end('secret redirect body');
          },
          async (apiUrl) => {
            const out = await mediaApi.kickSrtPublishersForPath(
              'pv_redirect_list_secret_path',
              { apiUrl },
            );
            assert.deepStrictEqual(out, expectedSummary({
              status: 'failed',
              matched: 0,
              kicked: 0,
              error: 'list_failed',
            }));
            assert.strictEqual(targetCtx.requests.length, 0);
            const serialized = JSON.stringify(out);
            for (const privateValue of [
              targetUrl,
              'secret-path',
              'secret-read-token',
              'secret redirect body',
              'Location',
              'pv_redirect_list_secret_path',
            ]) {
              assert.ok(!serialized.includes(privateValue));
            }
          },
        );
      },
    );
  });
}

for (const statusCode of [302, 308]) {
  test(`redirect ${statusCode} durante POST kick no se sigue ni se reenvia`, async () => {
    await withServer(
      (req, res) => sendJson(res, 200, { reached: true }),
      async (targetUrl, targetCtx) => {
        await withServer(
          (req, res) => {
            if (req.url.startsWith('/v3/srtconns/list')) {
              return sendJson(res, 200, listResponse([
                { id: `redirect-${statusCode}`, state: 'publish', path: 'pv_redirect_kick' },
              ]));
            }
            res.writeHead(statusCode, { Location: `${targetUrl}/redirect-target` });
            res.end();
            return undefined;
          },
          async (apiUrl, sourceCtx) => {
            const out = await mediaApi.kickSrtPublishersForPath('pv_redirect_kick', { apiUrl });
            assert.deepStrictEqual(out, expectedSummary({
              status: 'failed',
              matched: 1,
              kicked: 0,
              failed: 1,
              error: 'kick_failed',
            }));
            assert.strictEqual(
              sourceCtx.requests.filter((request) => request.method === 'POST').length,
              1,
              'el POST original debe intentarse una sola vez',
            );
            assert.strictEqual(targetCtx.requests.length, 0, 'el destino no debe recibir el POST');
            assert.ok(!JSON.stringify(out).includes(targetUrl), 'el resultado no debe exponer Location');
          },
        );
      },
    );
  });
}

for (const statusCode of [301, 303]) {
  test(`redirect ${statusCode} durante POST no se sigue y continua con publishers restantes`, async () => {
    await withServer(
      (req, res) => sendJson(res, 200, { reached: true }),
      async (targetUrl, targetCtx) => {
        await withServer(
          (req, res) => {
            if (req.url.startsWith('/v3/srtconns/list')) {
              return sendJson(res, 200, listResponse([
                {
                  id: `redirect-${statusCode}`,
                  state: 'publish',
                  path: 'pv_redirect_kick_private_path',
                },
                {
                  id: `after-${statusCode}`,
                  state: 'publish',
                  path: 'pv_redirect_kick_private_path',
                },
              ]));
            }
            if (req.url.endsWith(`/redirect-${statusCode}`)) {
              res.writeHead(statusCode, {
                Location: `${targetUrl}/secret-path?token=secret-publish-token`,
              });
              res.end('secret redirect body');
              return undefined;
            }
            return sendJson(res, 200, {});
          },
          async (apiUrl, sourceCtx) => {
            const out = await mediaApi.kickSrtPublishersForPath(
              'pv_redirect_kick_private_path',
              { apiUrl },
            );
            assert.deepStrictEqual(out, expectedSummary({
              status: 'failed',
              matched: 2,
              kicked: 1,
              failed: 1,
              error: 'partial_failure',
            }));
            assert.deepStrictEqual(
              sourceCtx.requests
                .filter((request) => request.method === 'POST')
                .map((request) => request.url.slice(request.url.lastIndexOf('/') + 1)),
              [`redirect-${statusCode}`, `after-${statusCode}`],
            );
            assert.strictEqual(targetCtx.requests.length, 0);
            const serialized = JSON.stringify(out);
            for (const privateValue of [
              targetUrl,
              'secret-path',
              'secret-publish-token',
              'secret redirect body',
              'Location',
              'pv_redirect_kick_private_path',
            ]) {
              assert.ok(!serialized.includes(privateValue));
            }
          },
        );
      },
    );
  });
}

const orderedPartialCases = [
  {
    name: 'fallo en el primer publisher no corta los dos siguientes',
    behaviors: { first: 'http_error', second: 'success', third: 'success' },
    expected: { kicked: 2, alreadyGone: 0, failed: 1, error: 'partial_failure' },
  },
  {
    name: 'fallo en el publisher intermedio no corta el ultimo',
    behaviors: { first: 'success', second: 'http_error', third: 'success' },
    expected: { kicked: 2, alreadyGone: 0, failed: 1, error: 'partial_failure' },
  },
  {
    name: 'fallo en el ultimo conserva los dos exitos anteriores',
    behaviors: { first: 'success', second: 'success', third: 'http_error' },
    expected: { kicked: 2, alreadyGone: 0, failed: 1, error: 'partial_failure' },
  },
];

for (const scenario of orderedPartialCases) {
  test(scenario.name, async () => {
    const { result, posts } = await runKickScenario(scenario.behaviors);
    assert.deepStrictEqual(posts, ['first', 'second', 'third'], 'deben intentarse los tres IDs en orden');
    assert.deepStrictEqual(result, expectedSummary({
      status: 'failed',
      matched: 3,
      ...scenario.expected,
    }));
  });
}

test('timeout en el primer publisher no corta los siguientes', async () => {
  const { result, posts } = await runKickScenario({
    first: 'timeout',
    second: 'success',
    third: 'success',
  });
  assert.deepStrictEqual(posts, ['first', 'second', 'third']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'failed',
    matched: 3,
    kicked: 2,
    failed: 1,
    error: 'partial_failure',
  }));
});

test('404 y exito producen kicked sin fallo real', async () => {
  const { result, posts } = await runKickScenario({ gone: 'gone', active: 'success' });
  assert.deepStrictEqual(posts, ['gone', 'active']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'kicked',
    matched: 2,
    kicked: 1,
    alreadyGone: 1,
  }));
});

test('todos los publishers en 404 producen not_found', async () => {
  const { result, posts } = await runKickScenario({
    first: 'gone',
    second: 'gone',
    third: 'gone',
  });
  assert.deepStrictEqual(posts, ['first', 'second', 'third']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'not_found',
    matched: 3,
    kicked: 0,
    alreadyGone: 3,
  }));
});

test('todos los publishers en timeout producen timeout', async () => {
  const { result, posts } = await runKickScenario({
    first: 'timeout',
    second: 'timeout',
    third: 'timeout',
  });
  assert.deepStrictEqual(posts, ['first', 'second', 'third']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'failed',
    matched: 3,
    kicked: 0,
    failed: 3,
    error: 'timeout',
  }));
});

test('mezcla de timeout y error HTTP produce partial_failure', async () => {
  const { result, posts } = await runKickScenario({
    first: 'timeout',
    second: 'http_error',
    third: 'timeout',
  });
  assert.deepStrictEqual(posts, ['first', 'second', 'third']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'failed',
    matched: 3,
    kicked: 0,
    failed: 3,
    error: 'partial_failure',
  }));
});

test('todos los errores HTTP producen kick_failed', async () => {
  const { result, posts } = await runKickScenario({
    first: 'http_error',
    second: 'http_error',
    third: 'http_error',
  });
  assert.deepStrictEqual(posts, ['first', 'second', 'third']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'failed',
    matched: 3,
    kicked: 0,
    failed: 3,
    error: 'kick_failed',
  }));
});

test('mezcla de exito, 404 y fallo nunca afirma kicked', async () => {
  const { result, posts } = await runKickScenario({
    first: 'success',
    second: 'gone',
    third: 'http_error',
  });
  assert.deepStrictEqual(posts, ['first', 'second', 'third']);
  assert.deepStrictEqual(result, expectedSummary({
    status: 'failed',
    matched: 3,
    kicked: 1,
    alreadyGone: 1,
    failed: 1,
    error: 'partial_failure',
  }));
});

// ---------- isPathPublisherReady (Tarea 2: deteccion de disponibilidad) ----------

test('devuelve ready=true solo cuando MediaMTX confirma source con al menos una pista', async () => {
  await withServer((req, res) => {
    assert.strictEqual(req.method, 'GET');
    assert.strictEqual(req.url, '/v3/paths/get/pv_abc123');
    sendJson(res, 200, {
      name: 'pv_abc123',
      ready: true,
      source: { type: 'srtSource' },
      tracks: ['H264'],
      readers: [{ type: 'webRTCSession', id: 'secret-reader-id' }],
      bytesReceived: 123456,
    });
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_abc123', { apiUrl });
    assert.deepStrictEqual(result, { ready: true, error: null });
  });
});

test('devuelve ready=false (sin error) cuando el path todavia no existe (404)', async () => {
  await withServer((req, res) => {
    res.writeHead(404);
    res.end();
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_not_started', { apiUrl });
    assert.deepStrictEqual(result, { ready: false, error: null });
  });
});

test('ready=false cuando MediaMTX dice ready:false aunque el path ya exista', async () => {
  await withServer((req, res) => {
    sendJson(res, 200, { name: 'pv_x', ready: false, source: null, tracks: [] });
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_x', { apiUrl });
    assert.deepStrictEqual(result, { ready: false, error: null });
  });
});

test('ready=false cuando hay source/ready pero sin ninguna pista todavia', async () => {
  await withServer((req, res) => {
    sendJson(res, 200, { name: 'pv_x', ready: true, source: { type: 'srtSource' }, tracks: [] });
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_x', { apiUrl });
    assert.deepStrictEqual(result, { ready: false, error: null });
  });
});

test('ready=null (desconocido) ante una respuesta 500 del gateway', async () => {
  await withServer((req, res) => {
    res.writeHead(500);
    res.end();
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_x', { apiUrl });
    assert.deepStrictEqual(result, { ready: null, error: mediaApi.ERRORS.LIST_FAILED });
  });
});

test('ready=null ante una respuesta que no es JSON valido', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('esto no es json');
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_x', { apiUrl });
    assert.deepStrictEqual(result, { ready: null, error: mediaApi.ERRORS.INVALID_RESPONSE });
  });
});

test('ready=null y ninguna solicitud sale si la URL no es loopback (SSRF)', async () => {
  const fetchImpl = async () => { throw new Error('no deberia llamarse nunca'); };
  const result = await mediaApi.isPathPublisherReady('pv_x', {
    apiUrl: 'http://attacker.example:9997',
    fetchImpl,
  });
  assert.deepStrictEqual(result, { ready: null, error: mediaApi.ERRORS.INVALID_API_URL });
});

test('nunca se filtra el cuerpo crudo (lectores, bytes, IPs): solo el booleano derivado', async () => {
  await withServer((req, res) => {
    sendJson(res, 200, {
      ready: true,
      source: { type: 'srtSource' },
      tracks: ['H264'],
      readers: [{ type: 'webRTCSession', id: 'reader-1' }],
      bytesReceived: 999,
      bytesSent: 111,
    });
  }, async (apiUrl) => {
    const result = await mediaApi.isPathPublisherReady('pv_x', { apiUrl });
    assert.deepStrictEqual(Object.keys(result).sort(), ['error', 'ready']);
  });
});

test('un path vacio o invalido no genera ninguna solicitud', async () => {
  const fetchImpl = async () => { throw new Error('no deberia llamarse nunca'); };
  for (const invalid of ['', null, undefined, 42]) {
    const result = await mediaApi.isPathPublisherReady(invalid, { fetchImpl });
    assert.deepStrictEqual(result, { ready: null, error: mediaApi.ERRORS.INVALID_API_URL });
  }
});
