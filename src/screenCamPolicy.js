// Licenciamiento y estado del modulo ScreenCam (pantalla -> RTSP), jerarquia
// plan -> cliente -> dispositivo: el override mas especifico pisa al mas
// general, igual que se le describio al desarrollador del cliente. Ver
// docs/CLIENT_INTEGRATION.md seccion 11 para el contrato con el cliente.
const db = require('./db/adminDb');
const notifications = require('./notifications');
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

// Resuelve la politica efectiva para un dispositivo de una cuenta dada.
// "enabled" nulo en customer/device significa "sin override, heredar".
function resolvePolicy(userId, rustdeskId) {
  if (!userId) return { ...DEFAULT_POLICY };

  const user = db.prepare('select plan_id from users where id = ?').get(userId);
  const planModule = getPlanModule(user?.plan_id);
  const customerModule = getCustomerModule(userId);
  const deviceSettings = rustdeskId ? getDeviceSettings(rustdeskId) : null;

  const licensed = (
    deviceSettings?.enabled ?? customerModule?.enabled ?? planModule?.enabled ?? 0
  ) === 1;

  const mode = deviceSettings?.mode || customerModule?.mode || planModule?.mode || 'local';
  const maxStreams = deviceSettings?.max_streams ?? customerModule?.max_streams ?? planModule?.max_streams ?? 1;
  const desiredState = licensed ? (deviceSettings?.desired_state || 'running') : 'stopped';

  return {
    licensed,
    desired_state: desiredState,
    mode,
    max_streams: licensed ? maxStreams : 0,
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

// El cliente reporta su estado real via heartbeat (actual_state, encoder
// usado, error si lo hay, cantidad de clientes RTSP conectados). No consume
// "licensed"/"desired_state" -- esos los define el servidor, no el cliente.
function reportDeviceState(rustdeskId, { actualState, encoder, lastError, rtspClients }) {
  db.prepare(`
    insert into device_screen_cam_settings (rustdesk_id, actual_state, encoder, last_error, rtsp_clients, last_report_at, updated_at)
    values (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    on conflict(rustdesk_id) do update set
      actual_state = coalesce(?, device_screen_cam_settings.actual_state),
      encoder = coalesce(?, device_screen_cam_settings.encoder),
      last_error = ?,
      rtsp_clients = coalesce(?, device_screen_cam_settings.rtsp_clients),
      last_report_at = datetime('now'),
      updated_at = datetime('now')
  `).run(
    rustdeskId, actualState || null, encoder || null, lastError || null, rtspClients ?? null,
    actualState || null, encoder || null, lastError || null, rtspClients ?? null,
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
  setPlanModule,
  setCustomerModule,
  setDeviceOverride,
  reportDeviceState,
};
