const crypto = require('crypto');
const db = require('./db/adminDb');

const TOKEN_PREFIX = 'sehns_';

function readIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} debe ser un entero entre ${minimum} y ${maximum}`
    );
  }
  return value;
}

// Una sesion puede permanecer activa mientras el dispositivo siga usandola.
// Para evitar escrituras SQLite en cada peticion, la fecha solo se desliza
// cuando paso este intervalo desde el ultimo uso registrado.
const SESSION_TTL_DAYS = readIntegerEnv(
  'NATIVE_SESSION_TTL_DAYS',
  90,
  1,
  365
);
const TOUCH_INTERVAL_HOURS = readIntegerEnv(
  'NATIVE_SESSION_TOUCH_INTERVAL_HOURS',
  24,
  1,
  168
);

function normalizeText(value, maximumLength) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, maximumLength) || null;
}

function isNativeSessionToken(token) {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueNativeSession(user, context = {}) {
  if (!user?.id) {
    throw new Error('Se requiere un usuario valido para crear la sesion');
  }

  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const sessionId = crypto.randomUUID();
  const rustdeskId = normalizeText(context.rustdeskId, 100);
  const machineId = normalizeText(context.machineId, 200);

  db.prepare(`
    insert into native_sessions (
      id,
      token_hash,
      user_id,
      rustdesk_id,
      machine_id,
      expires_at,
      last_used_at
    )
    values (?, ?, ?, ?, ?, datetime('now', ?), datetime('now'))
  `).run(
    sessionId,
    hashToken(token),
    user.id,
    rustdeskId,
    machineId,
    `+${SESSION_TTL_DAYS} days`
  );

  return token;
}

function authenticateNativeSession(token, options = {}) {
  if (!isNativeSessionToken(token)) return null;

  const row = db.prepare(`
    select
      s.id,
      s.user_id,
      s.rustdesk_id,
      s.machine_id,
      s.last_used_at,
      u.email,
      u.role,
      u.status,
      d.owner_user_id as current_device_owner
    from native_sessions s
    join users u on u.id = s.user_id
    left join devices d
      on d.rustdesk_id = s.rustdesk_id
      and d.owner_user_id = s.user_id
    where s.token_hash = ?
      and s.revoked_at is null
      and datetime(s.expires_at) > datetime('now')
  `).get(hashToken(token));

  if (!row || row.status !== 'active') return null;

  // Una sesion emitida para un equipo deja de servir en cuanto ese equipo
  // ya no pertenece al usuario, incluso aunque la fila aun no se haya borrado.
  if (row.rustdesk_id && row.current_device_owner == null) return null;

  if (options.touch !== false) {
    db.prepare(`
      update native_sessions
      set
        last_used_at = datetime('now'),
        expires_at = datetime('now', ?)
      where id = ?
        and last_used_at <= datetime('now', ?)
    `).run(
      `+${SESSION_TTL_DAYS} days`,
      row.id,
      `-${TOUCH_INTERVAL_HOURS} hours`
    );
  }

  return {
    sub: row.user_id,
    email: row.email,
    role: row.role,
    auth_type: 'native_session',
    session_id: row.id,
    rustdesk_id: row.rustdesk_id,
    machine_id: row.machine_id,
  };
}

function revokeNativeSessionToken(token) {
  if (!isNativeSessionToken(token)) return false;

  const result = db.prepare(`
    update native_sessions
    set revoked_at = datetime('now')
    where token_hash = ?
      and revoked_at is null
  `).run(hashToken(token));

  return result.changes > 0;
}

function revokeUserNativeSessions(userId) {
  return db.prepare(`
    update native_sessions
    set revoked_at = datetime('now')
    where user_id = ?
      and revoked_at is null
  `).run(userId).changes;
}

function revokeDeviceNativeSessions(userId, rustdeskId) {
  return db.prepare(`
    update native_sessions
    set revoked_at = datetime('now')
    where user_id = ?
      and rustdesk_id = ?
      and revoked_at is null
  `).run(userId, rustdeskId).changes;
}

module.exports = {
  isNativeSessionToken,
  issueNativeSession,
  authenticateNativeSession,
  revokeNativeSessionToken,
  revokeUserNativeSessions,
  revokeDeviceNativeSessions,
};
