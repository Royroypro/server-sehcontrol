// Canal de tiempo real (WebSocket) para empujar mensajes/alertas y cambios
// de estado de membresia al cliente en el instante en que ocurren, en vez de
// que el cliente tenga que hacer polling. El polling documentado en
// docs/CLIENT_INTEGRATION.md sigue siendo valido como respaldo (si el
// websocket se cae, reconecta) pero ya no es la unica via.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

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
    send(ws, { type: 'connected' });

    ws.on('close', () => removeConnection(userId, ws));
    ws.on('error', () => removeConnection(userId, ws));
    // No se espera nada del cliente por este canal (es push server->cliente),
    // pero se responde a un ping simple por si algun cliente lo manda para
    // mantener viva la conexion a traves de proxies/NAT.
    ws.on('message', (raw) => {
      if (raw.toString() === 'ping') send(ws, { type: 'pong' });
    });
  });

  return wss;
}

module.exports = { initWebSocketServer, pushToUser, pushToAll };
