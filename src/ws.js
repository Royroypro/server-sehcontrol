// Canal de tiempo real (WebSocket) para empujar mensajes/alertas y cambios
// de estado de membresia al cliente en el instante en que ocurren, en vez de
// que el cliente tenga que hacer polling. El polling documentado en
// docs/CLIENT_INTEGRATION.md sigue siendo valido como respaldo (si el
// websocket se cae, reconecta) pero ya no es la unica via.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const rustdeskKey = require('./rustdeskKey');

const JWT_SECRET = process.env.JWT_SECRET;

// user_id -> Set<WebSocket>. Un mismo usuario puede tener varias conexiones
// (varios dispositivos/clientes logueados a la vez).
const connections = new Map();

function addConnection(userId, ws) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
}

function removeConnection(userId, ws) {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(userId);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// Manda a un usuario especifico (todas sus conexiones abiertas).
function pushToUser(userId, payload) {
  const set = connections.get(userId);
  if (!set) return 0;
  for (const ws of set) send(ws, payload);
  return set.size;
}

// Manda a todos los usuarios conectados (para mensajes broadcast).
function pushToAll(payload) {
  let count = 0;
  for (const set of connections.values()) {
    for (const ws of set) { send(ws, payload); count++; }
  }
  return count;
}

function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/ws' });

  wss.on('connection', (ws, req) => {
    let userId = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.sub;
    } catch (_) {
      ws.close(4001, 'Token invalido o ausente');
      return;
    }

    addConnection(userId, ws);
    let serverKey = null;
    try {
      serverKey = rustdeskKey.getPublicKeyInfo();
    } catch (_) {
      // La conexion sigue siendo util aunque la key aun no este disponible.
    }
    send(ws, { type: 'connected', server_key: serverKey });

    ws.on('close', () => removeConnection(userId, ws));
    ws.on('error', () => removeConnection(userId, ws));
    // El canal es principalmente push server->cliente, pero ahora tambien
    // acepta eventos del cliente para las sesiones de previsualizacion de
    // ScreenCam (screen_cam.preview.*). Se responde ademas a un ping simple
    // por si algun proxy/NAT corta conexiones inactivas.
    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'ping') return send(ws, { type: 'pong' });
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (_) {
        return; // mensaje no valido: se ignora, no se rompe la conexion
      }
      handleClientEvent(userId, msg, ws);
    });
  });

  return wss;
}

// Eventos cliente -> servidor. Se requiere `require` diferido porque
// screenCamPreview importa este modulo (evita ciclo en tiempo de carga).
function handleClientEvent(userId, msg, socket) {
  const event = msg?.event;
  if (typeof event !== 'string' || !event.startsWith('screen_cam.preview.')) return;

  const preview = require('./screenCamPreview');
  const sessionId = typeof msg.session_id === 'string' ? msg.session_id : null;
  if (!sessionId) return;

  const statusByEvent = {
    'screen_cam.preview.connecting': null, // informativo, no cambia estado
    'screen_cam.preview.started': 'publishing',
    'screen_cam.preview.failed': 'failed',
    'screen_cam.preview.stopped': 'stopped',
  };
  if (!(event in statusByEvent)) return;
  const status = statusByEvent[event];
  if (!status) return;

  try {
    const updated = preview.updateFromClient(sessionId, { status, error: msg.error });
    if (updated) send(socket, { type: 'screen_cam.preview.state', data: updated });
  } catch (_) {
    // Un evento malformado del cliente no debe tumbar el websocket.
  }
}

module.exports = { initWebSocketServer, pushToUser, pushToAll };
