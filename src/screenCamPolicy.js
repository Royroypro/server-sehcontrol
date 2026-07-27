// Licenciamiento y estado del modulo ScreenCam (pantalla -> RTSP).
//
// Modelo de cupos (ver docs/CLIENT_INTEGRATION.md seccion 12): el plan (o un
// override por cliente) concede el DERECHO a usar el modulo y define cuantos
// equipos pueden tenerlo activo a la vez (max_streams = cupo de equipos, no
// viewers RTSP por equipo). El cliente final elige en cuales de sus equipos
// gastar ese cupo -- eso es lo que representa `enabled` en
// device_screen_cam_settings: no es un "override que pisa", es la seleccion
// del cliente, y solo tiene efecto si la cuenta tiene el modulo disponible.
//
// licensed = cuenta activa (membresia no vencida/suspendida) AND modulo
// disponible para la cuenta (plan o override de cliente) AND el cliente
// activo este equipo puntual dentro de su cupo.
const db = require('./db/adminDb');
const notifications = require('./notifications');
const membershipSync = require('./membershipSync');
const ws = require('./ws');

const MODULE = 'screen_cam';
const DEFAULT_POLICY = { licensed: false, desired_state: 'stopped', mode: 'local', max_streams: 0 };

function getPlanModule(planId) {
  if (!planId) return null;
  return db.prepare('select * from plan_modules where plan_id = ? and module = ?').get(planId, MODULE);
}

function getCustomerModule(userId) {
  return db.prepare('select * from customer_modules where user_id = ? and module = ?').get(userId, MODULE);
}

function getDeviceSettings(rustdeskId) {
  return db.prepare('select * from device_screen_cam_settings where rustdesk_id = ?').get(rustdeskId);
}

function countActiveDevices(userId) {
  return db.prepare(`
    select count(*) c from devices d join device_screen_cam_settings s on s.rustdesk_id = d.rustdesk_id
    where d.owner_user_id = ? and s.enabled = 1
  `).get(userId).c;
}

// Disponibilidad del modulo a nivel cuenta (no de un equipo puntual):
// si la cuenta tiene derecho a usarlo y cuantos cupos tiene/uso.
// La membresia (suspendida/vencida) siempre gana -- ver isUserBlocked.
function getModuleAvailability(userId) {
  const user = db.prepare('select status, plan_expires_at, plan_id from users where id = ?').get(userId);
  if (!user || membershipSync.isUserBlocked(user)) {
    return { available: false, max_slots: 0, used_slots: 0 };
  }
  const planModule = getPlanModule(user.plan_id);
  const customerModule = getCustomerModule(userId);
  const available = (customerModule?.enabled ?? planModule?.enabled ?? 0) === 1;
  const maxSlots = customerModule?.max_streams ?? planModule?.max_streams ?? 0;
  return { available, max_slots: available ? maxSlots : 0, used_slots: countActiveDevices(userId) };
}

// Resuelve la politica efectiva para un dispositivo de una cuenta dada,
// para GET /api/client-policy?id=<rustdesk_id>.
function resolvePolicy(userId, rustdeskId) {
  if (!userId) return { ...DEFAULT_POLICY };

  const availability = getModuleAvailability(userId);
  if (!availability.available) return { ...DEFAULT_POLICY };

  const user = db.prepare('select plan_id from users where id = ?').get(userId);
  const planModule = getPlanModule(user?.plan_id);
  const customerModule = getCustomerModule(userId);
  const deviceSettings = rustdeskId ? getDeviceSettings(rustdeskId) : null;

  // El cliente activo este equipo puntual (device_screen_cam_settings.enabled)?
  // Sin eso, la cuenta tiene el derecho pero no gasto el cupo en este equipo.
  const licensed = (deviceSettings?.enabled ?? 0) === 1;
  const mode = deviceSettings?.mode || customerModule?.mode || planModule?.mode || 'local';
  const desiredState = licensed ? (deviceSettings?.desired_state || 'running') : 'stopped';

  return {
    licensed,
    desired_state: desiredState,
    mode,
    max_streams: availability.max_slots,
  };
}

function setPlanModule(planId, { enabled, mode, maxStreams }, actorUserId) {
  db.prepare(`
    insert into plan_modules (plan_id, module, enabled, mode, max_streams)
    values (?, ?, ?, coalesce(?, 'managed'), coalesce(?, 1))
    on conflict(plan_id, module) do update set
      enabled = excluded.enabled,
      mode = coalesce(?, plan_modules.mode),
      max_streams = coalesce(?, plan_modules.max_streams)
  `).run(planId, MODULE, enabled ? 1 : 0, mode, maxStreams, mode, maxStreams);
  notifications.logActivity(actorUserId, 'screen_cam_plan_module_updated', 'plan', planId,
    JSON.stringify({ enabled: !!enabled, mode, max_streams: maxStreams }));
  notifyAffectedUsersByPlan(planId);
}

function setCustomerModule(userId, { enabled, mode, maxStreams }, actorUserId) {
  db.prepare(`
    insert into customer_modules (user_id, module, enabled, mode, max_streams)
    values (?, ?, ?, ?, ?)
    on conflict(user_id, module) do update set
      enabled = excluded.enabled,
      mode = excluded.mode,
      max_streams = excluded.max_streams
  `).run(userId, MODULE, enabled == null ? null : (enabled ? 1 : 0), mode ?? null, maxStreams ?? null);
  notifications.logActivity(actorUserId, 'screen_cam_customer_module_updated', 'user', userId,
    JSON.stringify({ enabled, mode, max_streams: maxStreams }));
  notifyUser(userId);
}

// Uso admin (sin control de cupo -- el admin tiene autoridad final: forzar
// apagado ante un problema, o encender un equipo puntual para soporte). El
// uso normal del cliente final es activateDevice/deactivateDevice abajo, que
// si validan cupo.
function setDeviceOverride(rustdeskId, { enabled, desiredState, mode, maxStreams }, actorUserId) {
  db.prepare(`
    insert into device_screen_cam_settings (rustdesk_id, enabled, desired_state, mode, max_streams, updated_at)
    values (?, ?, coalesce(?, 'stopped'), ?, ?, datetime('now'))
    on conflict(rustdesk_id) do update set
      enabled = excluded.enabled,
      desired_state = coalesce(?, device_screen_cam_settings.desired_state),
      mode = excluded.mode,
      max_streams = excluded.max_streams,
      updated_at = datetime('now')
  `).run(
    rustdeskId, enabled == null ? null : (enabled ? 1 : 0), desiredState, mode ?? null, maxStreams ?? null,
    desiredState,
  );
  notifications.logActivity(actorUserId, 'screen_cam_device_override_updated', 'device', rustdeskId,
    JSON.stringify({ enabled, desired_state: desiredState, mode, max_streams: maxStreams }));
  const owner = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (owner) notifyUser(owner.owner_user_id, rustdeskId);
}

function moduleError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Panel del cliente: el usuario final elige en cuales de sus equipos gastar
// el cupo que le dio su plan. Valida pertenencia y cupo disponible antes de
// activar -- a diferencia de setDeviceOverride (admin), esto SI se puede
// rechazar por falta de cupo.
function activateDevice(userId, rustdeskId, actorUserId = userId) {
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device || device.owner_user_id !== userId) {
    throw moduleError('NOT_FOUND', 'Equipo no encontrado o no pertenece a esta cuenta');
  }
  const tx = db.transaction(() => {
    const availability = getModuleAvailability(userId);
    if (!availability.available) {
      throw moduleError('NOT_LICENSED', 'Tu plan no incluye ScreenCam o el modulo esta desactivado para tu cuenta');
    }
    const alreadyActive = getDeviceSettings(rustdeskId)?.enabled === 1;
    if (!alreadyActive && availability.used_slots >= availability.max_slots) {
      throw moduleError('QUOTA_EXCEEDED', `Ya usaste los ${availability.max_slots} cupo(s) de ScreenCam de tu plan. Desactiva otro equipo primero.`);
    }
    setDeviceOverride(rustdeskId, { enabled: true, desiredState: 'running' }, actorUserId);
  });
  tx();
}

function deactivateDevice(userId, rustdeskId, actorUserId = userId) {
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device || device.owner_user_id !== userId) {
    throw moduleError('NOT_FOUND', 'Equipo no encontrado o no pertenece a esta cuenta');
  }
  setDeviceOverride(rustdeskId, { enabled: false, desiredState: 'stopped' }, actorUserId);
}

// Lista para el futuro panel del cliente: sus equipos, cual tiene ScreenCam
// activo, estado real reportado, y el resumen de cupos de la cuenta.
function listDevicesForCustomer(userId) {
  const availability = getModuleAvailability(userId);
  const rows = db.prepare(`
    select d.rustdesk_id, d.alias, s.hostname, s.os,
           cs.enabled, cs.desired_state, cs.mode, cs.actual_state, cs.encoder,
           cs.last_error, cs.rtsp_clients, cs.local_ip, cs.rtsp_port, cs.last_report_at
    from devices d
    left join device_sysinfo s on s.rustdesk_id = d.rustdesk_id
    left join device_screen_cam_settings cs on cs.rustdesk_id = d.rustdesk_id
    where d.owner_user_id = ?
    order by d.claimed_at desc
  `).all(userId);

  const devices = rows.map((r) => ({
    rustdesk_id: r.rustdesk_id,
    alias: r.alias || null,
    hostname: r.hostname || null,
    os: r.os || null,
    active: r.enabled === 1,
    actual_state: r.actual_state || null,
    encoder: r.encoder || null,
    last_error: r.last_error || null,
    rtsp_clients: r.rtsp_clients ?? null,
    rtsp_url: (r.enabled === 1 && r.local_ip && r.rtsp_port) ? `rtsp://${r.local_ip}:${r.rtsp_port}/live/main` : null,
    last_report_at: r.last_report_at || null,
  }));

  return { module: availability, devices };
}

// El cliente reporta su estado real via heartbeat (actual_state, encoder
// usado, error si lo hay, cantidad de clientes RTSP conectados, y la
// direccion local para armar la URL RTSP). No consume "licensed"/
// "desired_state"/"enabled" -- eso lo define el servidor, no el cliente.
function reportDeviceState(rustdeskId, { actualState, encoder, lastError, rtspClients, localIp, rtspPort }) {
  db.prepare(`
    insert into device_screen_cam_settings (rustdesk_id, actual_state, encoder, last_error, rtsp_clients, local_ip, rtsp_port, last_report_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    on conflict(rustdesk_id) do update set
      actual_state = coalesce(?, device_screen_cam_settings.actual_state),
      encoder = coalesce(?, device_screen_cam_settings.encoder),
      last_error = ?,
      rtsp_clients = coalesce(?, device_screen_cam_settings.rtsp_clients),
      local_ip = coalesce(?, device_screen_cam_settings.local_ip),
      rtsp_port = coalesce(?, device_screen_cam_settings.rtsp_port),
      last_report_at = datetime('now'),
      updated_at = datetime('now')
  `).run(
    rustdeskId, actualState || null, encoder || null, lastError || null, rtspClients ?? null, localIp || null, rtspPort ?? null,
    actualState || null, encoder || null, lastError || null, rtspClients ?? null, localIp || null, rtspPort ?? null,
  );
  if (lastError) {
    notifications.logActivity(null, 'screen_cam_error_reported', 'device', rustdeskId,
      JSON.stringify({ error: lastError, encoder: encoder || null }));
  }
}

function pushPayload(userId, rustdeskId) {
  const policy = resolvePolicy(userId, rustdeskId);
  return { type: 'screen_cam.update', data: { rustdesk_id: rustdeskId || null, ...policy } };
}

// Sin rustdeskId, empuja la politica "generica" del usuario (sin override de
// dispositivo) -- util cuando cambia el plan o el override de cliente, antes
// de saber a cual de sus equipos afecta mas.
function notifyUser(userId, rustdeskId = null) {
  ws.pushToUser(userId, pushPayload(userId, rustdeskId));
}

function notifyAffectedUsersByPlan(planId) {
  const users = db.prepare('select id from users where plan_id = ?').all(planId);
  for (const u of users) notifyUser(u.id);
}

module.exports = {
  MODULE,
  resolvePolicy,
  getModuleAvailability,
  setPlanModule,
  setCustomerModule,
  setDeviceOverride,
  activateDevice,
  deactivateDevice,
  listDevicesForCustomer,
  reportDeviceState,
};
