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
const STALE_WAITING_SECONDS = 60; // si el cliente nunca publica, se cierra sola

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

// Cierra sesiones vencidas o colgadas. Se llama al crear/consultar, en vez
// de tener un cron aparte: el volumen es bajo y asi no hay estado que se
// quede sucio si el proceso se reinicia.
function expireStaleSessions() {
  db.prepare(`
    update screen_cam_preview_sessions
    set status = 'expired', ended_at = datetime('now')
    where status in ('creating','waiting_client','publishing','ready') and expires_at <= datetime('now')
  `).run();
  db.prepare(`
    update screen_cam_preview_sessions
    set status = 'expired', ended_at = datetime('now')
    where status in ('creating','waiting_client')
      and created_at <= datetime('now', '-${STALE_WAITING_SECONDS} seconds')
  `).run();
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
// publicar. El token es de un solo uso y muere con la sesion.
function startPreview(rustdeskId, requestedByUserId) {
  expireStaleSessions();

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
  db.prepare(`
    insert into screen_cam_preview_sessions (id, rustdesk_id, requested_by, status, publish_token, read_token, expires_at)
    values (?, ?, ?, 'waiting_client', ?, ?, datetime('now', '+${SESSION_TTL_SECONDS} seconds'))
  `).run(sessionId, rustdeskId, requestedByUserId, publishToken, readToken);

  notifications.logActivity(requestedByUserId, 'screen_cam_preview_started', 'device', rustdeskId,
    JSON.stringify({ session_id: sessionId }));

  ws.pushToUser(device.owner_user_id, {
    event: 'screen_cam.preview.start',
    session_id: sessionId,
    rustdesk_id: rustdeskId,
    publish_url: publishUrl,
    publish_token: publishToken,
    // El nombre del stream que debe publicar: uno por sesion, para que un
    // token filtrado no sirva para mirar otra cosa ni despues de cerrada.
    stream_name: sessionId,
    expires_in: SESSION_TTL_SECONDS,
  });

  return publicSession(getSession(sessionId));
}

// El cliente confirma por WS que empezo/fallo a publicar. Cuando publica,
// recien ahi se arma la URL de reproduccion para el navegador.
function updateFromClient(sessionId, { status, error }) {
  const session = getSession(sessionId);
  if (!session) return null;

  if (status === 'publishing' || status === 'ready') {
    const { playbackBase } = mediaConfig();
    const playbackUrl = playbackBase
      ? `${playbackBase.replace(/\/$/, '')}/${session.id}/whep?token=${encodeURIComponent(session.read_token || '')}`
      : null;
    db.prepare(`
      update screen_cam_preview_sessions
      set status = ?, playback_url = ?, started_at = coalesce(started_at, datetime('now'))
      where id = ?
    `).run(playbackUrl ? 'ready' : 'publishing', playbackUrl, sessionId);
  } else if (status === 'failed') {
    db.prepare(`
      update screen_cam_preview_sessions set status = 'failed', error = ?, ended_at = datetime('now') where id = ?
    `).run(String(error || 'unknown').slice(0, 200), sessionId);
  } else if (status === 'stopped') {
    db.prepare(`
      update screen_cam_preview_sessions set status = 'stopped', ended_at = datetime('now') where id = ?
    `).run(sessionId);
  }
  return publicSession(getSession(sessionId));
}

// Cierre explicito (el admin cerro la ventana, cambio de equipo, o expiro).
// Invalida el token y le ordena al cliente que deje de publicar.
function stopPreview(sessionId, actorUserId) {
  const session = getSession(sessionId);
  if (!session) throw previewError('NOT_FOUND', 'Sesion no encontrada');

  db.prepare(`
    update screen_cam_preview_sessions
    set status = case when status in ('expired','failed') then status else 'stopped' end,
        playback_url = null,
        ended_at = coalesce(ended_at, datetime('now'))
    where id = ?
  `).run(sessionId);

  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(session.rustdesk_id);
  if (device) {
    ws.pushToUser(device.owner_user_id, {
      event: 'screen_cam.preview.stop',
      session_id: sessionId,
      rustdesk_id: session.rustdesk_id,
    });
  }
  notifications.logActivity(actorUserId, 'screen_cam_preview_stopped', 'device', session.rustdesk_id,
    JSON.stringify({ session_id: sessionId }));
  return publicSession(getSession(sessionId));
}

function statusOf(sessionId) {
  expireStaleSessions();
  return publicSession(getSession(sessionId));
}

// Autorizacion que consulta el gateway multimedia (MediaMTX, authHTTPAddress)
// antes de aceptar una publicacion o una lectura. Reglas:
//   - el "path" del stream debe ser exactamente el id de una sesion viva;
//   - publicar exige el publish_token (solo lo conoce el equipo);
//   - leer exige el read_token (solo lo conoce el navegador del admin).
// Un token filtrado de un lado no sirve para el otro, y ninguno sirve una
// vez que la sesion expiro o se cerro.
function authorizeMedia({ action, path, token }) {
  expireStaleSessions();
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
  startPreview,
  stopPreview,
  statusOf,
  updateFromClient,
  activeSessionFor,
  expireStaleSessions,
  authorizeMedia,
  mediaConfig,
};
