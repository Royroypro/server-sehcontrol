// Cliente interno de la API de control de MediaMTX 1.9.3.
//
// Se usa para una sola cosa: cerrar la conexion SRT del equipo cuando una
// previsualizacion termina. Sin esto, revocar el token solo impide NUEVOS
// handshakes -- la conexion ya establecida seguiria publicando video.
//
// La API de MediaMTX no tiene autenticacion propia, por eso el modulo se
// niega a hablar con cualquier cosa que no sea loopback: asi MEDIA_API_URL
// no se convierte en una via de SSRF si alguien la altera.
//
// Endpoints usados (verificados contra el tag v1.9.3, apidocs/openapi.yaml):
//   GET  /v3/srtconns/list?page=&itemsPerPage=   -> { pageCount, itemCount, items }
//   POST /v3/srtconns/kick/{id}                  -> 200 sin cuerpo, 404 si no existe
// El item trae { id, state: 'idle'|'read'|'publish', path, query, ... }.

const DEFAULT_API_URL = 'http://127.0.0.1:9997';
const DEFAULT_TIMEOUT_MS = 1500;
const ITEMS_PER_PAGE = 100;
// Tope defensivo: si MediaMTX devolviera un pageCount absurdo (o corrupto),
// no queremos quedarnos iterando.
const MAX_PAGES = 20;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Codigos de error acotados. Nunca se propaga el mensaje crudo de fetch ni
// el cuerpo de la respuesta: podrian arrastrar el query con el token.
const ERRORS = {
  INVALID_API_URL: 'invalid_api_url',
  LIST_FAILED: 'list_failed',
  INVALID_RESPONSE: 'invalid_response',
  KICK_FAILED: 'kick_failed',
  TIMEOUT: 'timeout',
  PAGE_LIMIT: 'page_limit',
};

// Devuelve la URL base normalizada, o null si no es aceptable.
// Exigencias: esquema http, host loopback, sin credenciales, sin query ni
// fragment, y puerto explicito o resuelto a 9997.
function resolveApiUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== '/') return null;
  const hostname = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return null;
  const port = url.port || '9997';
  if (!/^\d+$/.test(port)) return null;
  // Se reconstruye a proposito en vez de reutilizar la entrada: cualquier
  // parte no contemplada arriba queda descartada.
  const host = hostname === '::1' ? '[::1]' : hostname;
  return `http://${host}:${port}`;
}

function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

async function requestJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(ERRORS.LIST_FAILED);
    err.code = ERRORS.LIST_FAILED;
    throw err;
  }
  try {
    return await res.json();
  } catch (_) {
    const err = new Error(ERRORS.INVALID_RESPONSE);
    err.code = ERRORS.INVALID_RESPONSE;
    throw err;
  }
}

// Recorre las paginas de /v3/srtconns/list y devuelve solo los ids de las
// conexiones que estan PUBLICANDO ese path exacto. No se conserva ningun
// otro campo del item: `query` lleva el token y no debe salir de aca.
function validateListResponse(body, page) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!Number.isInteger(body.itemCount) || !Number.isFinite(body.itemCount) || body.itemCount < 0) {
    return false;
  }
  if (!Number.isInteger(body.pageCount) || !Number.isFinite(body.pageCount) || body.pageCount < 0) {
    return false;
  }
  if (!Array.isArray(body.items) || body.items.length > ITEMS_PER_PAGE) return false;
  if (body.pageCount !== Math.ceil(body.itemCount / ITEMS_PER_PAGE)) return false;

  const expectedLength = Math.max(
    0,
    Math.min(ITEMS_PER_PAGE, body.itemCount - page * ITEMS_PER_PAGE),
  );
  return body.items.length === expectedLength;
}

function listErrorCode(err) {
  return isTimeoutError(err) ? ERRORS.TIMEOUT : (err.code || ERRORS.LIST_FAILED);
}

async function collectPublisherIds(fetchImpl, baseUrl, path, timeoutMs) {
  const ids = new Set();
  let page = 0;
  let pageCount = 1;
  let pageLimitReached = false;

  while (page < pageCount && page < MAX_PAGES) {
    const url = `${baseUrl}/v3/srtconns/list?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}`;
    let body;
    try {
      body = await requestJson(fetchImpl, url, timeoutMs);
    } catch (err) {
      return {
        ids: [...ids],
        listError: listErrorCode(err),
        pageLimitReached,
      };
    }

    if (!validateListResponse(body, page)) {
      return {
        ids: [...ids],
        listError: ERRORS.INVALID_RESPONSE,
        pageLimitReached,
      };
    }

    for (const item of body.items) {
      // Coincidencia EXACTA de path y solo publishers: nunca se expulsa a un
      // lector, ni a un path parecido.
      if (item && item.state === 'publish' && item.path === path && typeof item.id === 'string' && item.id) {
        ids.add(item.id);
      }
    }

    pageCount = body.pageCount;
    if (pageCount > MAX_PAGES) pageLimitReached = true;
    page += 1;
  }

  return {
    ids: [...ids],
    listError: null,
    pageLimitReached,
  };
}

async function kickOne(fetchImpl, baseUrl, id, timeoutMs) {
  // encodeURIComponent sobre el id: viene de MediaMTX, pero no se concatena
  // crudo en una URL bajo ninguna circunstancia.
  const url = `${baseUrl}/v3/srtconns/kick/${encodeURIComponent(id)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 404 = la conexion ya no existe. Es exactamente el resultado deseado, no
  // un fallo: hace que la operacion sea idempotente.
  if (res.status === 404) return false;
  if (!res.ok) {
    const err = new Error(ERRORS.KICK_FAILED);
    err.code = ERRORS.KICK_FAILED;
    throw err;
  }
  return true;
}

// Expulsa a todos los publishers SRT de `path`.
//
// Devuelve siempre un resumen sin secretos:
//   { status: 'kicked' | 'not_found' | 'failed', matched, kicked, error? }
// Nunca lanza: el llamador la usa como "best effort" y no debe poder
// romper el cierre logico de una sesion.
async function kickSrtPublishersForPath(path, options = {}) {
  const {
    apiUrl = process.env.MEDIA_API_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  const summary = {
    status: 'failed',
    matched: 0,
    kicked: 0,
    already_gone: 0,
    failed: 0,
  };

  if (typeof path !== 'string' || !path) {
    return { ...summary, error: ERRORS.INVALID_API_URL };
  }

  const baseUrl = resolveApiUrl(apiUrl);
  if (!baseUrl) {
    // No se emite ninguna solicitud: una URL fuera de loopback no se consulta.
    return { ...summary, error: ERRORS.INVALID_API_URL };
  }
  if (typeof fetchImpl !== 'function') {
    return { ...summary, error: ERRORS.LIST_FAILED };
  }

  const {
    ids,
    listError,
    pageLimitReached,
  } = await collectPublisherIds(fetchImpl, baseUrl, path, timeoutMs);

  if (ids.length === 0 && !listError && !pageLimitReached) {
    return {
      status: 'not_found',
      matched: 0,
      kicked: 0,
      already_gone: 0,
      failed: 0,
      error: null,
    };
  }

  let kicked = 0;
  let alreadyGone = 0;
  let timeoutFailures = 0;
  let otherFailures = 0;
  for (const id of ids) {
    try {
      if (await kickOne(fetchImpl, baseUrl, id, timeoutMs)) {
        kicked += 1;
      } else {
        alreadyGone += 1;
      }
    } catch (err) {
      if (isTimeoutError(err)) timeoutFailures += 1;
      else otherFailures += 1;
    }
  }

  const failed = timeoutFailures + otherFailures;
  if (listError || pageLimitReached) {
    return {
      status: 'failed',
      matched: ids.length,
      kicked,
      already_gone: alreadyGone,
      failed,
      error: listError || ERRORS.PAGE_LIMIT,
    };
  }

  if (failed > 0) {
    let error = 'partial_failure';
    if (timeoutFailures === failed && kicked === 0 && alreadyGone === 0) {
      error = ERRORS.TIMEOUT;
    } else if (otherFailures === failed && kicked === 0 && alreadyGone === 0) {
      error = ERRORS.KICK_FAILED;
    }
    return {
      status: 'failed',
      matched: ids.length,
      kicked,
      already_gone: alreadyGone,
      failed,
      error,
    };
  }

  // Todos los publishers respondieron 404: ya no habia nada que cerrar.
  if (kicked === 0) {
    return {
      status: 'not_found',
      matched: ids.length,
      kicked: 0,
      already_gone: alreadyGone,
      failed: 0,
      error: null,
    };
  }
  return {
    status: 'kicked',
    matched: ids.length,
    kicked,
    already_gone: alreadyGone,
    failed: 0,
    error: null,
  };
}

// Consulta si el path de una sesion ya tiene un publisher confirmado por
// MediaMTX con al menos una pista. Se usa SOLO como optimizacion para
// decidir cuando conviene intentar el primer WHEP: el reintento de WHEP en
// el panel (ver public/admin/screenCamPreview.js) sigue siendo la red de
// seguridad real, este chequeo nunca debe bloquear la reproduccion si falla.
//
//   GET /v3/paths/get/{name} -> { name, ready, tracks, source, ... }
//
// Devuelve { ready: true|false|null, error }.
//   ready === true  -> hay un source activo con al menos una pista.
//   ready === false -> el path no existe todavia (404, caso normal mientras
//                      el cliente arranca) o MediaMTX dice que no esta listo.
//   ready === null  -> no se pudo determinar (timeout, URL invalida,
//                      respuesta invalida): "desconocido", nunca un error
//                      fatal para el llamador.
// Nunca se devuelve el cuerpo crudo de la respuesta: solo el booleano
// derivado. La lista de lectores/bytes/IPs de MediaMTX no debe salir de aca.
async function isPathPublisherReady(path, options = {}) {
  const {
    apiUrl = process.env.MEDIA_API_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof path !== 'string' || !path) return { ready: null, error: ERRORS.INVALID_API_URL };

  const baseUrl = resolveApiUrl(apiUrl);
  if (!baseUrl) return { ready: null, error: ERRORS.INVALID_API_URL };
  if (typeof fetchImpl !== 'function') return { ready: null, error: ERRORS.LIST_FAILED };

  const url = `${baseUrl}/v3/paths/get/${encodeURIComponent(path)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    return { ready: null, error: isTimeoutError(err) ? ERRORS.TIMEOUT : ERRORS.LIST_FAILED };
  }

  // El path todavia no existe: es el estado normal mientras el cliente
  // arranca el encoder y abre la conexion SRT. No es un error.
  if (res.status === 404) return { ready: false, error: null };
  if (!res.ok) return { ready: null, error: ERRORS.LIST_FAILED };

  let body;
  try {
    body = await res.json();
  } catch (_) {
    return { ready: null, error: ERRORS.INVALID_RESPONSE };
  }
  if (!body || typeof body !== 'object') return { ready: null, error: ERRORS.INVALID_RESPONSE };

  const trackCount = Array.isArray(body.tracks) ? body.tracks.length : 0;
  const ready = body.ready === true && body.source != null && trackCount > 0;
  return { ready, error: null };
}

module.exports = {
  kickSrtPublishersForPath,
  isPathPublisherReady,
  resolveApiUrl,
  DEFAULT_API_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_PAGES,
  ERRORS,
};
