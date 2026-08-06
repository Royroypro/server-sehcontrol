// Implementa el subconjunto del protocolo HTTP que el cliente nativo de RustDesk usa
// para el boton de "Login" y la libreta de direcciones "legacy" (ver
// flutter/lib/models/user_model.dart, flutter/lib/common/hbbs/hbbs.dart y
// flutter/lib/models/ab_model.dart -> class LegacyAb, del repo rustdesk/rustdesk).
//
// Cubre: /api/login, /api/login-options, /api/logout, /api/currentUser,
// /api/ab (legacy address book: lista plana, sin grupos ni compartidos),
// y /api/sysinfo + /api/heartbeat (info del equipo y "ultima vez visto":
// el cliente stock ya los llama solo, sin ningun parche, ver mas abajo).
// /api/ab/personal, /api/ab/settings y /api/ab/shared/profiles se dejan en 404
// a proposito: eso hace que el cliente entre en "legacy mode" y use /api/ab,
// evitando implementar el protocolo completo de address books compartidos/grupos.
const express = require('express');
const db = require('../db/adminDb');
const hbbsDb = require('../db/hbbsDb');
const deviceClaim = require('../deviceClaim');
const notifications = require('../notifications');
const screenCamPolicy = require('../screenCamPolicy');
const nativeSessions = require('../nativeSessions');
const {
  closeNativeSessionConnections,
  closeDeviceConnections,
} = require('../ws');
const { verifyPassword, requireBearerAuth } = require('../auth');

const router = express.Router();

// display_name lleva el nombre de la cuenta, y nada mas.
//
// Antes cargaba el aviso de membresia ("⚠ Plan vence en N dia(s)"), porque la
// pestana Ajustes -> Account del cliente solo muestra display_name y el email
// y no hay campo nativo para avisar ahi. Tenia dos problemas serios:
//
// 1. display_name NO se queda en esa pantalla: es el nombre de la cuenta en
//    toda la app. El aviso aparecia como nombre del usuario en el chat y en
//    la lista de conexiones entrantes del equipo controlado, donde no pinta
//    nada y ademas tapa el nombre real.
//
// 2. El cliente lo cachea en disco y solo lo reescribe cuando
//    /api/currentUser responde bien. Un aviso emitido cuando faltaban 4 dias
//    sobrevivia a la renovacion del plan: el equipo seguia anunciandose como
//    "Plan vence en 4 dia(s)" con 368 dias por delante, y no se corregia solo.
//
// El aviso viaja por /api/membership/status y por el push de WebSocket, que
// es donde debe estar: el cliente lo pinta en el banner de la pantalla
// principal (buildMembershipBanner, tanto en escritorio como en movil) y ese
// canal se refresca cada 15 minutos, asi que no puede quedarse pegado.
function toUserPayload(user) {
  return {
    name: user.email,
    display_name: user.name || '',
    avatar: '',
    email: user.email,
    note: '',
    status: user.status === 'active' ? 1 : 0,
    is_admin: user.role === 'admin',
  };
}

function normalizeUuid(uuid) {
  if (uuid == null) return null;
  if (typeof uuid === 'string') return uuid.trim().slice(0, 500) || null;
  try {
    return JSON.stringify(uuid).slice(0, 500);
  } catch (_) {
    return String(uuid).slice(0, 500);
  }
}

// Lista de pantallas conectadas que reporta el cliente. Se normaliza campo
// por campo (en vez de guardar el JSON crudo) para que el panel siempre lea
// la misma forma, sin importar que agregue el cliente mas adelante.
function normalizeDisplays(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 16).map((d) => ({
    display_id: typeof d?.display_id === 'string' ? d.display_id.slice(0, 200) : null,
    name: typeof d?.name === 'string' ? d.name.slice(0, 200) : null,
    index: Number.isInteger(d?.index) ? d.index : null,
    width: Number.isInteger(d?.width) ? d.width : null,
    height: Number.isInteger(d?.height) ? d.height : null,
    primary: d?.primary === true,
    connected: d?.connected !== false,
  })).filter((d) => d.display_id);
}

// Identificador de hardware estable que manda el cliente parchado en
// deviceInfo.machine_id (machine-id/MachineGuid/IOPlatformUUID, ya hasheado
// del lado cliente). Sobrevive a una reinstalacion; el rustdesk_id no.
function normalizeMachineId(machineId) {
  if (typeof machineId !== 'string') return null;
  return machineId.trim().slice(0, 200) || null;
}

function saveLoginDeviceInfo({ id, uuid, deviceInfo, user, machineId }) {
  const normalizedUuid = normalizeUuid(uuid);
  db.prepare(`
    update devices set rustdesk_uuid = coalesce(?, rustdesk_uuid),
      machine_id = coalesce(?, machine_id)
    where rustdesk_id = ? and owner_user_id = ?
  `).run(normalizedUuid, machineId, id, user.id);

  const hostname = typeof deviceInfo?.name === 'string' ? deviceInfo.name.trim() : null;
  const platform = typeof deviceInfo?.os === 'string' ? deviceInfo.os.trim() : null;
  db.prepare(`
    insert into device_sysinfo (rustdesk_id, hostname, os, username, last_heartbeat_at, updated_at)
    values (?, ?, ?, ?, datetime('now'), datetime('now'))
    on conflict(rustdesk_id) do update set
      hostname = coalesce(nullif(excluded.hostname, ''), device_sysinfo.hostname),
      os = coalesce(nullif(excluded.os, ''), device_sysinfo.os),
      username = coalesce(nullif(excluded.username, ''), device_sysinfo.username),
      last_heartbeat_at = datetime('now'),
      updated_at = datetime('now')
  `).run(id, hostname, platform, user.email);

  notifications.logActivity(
    user.id,
    'device_login',
    'device',
    id,
    JSON.stringify({
      uuid: normalizedUuid,
      platform: platform || null,
      hostname: hostname || null,
      username: user.email,
    }),
  );
}

router.get('/login-options', (req, res) => {
  res.json([]); // sin SSO/OIDC: el cliente solo muestra el formulario usuario/clave
});

router.post('/login', (req, res) => {
  const { username, password, type, id, uuid, deviceInfo } = req.body || {};
  if (type && !['account', undefined].includes(type)) {
    return res.status(400).json({ error: 'Metodo de login no soportado por este servidor' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'username y password son requeridos' });
  }
  const user = db.prepare('select * from users where email = ?').get(String(username).toLowerCase().trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(400).json({ error: 'Usuario o contrasena incorrectos' });
  }
  if (user.status !== 'active') {
    return res.status(400).json({ error: 'Cuenta suspendida' });
  }

  const rustdeskId = id ? String(id).trim() : null;
  const machineId = normalizeMachineId(deviceInfo?.machine_id);

  // Auto-asociacion: el propio login ya manda el ID del equipo desde el que
  // se loguean (protocolo estandar, sin parche). Si el equipo no tiene dueno
  // todavia, se reclama solo para esta cuenta -- asi el cliente no tiene que
  // ir al panel web a "reclamar" nada a mano. Si ya no quedan cupos del plan,
  // se rechaza el login (sin emitir token) con un mensaje explicito.
  if (rustdeskId) {
    const owner = deviceClaim.getDeviceOwner(rustdeskId);
    if (owner && owner.owner_user_id !== user.id) {
      return res.status(403).json({ error: 'Este equipo ya esta asociado a otra cuenta. Contacta al administrador.' });
    }
    if (!owner) {
      // Antes de tratarlo como equipo nuevo: si esta cuenta ya tiene un
      // equipo reclamado con el mismo machine_id (misma maquina fisica,
      // ej. RustDesk reinstalado con un id nuevo), reasignar ese registro
      // en vez de crear uno nuevo -- no consume cupo y conserva alias/tags.
      const previous = machineId ? deviceClaim.findDeviceByMachineId(user.id, machineId) : null;
      if (previous && previous.rustdesk_id !== rustdeskId) {
        deviceClaim.migrateDeviceId(previous.rustdesk_id, rustdeskId, user.id);
      } else {
        const limit = deviceClaim.planLimitFor(user.id);
        const current = deviceClaim.countDevices(user.id);
        if (current >= limit) {
          return res.status(403).json({
            error: `Alcanzaste el limite de ${limit} equipo(s) de tu plan. Cierra sesion en otro equipo para poder ingresar aqui.`,
          });
        }
        deviceClaim.claimDevice(user.id, rustdeskId, null, {
          actorUserId: user.id,
          source: 'native_login',
        });
      }
    }
    saveLoginDeviceInfo({ id: rustdeskId, uuid, deviceInfo, user, machineId });
  }

  const token = nativeSessions.issueNativeSession(user, {
    rustdeskId,
    machineId,
  });
  res.json({
    access_token: token,
    type: 'access_token',
    tfa_type: '',
    secret: '',
    user: toUserPayload(user),
  });
});

router.post('/logout', requireBearerAuth, (req, res) => {
  // Revoca primero la credencial utilizada en esta solicitud. Los clientes
  // antiguos que aun tengan JWT continuan hasta su vencimiento natural.
  nativeSessions.revokeNativeSessionToken(req.authToken);
  closeNativeSessionConnections(req.user.session_id);

  // Libera el cupo y revoca las demas sesiones asociadas al dispositivo.
  const { id } = req.body || {};
  if (id) {
    const rustdeskId = String(id).trim();

    nativeSessions.revokeDeviceNativeSessions(
      req.user.sub,
      rustdeskId
    );
    closeDeviceConnections(req.user.sub, rustdeskId);

    const released = deviceClaim.releaseDevice(
      req.user.sub,
      rustdeskId
    );

    if (released) {
      notifications.logActivity(
        null,
        'device_released_on_logout',
        'user',
        req.user.sub,
        rustdeskId
      );
    }
  }

  res.json({});
});

router.post('/currentUser', requireBearerAuth, (req, res) => {
  const user = db.prepare('select * from users where id = ?').get(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  res.json(toUserPayload(user));
});

// "Cabinas" y "Clientes" son tags reservados/de sistema: siempre existen
// para todas las cuentas (aunque no tengan ningun equipo todavia) y el
// servidor los vuelve a agregar en cada respuesta sin importar lo que mande
// el cliente -- asi no se pueden borrar ni renombrar via la API (ver POST
// mas abajo, que ignora el listado de tags que manda el cliente).
const RESERVED_TAGS = ['Cabinas', 'Clientes'];

function safeParseTags(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
  } catch (_) {
    return [];
  }
}

function normalizePlatform(value) {
  const platform = String(value || '').trim();
  const lower = platform.toLowerCase();
  if (lower.includes('android')) return 'Android';
  if (lower.includes('windows')) return 'Windows';
  if (lower.includes('linux')) return 'Linux';
  if (lower.includes('mac os') || lower.includes('macos') || lower.includes('darwin') || lower.includes('os x')) {
    return 'Mac OS';
  }
  return platform;
}

// Libreta de direcciones "legacy" (pestana Address Book del cliente): lista
// plana de los equipos reclamados por el usuario logueado, con tags.
router.get('/ab', requireBearerAuth, (req, res) => {
  const devices = db.prepare(`
    select d.rustdesk_id, d.alias, d.tags, s.hostname, s.username, s.os,
           u.email as owner_email
    from devices d left join device_sysinfo s on s.rustdesk_id = d.rustdesk_id
    join users u on u.id = d.owner_user_id
    where d.owner_user_id = ?
  `).all(req.user.sub);

  // Un registro administrativo sin peer en hbbs no representa un dispositivo
  // registrado. Se omite de la libreta para que no reaparezca como contacto
  // fantasma; el admin puede localizarlo y borrarlo mediante el endpoint audit.
  const registeredDevices = devices.filter((d) => (
    !hbbsDb.isAvailable() || hbbsDb.peerExists(d.rustdesk_id)
  ));

  const peers = registeredDevices.map((d) => ({
    id: d.rustdesk_id,
    username: d.username || d.owner_email || '',
    hostname: d.hostname || '',
    platform: normalizePlatform(d.os),
    alias: d.alias || '',
    tags: safeParseTags(d.tags),
    hash: '',
  }));

  // Union de los tags reservados + cualquier otro tag que ya este en uso,
  // para no perder tags custom si alguna vez se agregan mas adelante.
  const allTags = new Set(RESERVED_TAGS);
  for (const p of peers) for (const t of p.tags) allTags.add(t);

  res.json({
    licensed_devices: 0,
    data: JSON.stringify({ tags: [...allTags], peers, tag_colors: '{}' }),
  });
});

// El cliente RustDesk (sin ningun parche) ya manda esto solo, siempre que el
// api-server configurado no sea rustdesk.com (ver src/common.rs::is_public
// y src/hbbs_http/sync.rs del repo rustdesk/rustdesk). No requiere login de
// cuenta -- va identificado solo por el id/uuid del dispositivo, igual que
// en el protocolo real.
router.post('/sysinfo', (req, res) => {
  const {
    id, cpu, memory, version,
    os, platform,
    hostname, device_name, name,
    username, user_name,
  } = req.body || {};
  if (!id) return res.status(400).send('ID_NOT_FOUND');
  const resolvedHostname = hostname || device_name || name || null;
  const resolvedUsername = username || user_name || null;
  const resolvedOs = os || platform || null;
  db.prepare(`
    insert into device_sysinfo (rustdesk_id, hostname, os, cpu, memory, username, client_version, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    on conflict(rustdesk_id) do update set
      hostname = coalesce(nullif(excluded.hostname, ''), device_sysinfo.hostname),
      os = coalesce(nullif(excluded.os, ''), device_sysinfo.os),
      cpu = coalesce(nullif(excluded.cpu, ''), device_sysinfo.cpu),
      memory = coalesce(nullif(excluded.memory, ''), device_sysinfo.memory),
      username = coalesce(nullif(excluded.username, ''), device_sysinfo.username),
      client_version = coalesce(nullif(excluded.client_version, ''), device_sysinfo.client_version),
      updated_at = datetime('now')
  `).run(id, resolvedHostname, resolvedOs, cpu || null, memory || null, resolvedUsername, version || null);
  res.send('SYSINFO_UPDATED'); // string exacto que el cliente espera para dejar de reintentar
});

// Heartbeat cada ~15s mientras el cliente esta abierto (con o sin conexiones
// activas). Se usa solo para "ultima vez visto" -> estado en linea real,
// mejor que lo que hbbs por si solo puede ofrecer (no persiste eso).
// Reporte opcional de estado real de ScreenCam, mandado dentro del mismo
// heartbeat que ya existe (no hace falta un endpoint nuevo): { screen_cam:
// { actual_state, encoder, last_error, rtsp_clients } }. Es solo lectura de
// estado -- el cliente no decide "licensed"/"desired_state" aca, eso lo
// resuelve el servidor en /api/client-policy.
router.post('/heartbeat', (req, res) => {
  const { id, screen_cam: screenCam } = req.body || {};
  if (id) {
    db.prepare(`
      update device_sysinfo set last_heartbeat_at = datetime('now') where rustdesk_id = ?
    `).run(id);
    // Si el dispositivo aun no habia mandado /api/sysinfo (poco probable,
    // pero el heartbeat puede llegar primero), se crea la fila igual para
    // que el "en linea" ya funcione aunque falten los demas datos.
    db.prepare(`
      insert into device_sysinfo (rustdesk_id, last_heartbeat_at) values (?, datetime('now'))
      on conflict(rustdesk_id) do nothing
    `).run(id);

    if (screenCam && typeof screenCam === 'object') {
      const localIp = typeof screenCam.local_ip === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(screenCam.local_ip.trim())
        ? screenCam.local_ip.trim()
        : null;
      const rtspPort = Number.isInteger(screenCam.rtsp_port) && screenCam.rtsp_port > 0 && screenCam.rtsp_port < 65536
        ? screenCam.rtsp_port
        : null;
      screenCamPolicy.reportDeviceState(id, {
        actualState: typeof screenCam.actual_state === 'string' ? screenCam.actual_state.slice(0, 20) : null,
        encoder: typeof screenCam.encoder === 'string' ? screenCam.encoder.slice(0, 50) : null,
        lastError: typeof screenCam.last_error === 'string' ? screenCam.last_error.slice(0, 300) : null,
        rtspClients: Number.isInteger(screenCam.rtsp_clients) ? screenCam.rtsp_clients : null,
        localIp,
        rtspPort,
        // Lo que el cliente aplico de verdad (credenciales RTSP), para que
        // el panel pueda detectar si una desconfiguracion dejo el stream
        // sin autenticacion pese a que se le mandaron credenciales.
        authEnabled: typeof screenCam.auth_enabled === 'boolean' ? screenCam.auth_enabled : null,
        reportedRtspUser: typeof screenCam.rtsp_user === 'string' ? screenCam.rtsp_user.slice(0, 50) : null,
        // Pantallas conectadas + cual esta capturando de verdad. Se acota el
        // tamano de la lista para que un cliente con datos raros no infle la
        // fila (el caso real son 1-4 monitores).
        availableDisplays: normalizeDisplays(screenCam.available_displays),
        activeDisplayId: typeof screenCam.active_display_id === 'string' ? screenCam.active_display_id.slice(0, 200) : null,
        fallbackActive: typeof screenCam.fallback_active === 'boolean' ? screenCam.fallback_active : null,
        displayWarning: typeof screenCam.display_warning === 'string' ? screenCam.display_warning.slice(0, 300) : null,
      });
    }
  }
  res.json({}); // sin campos strategy/disconnect/sysinfo: no se implementan esas funciones
});

// El cliente re-sube el estado COMPLETO de su libreta (alias + tags de cada
// equipo) cada vez que cambia algo -- no hay endpoints separados por accion
// (agregar tag, renombrar, etc). El listado de tags de nivel superior que
// manda el cliente (parsed.tags) se ignora a proposito: la lista real la
// calcula siempre el servidor en el GET (reservados + los que esten en uso),
// asi "Cabinas"/"Clientes" no se pueden borrar ni renombrar desde el cliente.
router.post('/ab', requireBearerAuth, (req, res) => {
  try {
    const parsed = JSON.parse(req.body?.data || '{}');
    const peers = Array.isArray(parsed.peers) ? parsed.peers : [];
    const update = db.prepare('update devices set alias = ?, tags = ? where rustdesk_id = ? and owner_user_id = ?');
    const saveMetadata = db.prepare(`
      insert into device_sysinfo (rustdesk_id, hostname, os, username, updated_at)
      values (?, ?, ?, ?, datetime('now'))
      on conflict(rustdesk_id) do update set
        hostname = coalesce(nullif(excluded.hostname, ''), device_sysinfo.hostname),
        os = coalesce(nullif(excluded.os, ''), device_sysinfo.os),
        username = coalesce(nullif(excluded.username, ''), device_sysinfo.username),
        updated_at = datetime('now')
    `);
    for (const p of peers) {
      if (!p?.id) continue;
      const tags = Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : [];
      const changed = update.run(p.alias || null, JSON.stringify(tags), p.id, req.user.sub);
      if (changed.changes) {
        saveMetadata.run(p.id, p.hostname || null, p.platform || null, p.username || null);
      }
    }
  } catch (_) {
    // si el cliente manda algo inesperado, no rompemos el flujo: simplemente no persistimos este sync
  }
  res.status(200).end();
});

module.exports = router;
