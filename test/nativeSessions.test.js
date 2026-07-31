const {
  test,
  before,
  after,
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'sehcontrol-native-session-')
);

process.env.ADMIN_DB_PATH = path.join(tempDir, 'admin.sqlite3');
process.env.HBBS_DB_PATH = path.join(tempDir, 'hbbs-inexistente.sqlite3');
process.env.JWT_SECRET = 'prueba-sesiones-persistentes-2026';
process.env.NATIVE_SESSION_TTL_DAYS = '90';
process.env.NATIVE_SESSION_TOUCH_INTERVAL_HOURS = '24';

const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocket } = require('ws');

const db = require('../src/db/adminDb');
const nativeSessions = require('../src/nativeSessions');
const {
  hashPassword,
  issueToken,
} = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const adminRoutes = require('../src/routes/admin');
const hbbsRoutes = require('../src/routes/hbbsHttp');
const { initWebSocketServer } = require('../src/ws');

let server;
let wss;
let baseUrl;
let planId;
let admin;
let adminJwt;

function createUser({
  email,
  password,
  role = 'client',
}) {
  const result = db.prepare(`
    insert into users (
      email,
      password_hash,
      role,
      plan_id,
      status
    )
    values (?, ?, ?, ?, 'active')
  `).run(
    email,
    hashPassword(password),
    role,
    planId
  );

  return db.prepare(
    'select * from users where id = ?'
  ).get(result.lastInsertRowid);
}

function createDeviceAndSession(user, suffix) {
  const rustdeskId = `device-${suffix}`;
  const machineId = `machine-${suffix}`;

  db.prepare(`
    insert into devices (
      rustdesk_id,
      owner_user_id,
      machine_id,
      claim_source
    )
    values (?, ?, ?, 'test')
  `).run(rustdeskId, user.id, machineId);

  const token = nativeSessions.issueNativeSession(user, {
    rustdeskId,
    machineId,
  });

  return {
    token,
    rustdeskId,
    machineId,
  };
}

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token
        ? { authorization: `Bearer ${options.token}` }
        : {}),
      ...(options.cookie
        ? { cookie: `token=${options.cookie}` }
        : {}),
    },
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }

  return {
    status: response.status,
    body,
  };
}

function openAuthenticatedWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);

    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timeout esperando WebSocket autenticado'));
    }, 5000);

    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.once('message', (raw) => {
      clearTimeout(timeout);
      resolve({
        socket,
        message: JSON.parse(raw.toString()),
      });
    });
  });
}

function expectRejectedWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);

    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('El WebSocket inválido no fue rechazado'));
    }, 5000);

    socket.once('message', () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error('La sesión revocada recibió datos'));
    });

    socket.once('close', (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 4001);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

before(async () => {
  const plan = db.prepare(`
    insert into plans (
      name,
      max_devices,
      duration_days
    )
    values ('Plan pruebas sesiones', 20, 30)
  `).run();

  planId = plan.lastInsertRowid;

  admin = createUser({
    email: 'admin@test.local',
    password: 'AdminClave123',
    role: 'admin',
  });

  adminJwt = issueToken(admin);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', hbbsRoutes);

  server = app.listen(0, '127.0.0.1');
  wss = initWebSocketServer(server);

  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (wss) {
    await new Promise((resolve) => wss.close(resolve));
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  db.close();
  fs.rmSync(tempDir, {
    recursive: true,
    force: true,
  });
});

test('guarda solamente el hash y valida usuario y dispositivo', () => {
  const user = createUser({
    email: 'nucleo@test.local',
    password: 'ClaveNucleo123',
  });

  const {
    token,
    rustdeskId,
  } = createDeviceAndSession(user, 'nucleo');

  assert.match(token, /^sehns_/);

  const stored = db.prepare(`
    select
      id,
      token_hash,
      expires_at,
      revoked_at
    from native_sessions
    where user_id = ?
  `).get(user.id);

  assert.equal(stored.token_hash.length, 64);
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.revoked_at, null);

  const remaining = db.prepare(`
    select unixepoch(expires_at) - unixepoch('now') as seconds
    from native_sessions
    where id = ?
  `).get(stored.id).seconds;

  assert.ok(remaining > 89 * 86400);
  assert.ok(remaining <= 90 * 86400 + 5);

  const payload = nativeSessions.authenticateNativeSession(
    token,
    { touch: false }
  );

  assert.equal(payload.sub, user.id);
  assert.equal(payload.email, user.email);
  assert.equal(payload.auth_type, 'native_session');
  assert.equal(payload.rustdesk_id, rustdeskId);

  db.prepare(`
    delete from devices
    where rustdesk_id = ?
  `).run(rustdeskId);

  assert.equal(
    nativeSessions.authenticateNativeSession(
      token,
      { touch: false }
    ),
    null
  );

  assert.equal(
    nativeSessions.revokeNativeSessionToken(token),
    true
  );
});

test('login, HTTP, WebSocket, JWT antiguo y logout funcionan juntos', async () => {
  const user = createUser({
    email: 'integracion@test.local',
    password: 'ClaveIntegracion123',
  });

  const login = await request('/api/login', {
    method: 'POST',
    body: {
      username: user.email,
      password: 'ClaveIntegracion123',
      type: 'account',
      id: '485236790',
      uuid: 'uuid-test',
      deviceInfo: {
        name: 'Equipo de prueba',
        os: 'Windows',
        machine_id: 'machine-integration-001',
      },
    },
  });

  assert.equal(login.status, 200);
  assert.match(login.body.access_token, /^sehns_/);

  const nativeToken = login.body.access_token;

  const currentUser = await request('/api/currentUser', {
    method: 'POST',
    token: nativeToken,
    body: {},
  });

  assert.equal(currentUser.status, 200);
  assert.equal(currentUser.body.email, user.email);

  const legacyCurrentUser = await request('/api/currentUser', {
    method: 'POST',
    token: issueToken(user),
    body: {},
  });

  assert.equal(legacyCurrentUser.status, 200);
  assert.equal(legacyCurrentUser.body.email, user.email);

  const wsUrl =
    `ws://127.0.0.1:${server.address().port}/api/ws?token=` +
    encodeURIComponent(nativeToken);

  const connected = await openAuthenticatedWebSocket(wsUrl);
  assert.equal(connected.message.type, 'connected');

  const openSocketClosed = new Promise((resolve) => {
    connected.socket.once('close', (code, reason) => {
      resolve({
        code,
        reason: reason.toString(),
      });
    });
  });

  const logout = await request('/api/logout', {
    method: 'POST',
    token: nativeToken,
    body: {
      id: '485236790',
    },
  });

  assert.equal(logout.status, 200);

  const closeResult = await Promise.race([
    openSocketClosed,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            'El WebSocket abierto no se cerró después del logout'
          )
        );
      }, 2000);
    }),
  ]);

  assert.equal(closeResult.code, 4002);
  assert.equal(closeResult.reason, 'Sesion revocada');

  const afterLogout = await request('/api/currentUser', {
    method: 'POST',
    token: nativeToken,
    body: {},
  });

  assert.equal(afterLogout.status, 401);

  const remainingDevice = db.prepare(`
    select count(*) as total
    from devices
    where owner_user_id = ?
  `).get(user.id);

  assert.equal(remainingDevice.total, 0);

  await expectRejectedWebSocket(wsUrl);
});

test('contraseña y suspensión revocan las sesiones nativas', async () => {
  const ownUser = createUser({
    email: 'propio@test.local',
    password: 'ClaveAnterior123',
  });

  const ownSession = createDeviceAndSession(
    ownUser,
    'own-password'
  );

  const ownPasswordChange = await request('/api/auth/me', {
    method: 'PUT',
    cookie: issueToken(ownUser),
    body: {
      name: 'Usuario propio',
      current_password: 'ClaveAnterior123',
      new_password: 'ClaveNueva123',
    },
  });

  assert.equal(ownPasswordChange.status, 200);
  assert.equal(
    nativeSessions.authenticateNativeSession(
      ownSession.token,
      { touch: false }
    ),
    null
  );

  const managedUser = createUser({
    email: 'administrado@test.local',
    password: 'ClaveInicial123',
  });

  const managedSession = createDeviceAndSession(
    managedUser,
    'admin-password'
  );

  const adminPasswordChange = await request(
    `/api/admin/users/${managedUser.id}`,
    {
      method: 'PUT',
      cookie: adminJwt,
      body: {
        password: 'ClaveAdministrada123',
      },
    }
  );

  assert.equal(adminPasswordChange.status, 200);
  assert.equal(
    nativeSessions.authenticateNativeSession(
      managedSession.token,
      { touch: false }
    ),
    null
  );

  const suspendedUser = createUser({
    email: 'suspendido@test.local',
    password: 'ClaveSuspendida123',
  });

  const suspendedSession = createDeviceAndSession(
    suspendedUser,
    'suspension'
  );

  const suspension = await request(
    `/api/admin/users/${suspendedUser.id}`,
    {
      method: 'PUT',
      cookie: adminJwt,
      body: {
        status: 'suspended',
      },
    }
  );

  assert.equal(suspension.status, 200);

  const reactivation = await request(
    `/api/admin/users/${suspendedUser.id}`,
    {
      method: 'PUT',
      cookie: adminJwt,
      body: {
        status: 'active',
      },
    }
  );

  assert.equal(reactivation.status, 200);
  assert.equal(
    nativeSessions.authenticateNativeSession(
      suspendedSession.token,
      { touch: false }
    ),
    null
  );
});
