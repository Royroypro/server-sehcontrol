// Sesiones temporales de previsualizacion de video de ScreenCam
// (ver docs/CLIENT_INTEGRATION.md seccion 15).
//
// El servidor NUNCA se conecta al RTSP del equipo: esa URL vive en la red
// privada del cliente y no es alcanzable desde Internet. El flujo es al
// reves -- el cliente abre una conexion SALIENTE hacia el gateway
// multimedia publico cuando (y solo cuando) un admin pide ver.
//
//   Cliente Sehcontrol --publica H.264--> gateway (MediaMTX) --WebRTC--> navegador
//
// No se graba nada: el gateway solo retransmite. Esta tabla guarda quien
// pidio ver que equipo y cuando, como registro de auditoria.
const crypto = require('crypto');
const db = require('./db/adminDb');
const notifications = require('./notifications');
const ws = require('./ws');

// Limites de la primera version (seccion 12): una sesion por dispositivo,
// un admin mirando, 5 minutos maximos.
const SESSION_TTL_SECONDS = 300;
const STALE_WAITING_SECONDS = 120; // margen para captura, encoder y handshake inicial
const MAX_CLIENT_ERROR_LENGTH = 100;
const MAX_CLEANUP_ATTEMPTS = 3;
const EXPIRATION_CLEANUP_CONCURRENCY = 2;
const CLEANUP_BACKLOG_WARNING = 25;
const CLEANUP_BACKLOG_CRITICAL = 100;

// Duracion de sesion configurable (Configuracion > ScreenCam, solo admin).
// SESSION_TTL_SECONDS sigue siendo el default de toda la vida: una
// instalacion que nunca toco el ajuste se comporta exactamente igual que
// antes. Limites:
//   MIN 60s  -- lo que tarda un cliente en reaccionar al WS, arrancar el
//               capturador/encoder y completar el handshake SRT; menos que
//               esto vuelve inutilizable la previsualizacion casi siempre.
//   MAX 1800s (30 min) -- evita dejar una camara remota transmitiendo por
//               tiempo indefinido si alguien se olvida el modal abierto.
const PREVIEW_DURATION_MIN_SECONDS = 60;
const PREVIEW_DURATION_MAX_SECONDS = 1800;
const DEFAULT_PREVIEW_DURATION_SECONDS = SESSION_TTL_SECONDS;

function isValidPreviewDurationSeconds(seconds) {
  return Number.isInteger(seconds)
    && seconds >= PREVIEW_DURATION_MIN_SECONDS
    && seconds <= PREVIEW_DURATION_MAX_SECONDS;
}

// Sesiones YA CREADAS conservan su expires_at original (no se leen de nuevo
// aca): esta funcion solo se consulta al crear una sesion nueva.
function resolvePreviewDurationSeconds() {
  try {
    const row = db.prepare(
      'select screen_cam_preview_duration_seconds from platform_settings where id = 1',
    ).get();
    if (!row || !isValidPreviewDurationSeconds(row.screen_cam_preview_duration_seconds)) {
      return DEFAULT_PREVIEW_DURATION_SECONDS;
    }
    return row.screen_cam_preview_duration_seconds;
  } catch (_) {
    // Migracion no corrida todavia (columna ausente) u otra falla de
    // lectura: nunca debe romper la creacion de una sesion nueva por esto.
    return DEFAULT_PREVIEW_DURATION_SECONDS;
  }
}

function mediaConfig() {
  return {
    publishUrl: process.env.MEDIA_PUBLISH_URL || null,
    playbackBase: process.env.MEDIA_PLAYBACK_BASE || null,
  };
}

function previewError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getSession(sessionId) {
  return db.prepare('select * from screen_cam_preview_sessions where id = ?').get(sessionId);
}

// Estados "vivos": una sesion en cualquiera de estos ocupa el dispositivo.
const LIVE_STATUSES = ['creating', 'waiting_client', 'publishing', 'ready'];

function activeSessionFor(rustdeskId) {
  return db.prepare(`
    select * from screen_cam_preview_sessions
    where rustdesk_id = ? and status in (${LIVE_STATUSES.map(() => '?').join(',')})
      and expires_at > datetime('now')
    order by created_at desc limit 1
  `).get(rustdeskId, ...LIVE_STATUSES);
}

const expireByTtl = db.prepare(`
  update screen_cam_preview_sessions
  set status = 'expired',
      ended_at = coalesce(ended_at, datetime('now')),
      playback_url = null
  where status in ('creating','waiting_client','publishing','ready')
    and expires_at <= datetime('now')
  returning id, rustdesk_id
`);

const expireByInitialWait = db.prepare(`
  update screen_cam_preview_sessions
  set status = 'expired',
      ended_at = coalesce(ended_at, datetime('now')),
      playback_url = null
  where status in ('creating','waiting_client')
    and created_at <= datetime('now', '-${STALE_WAITING_SECONDS} seconds')
  returning id, rustdesk_id
`);

// La fase SQLite es sincronica y atomica. Las dos sentencias revalidan el
// estado al escribir; la segunda no puede recuperar filas que la primera ya
// dejo terminales. El Set es una defensa adicional ante resultados duplicados.
const expireSessionsInDatabase = db.transaction(() => {
  const expired = [];
  const seen = new Set();
  for (const [cause, rows] of [
    ['ttl', expireByTtl.all()],
    ['initial_wait', expireByInitialWait.all()],
  ]) {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      expired.push({ id: row.id, rustdesk_id: row.rustdesk_id, cause });
    }
  }
  return expired;
});

const expirationCleanupQueue = [];
const expirationCleanupIds = new Set();
const expirationCleanupOptions = new Map();
const expirationCleanupWaiters = [];
const expirationCleanupWarningEvents = [];
let expirationCleanupActiveWorkers = 0;
let expirationCleanupStartScheduled = false;
let expirationCleanupHighWatermark = 0;
let expirationCleanupCompleted = 0;
let expirationCleanupAbandoned = 0;
let expirationCleanupWarningAbove = false;
let expirationCleanupCriticalAbove = false;
let scheduleExpirationCleanupMicrotask = queueMicrotask;
let expirationCleanupNow = () => performance.now();

function expirationSessionRef(sessionId) {
  const prefix = String(sessionId).slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${prefix || 'invalid'}…`;
}

function expirationErrorCode(value) {
  const code = typeof value === 'string' ? value.slice(0, 40) : '';
  return /^[A-Za-z0-9_-]+$/.test(code) ? code : 'unexpected';
}

function safeExpirationLog(logger, message) {
  try {
    const result = logger(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // El logger tampoco puede detener la limpieza de las demas sesiones.
  }
}

function expirationCleanupDependencies(options = {}) {
  if (!options || typeof options !== 'object') options = {};
  const kick = typeof options.kickSrtPublishersForPath === 'function'
    ? options.kickSrtPublishersForPath
    : require('./mediaMtxApi').kickSrtPublishersForPath;
  return {
    kick,
    pushToUser: typeof options.pushToUser === 'function' ? options.pushToUser : ws.pushToUser,
    logger: typeof options.logger === 'function' ? options.logger : (message) => console.log(message),
    findOwnerByRustdeskId: typeof options.findOwnerByRustdeskId === 'function'
      ? options.findOwnerByRustdeskId
      : (rustdeskId) => db.prepare(
        'select owner_user_id from devices where rustdesk_id = ?',
      ).get(rustdeskId),
  };
}

function safeKickResult(result) {
  const status = result && ['kicked', 'not_found', 'failed'].includes(result.status)
    ? result.status : null;
  if (!status) return null;
  const matched = Number.isSafeInteger(result.matched) && result.matched >= 0 ? result.matched : 0;
  const kicked = Number.isSafeInteger(result.kicked) && result.kicked >= 0 ? result.kicked : 0;
  return {
    status,
    matched,
    kicked,
    error: status === 'failed' ? expirationErrorCode(result.error) : null,
  };
}

function expirationCleanupLogMessage(task) {
  const kickResult = task.kickResult;
  const code = kickResult.status === 'failed'
    ? ` code=${expirationErrorCode(kickResult.error)}`
    : '';
  return `[screencam] operation=expiration-cleanup cause=${task.cause}`
    + ` session=${expirationSessionRef(task.id)} kick=${kickResult.status}`
    + ` matched=${kickResult.matched} kicked=${kickResult.kicked}${code}`;
}

function expirationCleanupAbandonedMessage(task, code) {
  return `[screencam] operation=expiration-cleanup cause=${task.cause}`
    + ` session=${expirationSessionRef(task.id)} cleanup_abandoned=1`
    + ` attempts=${task.attempts} code=${expirationErrorCode(code)}`;
}

function cleanupLoggerForAbandonment(task) {
  try {
    const options = expirationCleanupOptions.get(task.id);
    if (options && typeof options === 'object' && typeof options.logger === 'function') {
      return options.logger;
    }
  } catch (_) {
    // Una inyeccion rota no debe impedir el resumen sanitario final.
  }
  return (message) => console.log(message);
}

async function cleanExpiredSession(task) {
  task.attempts += 1;

  let dependencies;
  try {
    dependencies = expirationCleanupDependencies(expirationCleanupOptions.get(task.id));
  } catch (_) {
    return { retry: true, code: 'dependency_error' };
  }

  if (!task.kickCompleted) {
    let kickResult;
    try {
      kickResult = safeKickResult(await dependencies.kick(task.id));
    } catch (_) {
      return { retry: true, code: 'kick_exception' };
    }
    if (!kickResult) return { retry: true, code: 'kick_result_error' };
    task.kickResult = kickResult;
    task.kickCompleted = true;
  }

  if (!task.stopCompleted) {
    let device;
    try {
      device = await dependencies.findOwnerByRustdeskId(task.rustdesk_id);
    } catch (_) {
      return { retry: true, code: 'owner_lookup_error' };
    }

    if (device) {
      try {
        await dependencies.pushToUser(device.owner_user_id, {
          type: 'screen_cam.preview.stop',
          data: {
            session_id: task.id,
            rustdesk_id: task.rustdesk_id,
          },
        });
      } catch (_) {
        return { retry: true, code: 'websocket_error' };
      }
    }
    task.stopCompleted = true;
  }

  safeExpirationLog(dependencies.logger, expirationCleanupLogMessage(task));
  return { retry: false };
}

function finishExpirationCleanupTask(task) {
  expirationCleanupIds.delete(task.id);
  expirationCleanupOptions.delete(task.id);
}

function safeExpirationCleanupNow() {
  try {
    const value = expirationCleanupNow();
    return Number.isFinite(value) ? value : 0;
  } catch (_) {
    return 0;
  }
}

function oldestExpirationCleanupPendingMs(now = safeExpirationCleanupNow()) {
  if (expirationCleanupQueue.length === 0) return 0;
  let oldest = now;
  for (const task of expirationCleanupQueue) {
    if (task.enqueuedAt < oldest) oldest = task.enqueuedAt;
  }
  return Math.max(0, Math.floor(now - oldest));
}

function getExpirationCleanupStats() {
  return {
    pending: expirationCleanupQueue.length,
    active: expirationCleanupActiveWorkers,
    tracked: expirationCleanupIds.size,
    concurrency: EXPIRATION_CLEANUP_CONCURRENCY,
    oldest_pending_ms: oldestExpirationCleanupPendingMs(),
    high_watermark: expirationCleanupHighWatermark,
    completed: expirationCleanupCompleted,
    abandoned: expirationCleanupAbandoned,
  };
}

function backlogWarningMessage(event) {
  return `[screencam] operation=expiration-cleanup-backlog level=${event.level}`
    + ` pending=${event.pending} active=${event.active}`
    + ` high_watermark=${event.highWatermark}`
    + ` oldest_pending_ms=${event.oldestPendingMs}`;
}

function loggerForBacklogWarning(options) {
  try {
    if (options && typeof options === 'object' && typeof options.logger === 'function') {
      return options.logger;
    }
  } catch (_) {
    // Una inyeccion rota tampoco puede interrumpir el pool.
  }
  return (message) => console.log(message);
}

function flushExpirationCleanupWarnings() {
  const events = expirationCleanupWarningEvents.splice(0);
  for (const event of events) {
    safeExpirationLog(loggerForBacklogWarning(event.options), backlogWarningMessage(event));
  }
}

function recordExpirationCleanupBacklog(options) {
  const pending = expirationCleanupQueue.length;
  expirationCleanupHighWatermark = Math.max(expirationCleanupHighWatermark, pending);

  for (const [threshold, level, isAbove, setAbove] of [
    [
      CLEANUP_BACKLOG_WARNING,
      'warning',
      expirationCleanupWarningAbove,
      (value) => { expirationCleanupWarningAbove = value; },
    ],
    [
      CLEANUP_BACKLOG_CRITICAL,
      'critical',
      expirationCleanupCriticalAbove,
      (value) => { expirationCleanupCriticalAbove = value; },
    ],
  ]) {
    if (pending < threshold) {
      setAbove(false);
      continue;
    }
    if (isAbove) continue;
    setAbove(true);
    expirationCleanupWarningEvents.push({
      level,
      pending,
      active: expirationCleanupActiveWorkers,
      highWatermark: expirationCleanupHighWatermark,
      oldestPendingMs: oldestExpirationCleanupPendingMs(),
      options,
    });
  }
}

function refreshExpirationCleanupThresholdsAfterDequeue() {
  const pending = expirationCleanupQueue.length;
  if (pending < CLEANUP_BACKLOG_WARNING) expirationCleanupWarningAbove = false;
  if (pending < CLEANUP_BACKLOG_CRITICAL) expirationCleanupCriticalAbove = false;
}

function expirationCleanupIsIdle() {
  return expirationCleanupQueue.length === 0
    && expirationCleanupActiveWorkers === 0
    && !expirationCleanupStartScheduled;
}

function resolveExpirationCleanupWaitersIfIdle() {
  if (!expirationCleanupIsIdle()) return;
  const waiters = expirationCleanupWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

async function runExpirationCleanupWorker() {
  expirationCleanupActiveWorkers += 1;
  try {
    while (expirationCleanupQueue.length > 0) {
      const task = expirationCleanupQueue.shift();
      refreshExpirationCleanupThresholdsAfterDequeue();

      let outcome;
      try {
        outcome = await cleanExpiredSession(task);
      } catch (_) {
        outcome = { retry: true, code: 'worker_error' };
      }

      if (!outcome.retry) {
        expirationCleanupCompleted += 1;
        finishExpirationCleanupTask(task);
        continue;
      }

      if (task.attempts < MAX_CLEANUP_ATTEMPTS) {
        expirationCleanupQueue.push(task);
        recordExpirationCleanupBacklog(expirationCleanupOptions.get(task.id));
        continue;
      }

      safeExpirationLog(
        cleanupLoggerForAbandonment(task),
        expirationCleanupAbandonedMessage(task, outcome.code),
      );
      expirationCleanupAbandoned += 1;
      finishExpirationCleanupTask(task);
    }
  } finally {
    expirationCleanupActiveWorkers -= 1;
    scheduleExpirationCleanupStart();
    resolveExpirationCleanupWaitersIfIdle();
  }
}

function startAvailableExpirationCleanupWorkers() {
  while (expirationCleanupActiveWorkers < EXPIRATION_CLEANUP_CONCURRENCY
    && expirationCleanupQueue.length > 0) {
    runExpirationCleanupWorker().catch(() => {});
  }
}

function scheduleExpirationCleanupStart() {
  if (expirationCleanupStartScheduled
    || (expirationCleanupQueue.length === 0 && expirationCleanupWarningEvents.length === 0)) return;
  expirationCleanupStartScheduled = true;

  // El pool no descarta tareas: sin una cola durable o un reconciliador,
  // aplicar un limite de backlog podria dejar publishers ya expirados activos.
  try {
    scheduleExpirationCleanupMicrotask(() => {
      expirationCleanupStartScheduled = false;
      flushExpirationCleanupWarnings();
      startAvailableExpirationCleanupWorkers();
      resolveExpirationCleanupWaitersIfIdle();
    });
  } catch (_) {
    expirationCleanupStartScheduled = false;
  }
}

function enqueueExpirationCleanup(expired, options = {}) {
  for (const session of expired) {
    if (!session
      || typeof session.id !== 'string' || session.id.length === 0
      || typeof session.rustdesk_id !== 'string' || session.rustdesk_id.length === 0
      || !['ttl', 'initial_wait'].includes(session.cause)) continue;
    if (expirationCleanupIds.has(session.id)) continue;
    expirationCleanupQueue.push({
      id: session.id,
      rustdesk_id: session.rustdesk_id,
      cause: session.cause,
      attempts: 0,
      enqueuedAt: safeExpirationCleanupNow(),
    });
    expirationCleanupIds.add(session.id);
    expirationCleanupOptions.set(session.id, options);
    recordExpirationCleanupBacklog(options);
  }
  scheduleExpirationCleanupStart();
}

// Cierra en SQLite las sesiones vencidas antes de cualquier await y encola,
// sin bloquear al llamador, el kick SRT seguido del Stop al propietario.
// Sigue siendo oportunista: solo se llama al crear una preview y al autorizar
// handshakes, sin programar ejecuciones por su cuenta.
function expireStaleSessions(options = {}) {
  const expired = expireSessionsInDatabase();
  enqueueExpirationCleanup(expired, options);
  return { expired: expired.length };
}

function waitForExpirationCleanup() {
  if (expirationCleanupIsIdle()) return Promise.resolve();
  return new Promise((resolve) => {
    expirationCleanupWaiters.push(resolve);
  });
}

// Helpers acotados para probar fallos que no existen en la API productiva.
function enqueueExpirationCleanupForTests(sessions, options = {}) {
  enqueueExpirationCleanup(sessions, options);
}

function setExpirationCleanupMicrotaskForTests(scheduleMicrotask) {
  if (typeof scheduleMicrotask !== 'function') throw new TypeError('scheduleMicrotask invalido');
  const previous = scheduleExpirationCleanupMicrotask;
  scheduleExpirationCleanupMicrotask = scheduleMicrotask;
  return () => {
    scheduleExpirationCleanupMicrotask = previous;
  };
}

function setExpirationCleanupClockForTests(now) {
  if (typeof now !== 'function') throw new TypeError('now invalido');
  const previous = expirationCleanupNow;
  expirationCleanupNow = now;
  return () => {
    expirationCleanupNow = previous;
  };
}

function publicSession(row) {
  if (!row) return null;
  const expiresIn = Math.max(0, Math.round((new Date(row.expires_at) - new Date()) / 1000));
  return {
    session_id: row.id,
    device_id: row.rustdesk_id,
    status: row.status,
    expires_in: expiresIn,
    playback_url: row.playback_url || null,
    error: row.error || null,
  };
}

// Crea la sesion y le ordena al cliente, por WebSocket, que empiece a
// publicar. El token es temporal y reutilizable mientras la sesion siga viva;
// stopped, failed y expired impiden nuevos handshakes.
function startPreview(rustdeskId, requestedByUserId, options = {}) {
  expireStaleSessions(options.expirationCleanup);

  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) throw previewError('NOT_FOUND', 'Equipo no encontrado');

  const settings = db.prepare('select enabled, actual_state from device_screen_cam_settings where rustdesk_id = ?').get(rustdeskId);
  if (settings?.enabled !== 1) {
    throw previewError('NOT_ACTIVE', 'ScreenCam no esta activo en este equipo');
  }

  const existing = activeSessionFor(rustdeskId);
  if (existing) {
    throw previewError('ALREADY_ACTIVE', 'Ya hay una previsualizacion abierta para este equipo');
  }

  const { publishUrl } = mediaConfig();
  if (!publishUrl) {
    throw previewError('MEDIA_NOT_CONFIGURED', 'El gateway multimedia no esta configurado en este servidor (MEDIA_PUBLISH_URL)');
  }

  const sessionId = `pv_${crypto.randomBytes(5).toString('hex')}`;
  const publishToken = crypto.randomBytes(24).toString('base64url');
  const readToken = crypto.randomBytes(24).toString('base64url');
  // La duracion se resuelve UNA vez, al crear la sesion: cambiar el ajuste
  // despues no debe alterar expires_at de sesiones ya creadas.
  const durationSeconds = resolvePreviewDurationSeconds();
  db.prepare(`
    insert into screen_cam_preview_sessions (id, rustdesk_id, requested_by, status, publish_token, read_token, expires_at)
    values (?, ?, ?, 'waiting_client', ?, ?, datetime('now', '+' || ? || ' seconds'))
  `).run(sessionId, rustdeskId, requestedByUserId, publishToken, readToken, durationSeconds);

  notifications.logActivity(requestedByUserId, 'screen_cam_preview_started', 'device', rustdeskId,
    JSON.stringify({ session_id: sessionId }));

  // Formato { type, data }, igual que el resto de los eventos que empuja el
  // servidor (membership_status, message, screen_cam.update, server_key_changed).
  // Los eventos en sentido contrario -cliente->servidor, en src/ws.js- siguen
  // usando `event` en la raiz a proposito: son un canal distinto.
  ws.pushToUser(device.owner_user_id, {
    type: 'screen_cam.preview.start',
    data: {
      session_id: sessionId,
      rustdesk_id: rustdeskId,
      publish_url: publishUrl,
      publish_token: publishToken,
      // El nombre del stream que debe publicar: uno por sesion, para que un
      // token filtrado no sirva para mirar otra cosa ni despues de cerrada.
      stream_name: sessionId,
      expires_in: durationSeconds,
    },
  });

  return publicSession(getSession(sessionId));
}

// Los errores del cliente son codigos acotados, no texto libre: asi no se
// persisten URLs, tokens, objetos serializados ni caracteres de control.
function safeClientError(error) {
  if (error == null || error === '') return 'unknown';
  if (typeof error !== 'string') return null;
  const limited = error.slice(0, MAX_CLIENT_ERROR_LENGTH);
  return /^[A-Za-z0-9._-]+$/.test(limited) ? limited : 'unknown';
}

// `requested_by` no participa: identifica al admin que abrio la vista, no al
// propietario del dispositivo.
const authorizedLiveSession = db.prepare(`
  select s.*
  from screen_cam_preview_sessions s
  join devices d on d.rustdesk_id = s.rustdesk_id
  where s.id = ?
    and s.rustdesk_id = ?
    and d.owner_user_id = ?
    and s.status in ('creating','waiting_client','publishing','ready')
    and s.expires_at > datetime('now')
`);

const expireAuthorizedSession = db.prepare(`
  update screen_cam_preview_sessions
  set status = 'expired',
      playback_url = null,
      ended_at = coalesce(ended_at, datetime('now'))
  where id = ?
    and rustdesk_id = ?
    and status in ('creating','waiting_client','publishing','ready')
    and expires_at <= datetime('now')
    and exists (
      select 1 from devices
      where devices.rustdesk_id = screen_cam_preview_sessions.rustdesk_id
        and devices.owner_user_id = ?
    )
`);

const startAuthorizedSession = db.prepare(`
  update screen_cam_preview_sessions
  set status = ?,
      playback_url = case
        when ? is null then null
        else ? || id || '/whep?token=' || coalesce(read_token, '')
      end,
      started_at = coalesce(started_at, datetime('now'))
  where id = ?
    and rustdesk_id = ?
    and status = 'waiting_client'
    and expires_at > datetime('now')
    and exists (
      select 1 from devices
      where devices.rustdesk_id = screen_cam_preview_sessions.rustdesk_id
        and devices.owner_user_id = ?
    )
`);

const failAuthorizedSession = db.prepare(`
  update screen_cam_preview_sessions
  set status = 'failed',
      error = ?,
      playback_url = null,
      ended_at = coalesce(ended_at, datetime('now'))
  where id = ?
    and rustdesk_id = ?
    and status in ('waiting_client','publishing','ready')
    and expires_at > datetime('now')
    and exists (
      select 1 from devices
      where devices.rustdesk_id = screen_cam_preview_sessions.rustdesk_id
        and devices.owner_user_id = ?
    )
`);

const stopAuthorizedSession = db.prepare(`
  update screen_cam_preview_sessions
  set status = 'stopped',
      playback_url = null,
      ended_at = coalesce(ended_at, datetime('now'))
  where id = ?
    and rustdesk_id = ?
    and status in ('waiting_client','publishing','ready')
    and expires_at > datetime('now')
    and exists (
      select 1 from devices
      where devices.rustdesk_id = screen_cam_preview_sessions.rustdesk_id
        and devices.owner_user_id = ?
    )
`);

// Actualiza exclusivamente la sesion del dispositivo que pertenece al usuario
// autenticado. La transaccion es sincrona, corta y no contiene red ni WebSocket.
// Solo `started` devuelve estado: los terminales y los rechazos no producen un
// ACK distinguible desde fuera.
const updateFromClientForUserTx = db.transaction((userId, sessionId, rustdeskId, { status, error }) => {
  const expired = expireAuthorizedSession.run(sessionId, rustdeskId, userId);
  if (expired.changes > 0) return null;

  if (status === 'connecting') {
    authorizedLiveSession.get(sessionId, rustdeskId, userId);
    return null;
  }

  if (status === 'publishing') {
    const { playbackBase } = mediaConfig();
    const playbackPrefix = playbackBase ? `${playbackBase.replace(/\/$/, '')}/` : null;
    const nextStatus = playbackPrefix ? 'ready' : 'publishing';
    const changed = startAuthorizedSession.run(
      nextStatus,
      playbackPrefix,
      playbackPrefix,
      sessionId,
      rustdeskId,
      userId,
    );
    const session = authorizedLiveSession.get(sessionId, rustdeskId, userId);
    if (!session) return null;
    if (changed.changes === 0 && !['publishing', 'ready'].includes(session.status)) return null;
    return publicSession(session);
  }

  if (status === 'failed') {
    const safeError = safeClientError(error);
    if (safeError == null) return null;
    const changed = failAuthorizedSession.run(safeError, sessionId, rustdeskId, userId);
    if (changed.changes === 0) return null;
    return null;
  }

  if (status === 'stopped') {
    const changed = stopAuthorizedSession.run(sessionId, rustdeskId, userId);
    if (changed.changes === 0) return null;
  }
  return null;
});

function updateFromClientForUser(userId, sessionId, rustdeskId, update) {
  if (!Number.isInteger(userId)
    || typeof sessionId !== 'string' || sessionId.trim().length === 0
    || typeof rustdeskId !== 'string' || rustdeskId.trim().length === 0
    || !update || typeof update !== 'object'
    || !['connecting', 'publishing', 'failed', 'stopped'].includes(update.status)
    || (update.status === 'failed' && update.error != null && typeof update.error !== 'string')) {
    return null;
  }
  return updateFromClientForUserTx(userId, sessionId, rustdeskId, update);
}

// Prefijo seguro del id de sesion para los logs. El id completo identifica
// una sesion concreta; para diagnosticar alcanza con los primeros caracteres.
function sessionLogRef(sessionId) {
  return `${String(sessionId).slice(0, 8)}…`;
}

// Cierre explicito (el admin cerro la ventana o cambio de equipo).
//
// El orden importa: primero se cierra la sesion en la base -lo que hace que
// authorizeMedia rechace cualquier handshake nuevo al instante- y recien
// despues se intenta cerrar la conexion SRT que ya estuviera abierta. Asi,
// si MediaMTX no responde, la sesion igual queda cerrada.
async function stopPreview(sessionId, actorUserId, options = {}) {
  const { expectedRustdeskId } = options;
  if (typeof expectedRustdeskId !== 'string' || expectedRustdeskId.trim().length === 0) {
    throw previewError('NOT_FOUND', 'Sesion no encontrada');
  }

  const session = db.prepare(`
    select * from screen_cam_preview_sessions
    where id = ? and rustdesk_id = ?
  `).get(sessionId, expectedRustdeskId);
  if (!session) throw previewError('NOT_FOUND', 'Sesion no encontrada');

  // 1-4: cierre logico primero. A partir de aca ningun handshake nuevo pasa.
  db.prepare(`
    update screen_cam_preview_sessions
    set status = case when status in ('expired','failed') then status else 'stopped' end,
        playback_url = null,
        ended_at = coalesce(ended_at, datetime('now'))
    where id = ? and rustdesk_id = ?
  `).run(sessionId, expectedRustdeskId);

  // 5: expulsion best-effort del publisher que ya estuviera conectado.
  // Revocar el token no corta una conexion SRT establecida: eso solo lo
  // hace la API de control. Un fallo aca no revierte nada de lo anterior.
  const mediaApi = options.mediaApi || require('./mediaMtxApi');
  let kickResult = { status: 'failed', matched: 0, kicked: 0, error: 'not_attempted' };
  try {
    kickResult = await mediaApi.kickSrtPublishersForPath(sessionId, options.mediaApiOptions);
  } catch (err) {
    // kickSrtPublishersForPath no deberia lanzar, pero si lo hiciera no
    // puede tumbar el cierre de la sesion.
    kickResult = { status: 'failed', matched: 0, kicked: 0, error: 'kick_failed' };
  }
  // Log acotado: prefijo del id, resultado y cantidad. Nunca el path
  // completo, el token, ni el cuerpo de la respuesta de MediaMTX.
  console.log(
    `[screencam] preview stop ${sessionLogRef(sessionId)} kick=${kickResult.status}`
    + ` kicked=${kickResult.kicked}${kickResult.error ? ` error=${kickResult.error}` : ''}`,
  );

  // 6: aviso al cliente, en el formato { type, data }.
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(session.rustdesk_id);
  if (device) {
    ws.pushToUser(device.owner_user_id, {
      type: 'screen_cam.preview.stop',
      data: {
        session_id: sessionId,
        rustdesk_id: session.rustdesk_id,
      },
    });
  }
  notifications.logActivity(actorUserId, 'screen_cam_preview_stopped', 'device', session.rustdesk_id,
    JSON.stringify({ session_id: sessionId, kick: kickResult.status }));

  // 7: misma estructura publica de siempre. El detalle del kick no se
  // filtra a la respuesta HTTP.
  return publicSession(db.prepare(`
    select * from screen_cam_preview_sessions
    where id = ? and rustdesk_id = ?
  `).get(sessionId, expectedRustdeskId));
}

function getPreviewForDevice(sessionId, expectedRustdeskId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.trim().length === 0
    || typeof expectedRustdeskId !== 'string' || expectedRustdeskId.length === 0
    || expectedRustdeskId.trim().length === 0) {
    return null;
  }
  return publicSession(db.prepare(`
    select * from screen_cam_preview_sessions
    where id = ? and rustdesk_id = ?
  `).get(sessionId, expectedRustdeskId));
}

// Autorizacion que consulta el gateway multimedia (MediaMTX, authHTTPAddress)
// antes de aceptar una publicacion o una lectura. Reglas:
//   - el "path" del stream debe ser exactamente el id de una sesion viva;
//   - publicar exige el publish_token (solo lo conoce el equipo);
//   - leer exige el read_token (solo lo conoce el navegador del admin).
// Un token filtrado de un lado no sirve para el otro, y ninguno sirve una
// vez que la sesion expiro o se cerro.
function authorizeMedia({
  action, path, token, expirationCleanup,
}) {
  expireStaleSessions(expirationCleanup);
  if (!path || !token) return false;
  const session = getSession(path);
  if (!session) return false;
  if (!LIVE_STATUSES.includes(session.status)) return false;
  if (new Date(session.expires_at) <= new Date()) return false;

  if (action === 'publish') return token === session.publish_token;
  if (action === 'read') return token === session.read_token;
  return false;
}

module.exports = {
  SESSION_TTL_SECONDS,
  PREVIEW_DURATION_MIN_SECONDS,
  PREVIEW_DURATION_MAX_SECONDS,
  DEFAULT_PREVIEW_DURATION_SECONDS,
  isValidPreviewDurationSeconds,
  resolvePreviewDurationSeconds,
  MAX_CLEANUP_ATTEMPTS,
  EXPIRATION_CLEANUP_CONCURRENCY,
  CLEANUP_BACKLOG_WARNING,
  CLEANUP_BACKLOG_CRITICAL,
  startPreview,
  stopPreview,
  getPreviewForDevice,
  updateFromClientForUser,
  activeSessionFor,
  expireStaleSessions,
  waitForExpirationCleanup,
  getExpirationCleanupStats,
  enqueueExpirationCleanupForTests,
  setExpirationCleanupMicrotaskForTests,
  setExpirationCleanupClockForTests,
  authorizeMedia,
  mediaConfig,
};
