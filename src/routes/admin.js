const express = require('express');
const db = require('../db/adminDb');
const hbbsDb = require('../db/hbbsDb');
const deviceInfo = require('../deviceInfo');
const deviceClaim = require('../deviceClaim');
const membershipSync = require('../membershipSync');
const notifications = require('../notifications');
const nativeSessions = require('../nativeSessions');
const { buildReceiptPdf } = require('../receipt');
const { formatCurrency } = require('../format');
const { requireAuth, requireAdmin, hashPassword } = require('../auth');
const rustdeskKey = require('../rustdeskKey');
const { pushToAll, closeUserConnections } = require('../ws');
const clientDownload = require('../clientDownload');
const screenCamPolicy = require('../screenCamPolicy');
const screenCamPreview = require('../screenCamPreview');
const mediaMtxApi = require('../mediaMtxApi');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ---------- Configuracion de la plataforma ----------
router.get('/settings', (req, res) => {
  res.json(db.prepare('select * from platform_settings where id = 1').get());
});

router.put('/settings', (req, res) => {
  const {
    business_name, tax_id, address, phone, whatsapp_number, contact_email, default_currency, language,
    expiry_warning_days: expiryWarningDays,
    screen_cam_preview_duration_seconds: previewDurationSeconds,
  } = req.body || {};
  const current = db.prepare('select * from platform_settings where id = 1').get();

  let expiryWarningDaysJson = current.expiry_warning_days;
  if (expiryWarningDays !== undefined) {
    if (!Array.isArray(expiryWarningDays) || expiryWarningDays.some((d) => !Number.isInteger(d) || d < 0)) {
      return res.status(400).json({ error: 'expiry_warning_days debe ser un arreglo de enteros no negativos' });
    }
    expiryWarningDaysJson = JSON.stringify([...new Set(expiryWarningDays)].sort((a, b) => b - a));
  }

  // Duracion de las sesiones de previsualizacion de ScreenCam: solo aplica a
  // sesiones NUEVAS (ver src/screenCamPreview.js resolvePreviewDurationSeconds).
  // Las ya creadas conservan su expires_at original.
  let previewDuration = current.screen_cam_preview_duration_seconds;
  if (previewDurationSeconds !== undefined) {
    if (!screenCamPreview.isValidPreviewDurationSeconds(previewDurationSeconds)) {
      return res.status(400).json({
        error: `screen_cam_preview_duration_seconds debe ser un entero entre ${screenCamPreview.PREVIEW_DURATION_MIN_SECONDS} y ${screenCamPreview.PREVIEW_DURATION_MAX_SECONDS}`,
      });
    }
    previewDuration = previewDurationSeconds;
  }

  db.prepare(`
    update platform_settings set
      business_name = ?, tax_id = ?, address = ?, phone = ?, whatsapp_number = ?, contact_email = ?,
      default_currency = ?, language = ?, expiry_warning_days = ?,
      screen_cam_preview_duration_seconds = ?, updated_at = datetime('now')
    where id = 1
  `).run(
    business_name ?? current.business_name,
    tax_id ?? current.tax_id,
    address ?? current.address,
    phone ?? current.phone,
    whatsapp_number ?? current.whatsapp_number,
    contact_email ?? current.contact_email,
    default_currency || current.default_currency,
    language || current.language,
    expiryWarningDaysJson,
    previewDuration,
  );
  notifications.logActivity(req.user.sub, 'settings_updated', 'platform_settings', 1, business_name || null);
  if (previewDurationSeconds !== undefined && previewDuration !== current.screen_cam_preview_duration_seconds) {
    // Auditoria especifica del limite (recomendado: quien cambio que valor).
    // Sin datos sensibles: solo los dos enteros involucrados.
    notifications.logActivity(
      req.user.sub,
      'screen_cam_preview_duration_updated',
      'platform_settings',
      1,
      JSON.stringify({ from: current.screen_cam_preview_duration_seconds, to: previewDuration }),
    );
  }
  res.json(db.prepare('select * from platform_settings where id = 1').get());
});

router.get('/settings/rustdesk-key', (req, res) => {
  try {
    res.json(rustdeskKey.getPublicKeyInfo());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings/rustdesk-key/rotate', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Debes confirmar la rotacion de la key' });
  }
  try {
    rustdeskKey.rotateKeyPair();
    const serverKey = rustdeskKey.getPublicKeyInfo();
    const notifiedClients = pushToAll({ type: 'server_key_changed', data: serverKey });
    notifications.logActivity(req.user.sub, 'rustdesk_key_rotated', 'platform_settings', 1, 'Key publica de RustDesk rotada');
    res.json({ ...serverKey, restarting: true, notified_clients: notifiedClients });
  } catch (e) {
    res.status(500).json({ error: `No se pudo rotar la key: ${e.message}` });
  }
});

router.get('/settings/client-download', (req, res) => {
  res.json(clientDownload.getAllClientInfo());
});

// Declara que version corresponde al binario ya subido, y las notas que el
// cliente muestra al ofrecer la actualizacion. Separado de la subida porque
// son dos decisiones distintas: permite corregir una version mal escrita, o
// dejar de anunciar una actualizacion, sin volver a subir el binario.
router.put('/settings/client-release/:platform', (req, res) => {
  try {
    const { platform } = req.params;
    const { version, notes } = req.body || {};
    const info = clientDownload.setClientRelease(platform, version, notes);
    notifications.logActivity(
      req.user.sub,
      'client_release_declared',
      'platform_settings',
      1,
      `${platform}: ${info.version || '(sin anunciar)'}`,
    );
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const CLIENT_UPLOAD_LIMITS_MB = {
  windows: Number(process.env.CLIENT_EXE_MAX_MB || 500),
  android: Number(process.env.CLIENT_APK_MAX_MB || 500),
};
const CLIENT_UPLOAD_TYPES = {
  windows: ['application/octet-stream', 'application/x-msdownload', 'application/vnd.microsoft.portable-executable'],
  android: ['application/octet-stream', 'application/vnd.android.package-archive'],
};

for (const platform of Object.keys(CLIENT_UPLOAD_LIMITS_MB)) {
  const clientUpload = express.raw({
    type: CLIENT_UPLOAD_TYPES[platform],
    limit: `${CLIENT_UPLOAD_LIMITS_MB[platform]}mb`,
  });

  router.put(`/settings/client-download/${platform}`, clientUpload, (req, res) => {
    try {
      // Content-Length lo fija el cliente HTTP a partir del tamano real del
      // fichero; compararlo con lo recibido es lo que detecta una subida
      // cortada a medias. Ausente o ilegible se trata como "no declarado" y
      // saveClient simplemente no puede hacer esa comprobacion.
      const declared = Number.parseInt(req.get('content-length'), 10);
      // El nombre original del archivo. La subida es un PUT con el binario en
      // crudo, sin multipart, asi que el nombre no viaja solo: la UI lo manda
      // en este encabezado. Ver clientDownload.sanitizeFilename para por que
      // importa conservarlo.
      const info = clientDownload.saveClient(
        platform,
        req.body,
        Number.isFinite(declared) ? declared : undefined,
        req.get('x-client-filename'),
      );
      notifications.logActivity(
        req.user.sub,
        'client_app_uploaded',
        'platform_settings',
        1,
        `${platform}: ${info.filename} (${info.size_bytes} bytes)`,
      );
      res.json(info);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

// ---------- Dashboard ----------
router.get('/stats', (req, res) => {
  const users = db.prepare('select count(*) c from users').get().c;
  const clients = db.prepare("select count(*) c from users where role = 'client'").get().c;
  const devices = db.prepare('select count(*) c from devices').get().c;
  const expiringSoon = db.prepare(
    "select count(*) c from users where plan_expires_at is not null and plan_expires_at between datetime('now') and datetime('now', '+7 days')"
  ).get().c;
  const expired = db.prepare(
    "select count(*) c from users where plan_expires_at is not null and plan_expires_at < datetime('now')"
  ).get().c;
  // Los ingresos solo suman pagos "paid" (los "pending"/Debe todavia no son
  // plata recibida) y solo en la moneda por defecto de la plataforma -- sumar
  // montos en distintas monedas sin convertir daria un numero sin sentido.
  const settings = db.prepare('select * from platform_settings where id = 1').get();
  const revenueMonth = db.prepare(
    "select coalesce(sum(amount_cents),0) c from payments where status = 'paid' and currency = ? and created_at >= datetime('now','start of month')"
  ).get(settings.default_currency).c;
  const revenueTotal = db.prepare(
    "select coalesce(sum(amount_cents),0) c from payments where status = 'paid' and currency = ?"
  ).get(settings.default_currency).c;
  const otherCurrencyPaid = db.prepare(
    "select count(*) c from payments where status = 'paid' and currency != ?"
  ).get(settings.default_currency).c;
  const recentAlerts = db.prepare(
    "select count(*) c from alerts where created_at >= datetime('now','-7 days')"
  ).get().c;
  const upcomingRenewals = db.prepare(`
    select u.id, u.email, u.plan_expires_at, p.name as plan_name
    from users u left join plans p on p.id = u.plan_id
    where u.status = 'active' and u.plan_expires_at is not null
      and u.plan_expires_at between datetime('now') and datetime('now', '+7 days')
    order by u.plan_expires_at asc
  `).all();
  res.json({
    users, clients, devices, expiringSoon, expired,
    revenueMonthCents: revenueMonth, revenueTotalCents: revenueTotal,
    revenueCurrency: settings.default_currency,
    revenueMonthFormatted: formatCurrency(revenueMonth, settings.default_currency),
    revenueTotalFormatted: formatCurrency(revenueTotal, settings.default_currency),
    otherCurrencyPaidCount: otherCurrencyPaid,
    recentAlerts, upcomingRenewals,
    hbbsConnected: hbbsDb.isAvailable(),
  });
});

// ---------- Plans ----------
router.get('/plans', (req, res) => {
  res.json(db.prepare(`
    select p.*, pm.enabled as screen_cam_enabled, pm.mode as screen_cam_mode, pm.max_streams as screen_cam_max_streams
    from plans p
    left join plan_modules pm on pm.plan_id = p.id and pm.module = 'screen_cam'
    order by p.price_cents asc
  `).all());
});

router.post('/plans', (req, res) => {
  const { name, description, max_devices, price_cents, currency, duration_days, is_public } = req.body || {};
  if (!name || max_devices == null) {
    return res.status(400).json({ error: 'name y max_devices son requeridos' });
  }
  try {
    const info = db.prepare(
      'insert into plans (name, description, max_devices, price_cents, currency, duration_days, is_public) values (?, ?, ?, ?, ?, ?, ?)'
    ).run(name, description != null ? (String(description).trim() || null) : null, Number(max_devices), Number(price_cents) || 0, currency || 'USD', Number(duration_days) || 30, is_public ? 1 : 0);
    notifications.logActivity(req.user.sub, 'plan_created', 'plan', info.lastInsertRowid, name);
    res.status(201).json(db.prepare('select * from plans where id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ya existe un plan con ese nombre' : e.message });
  }
});

router.put('/plans/:id', (req, res) => {
  const plan = db.prepare('select * from plans where id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const { name, description, max_devices, price_cents, currency, duration_days, is_public } = req.body || {};
  db.prepare(
    'update plans set name = ?, description = ?, max_devices = ?, price_cents = ?, currency = ?, duration_days = ?, is_public = ? where id = ?'
  ).run(
    name ?? plan.name,
    description !== undefined ? (String(description).trim() || null) : plan.description,
    max_devices != null ? Number(max_devices) : plan.max_devices,
    price_cents != null ? Number(price_cents) : plan.price_cents,
    currency || plan.currency,
    duration_days != null ? Number(duration_days) : plan.duration_days,
    is_public !== undefined ? (is_public ? 1 : 0) : plan.is_public,
    plan.id
  );
  res.json(db.prepare('select * from plans where id = ?').get(plan.id));
});

router.delete('/plans/:id', (req, res) => {
  const inUse = db.prepare('select count(*) c from users where plan_id = ?').get(req.params.id).c;
  if (inUse > 0) {
    return res.status(400).json({ error: `No se puede borrar: ${inUse} usuario(s) tienen este plan asignado` });
  }
  db.prepare('delete from plans where id = ?').run(req.params.id);
  notifications.logActivity(req.user.sub, 'plan_deleted', 'plan', req.params.id, null);
  res.json({ ok: true });
});

// ---------- Users ----------
router.get('/users', (req, res) => {
  const users = db.prepare(`
    select u.id, u.email, u.name, u.role, u.status, u.plan_id, u.plan_started_at, u.plan_expires_at, u.created_at,
           p.name as plan_name, p.max_devices,
           (select count(*) from devices d where d.owner_user_id = u.id) as device_count
    from users u
    left join plans p on p.id = u.plan_id
    order by u.created_at desc
  `).all();
  res.json(users);
});

router.post('/users', (req, res) => {
  const { email, name, password, role, plan_id, duration_days_override } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email y password son requeridos' });
  if (role && !['admin', 'client'].includes(role)) return res.status(400).json({ error: 'role invalido' });

  let plan = null;
  if (plan_id) {
    plan = db.prepare('select * from plans where id = ?').get(plan_id);
    if (!plan) return res.status(400).json({ error: 'Plan no encontrado' });
  }
  const days = duration_days_override != null ? Number(duration_days_override) : plan?.duration_days;
  const startedAt = plan ? new Date().toISOString() : null;
  const expiresAt = plan ? new Date(Date.now() + days * 86400000).toISOString() : null;

  try {
    const info = db.prepare(`
      insert into users (email, name, password_hash, role, plan_id, plan_started_at, plan_expires_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(email.toLowerCase().trim(), name || null, hashPassword(password), role || 'client', plan?.id || null, startedAt, expiresAt);
    notifications.logActivity(req.user.sub, 'user_created', 'user', info.lastInsertRowid, email);
    res.status(201).json(db.prepare('select id, email, name, role, plan_id, plan_expires_at, status from users where id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ya existe un usuario con ese email' : e.message });
  }
});

router.put('/users/:id', (req, res) => {
  const user = db.prepare('select * from users where id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { email, name, role, status, plan_id, plan_expires_at, plan_started_at, password, renew } = req.body || {};

  if (role && !['admin', 'client'].includes(role)) return res.status(400).json({ error: 'role invalido' });
  if (status && !['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'status invalido' });
  const newEmail = email !== undefined ? String(email).toLowerCase().trim() : user.email;
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  let newPlanId = plan_id !== undefined ? plan_id : user.plan_id;
  let newExpiresAt = plan_expires_at !== undefined ? plan_expires_at : user.plan_expires_at;
  let newStartedAt = plan_started_at !== undefined ? plan_started_at : user.plan_started_at;

  if (renew && newPlanId) {
    const plan = db.prepare('select * from plans where id = ?').get(newPlanId);
    if (plan) {
      newStartedAt = new Date().toISOString();
      newExpiresAt = new Date(Date.now() + plan.duration_days * 86400000).toISOString();
    }
  }

  const newStatus = status || user.status;
  const newHash = password ? hashPassword(password) : user.password_hash;

  try {
    db.prepare(`
      update users set email = ?, name = ?, role = ?, status = ?, plan_id = ?, plan_started_at = ?, plan_expires_at = ?, password_hash = ?
      where id = ?
    `).run(newEmail, name !== undefined ? name : user.name, role || user.role, newStatus, newPlanId || null, newStartedAt, newExpiresAt, newHash, user.id);
  } catch (e) {
    return res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ya existe un usuario con ese email' : e.message });
  }

  // Una contraseña nueva o la suspensión de la cuenta revoca las sesiones
  // nativas. Así, reactivar posteriormente la cuenta no restaura tokens viejos.
  if (password || (user.status !== 'suspended' && newStatus === 'suspended')) {
    nativeSessions.revokeUserNativeSessions(user.id);
    closeUserConnections(user.id);
  }

  membershipSync.syncUserDevices(user.id);
  notifications.logActivity(req.user.sub, 'user_updated', 'user', user.id,
    `email=${user.email}->${newEmail} role=${role || user.role} status=${newStatus}${renew ? ' (renovado)' : ''}`);
  res.json(db.prepare('select id, email, name, role, status, plan_id, plan_started_at, plan_expires_at from users where id = ?').get(user.id));
});

router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.sub) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  }
  const user = db.prepare('select email from users where id = ?').get(req.params.id);
  db.prepare('delete from users where id = ?').run(req.params.id);
  notifications.logActivity(req.user.sub, 'user_deleted', 'user', req.params.id, user?.email || null);
  res.json({ ok: true });
});

// ---------- Devices ----------
router.get('/devices', (req, res) => {
  const rows = db.prepare(`
    select d.id, d.rustdesk_id, d.alias, d.claimed_at, u.id as owner_id, u.email as owner_email
    from devices d join users u on u.id = d.owner_user_id
    order by d.claimed_at desc
  `).all();
  const enriched = rows.map((d) => ({ ...d, live: deviceInfo.enrichDevice(d.rustdesk_id) }));
  res.json(enriched);
});

// IDs que se registraron en hbbs pero todavia no tienen dueno en el panel.
// Para el picker de "Asignar equipo" (solo admin: exponer esto a clientes
// dejaria que uno reclame el equipo de otro por ser mas rapido, ver
// docs/CLIENT_INTEGRATION.md para el contexto de por que se decidio asi).
router.get('/devices/unclaimed', (req, res) => {
  const claimed = new Set(db.prepare('select rustdesk_id from devices').all().map((d) => d.rustdesk_id));
  const unclaimed = hbbsDb.listAllPeers()
    .filter((p) => !claimed.has(p.rustdesk_id))
    .map((p) => ({ ...p, ...deviceInfo.enrichDevice(p.rustdesk_id) }));
  res.json(unclaimed);
});

router.post('/devices', (req, res) => {
  const { rustdesk_id, owner_user_id, alias } = req.body || {};
  if (!rustdesk_id || !owner_user_id) {
    return res.status(400).json({ error: 'rustdesk_id y owner_user_id son requeridos' });
  }
  const owner = db.prepare(`
    select u.*, p.max_devices from users u left join plans p on p.id = u.plan_id where u.id = ?
  `).get(owner_user_id);
  if (!owner) return res.status(404).json({ error: 'Usuario no encontrado' });
  const normalizedId = rustdesk_id.trim();
  if (hbbsDb.isAvailable() && !hbbsDb.peerExists(normalizedId)) {
    return res.status(400).json({ error: 'Ese ID no esta registrado en hbbs y no puede asignarse' });
  }

  const currentCount = db.prepare('select count(*) c from devices where owner_user_id = ?').get(owner.id).c;
  const limit = owner.max_devices ?? 0;
  if (currentCount >= limit) {
    return res.status(400).json({ error: `El usuario alcanzo su limite de ${limit} equipo(s) para su plan` });
  }

  try {
    const info = deviceClaim.claimDevice(owner.id, normalizedId, alias || null, {
      actorUserId: req.user.sub,
      source: 'admin_panel',
    });
    membershipSync.syncDevice(normalizedId, owner.id);
    res.status(201).json(db.prepare('select * from devices where id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ese equipo ya esta asignado a un usuario' : e.message });
  }
});

router.get('/devices/:rustdeskId/audit', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare(`
    select d.*, u.email as owner_email, actor.email as claimed_by_email
    from devices d
    join users u on u.id = d.owner_user_id
    left join users actor on actor.id = d.claimed_by_user_id
    where d.rustdesk_id = ?
  `).get(rustdeskId);
  const sysinfo = db.prepare('select * from device_sysinfo where rustdesk_id = ?').get(rustdeskId) || null;
  const peer = hbbsDb.getPeerByRustdeskId(rustdeskId);
  const activity = db.prepare(`
    select l.*, u.email as actor_email
    from activity_log l left join users u on u.id = l.actor_user_id
    where (l.target_type = 'device' and l.target_id = ?) or l.detail like ?
    order by l.created_at asc
  `).all(rustdeskId, `%${rustdeskId}%`);
  res.json({
    rustdesk_id: rustdeskId,
    registered: !!peer,
    orphaned: !!device && hbbsDb.isAvailable() && !peer,
    device: device || null,
    sysinfo,
    hbbs: peer,
    activity,
  });
});

// ---------- Licenciamiento ScreenCam (plan -> cliente -> dispositivo) ----------
// Sin UI todavia (ver docs/CLIENT_INTEGRATION.md seccion 11): estos
// endpoints son el punto de control mientras tanto. El override mas
// especifico pisa al mas general -- ver src/screenCamPolicy.js.

router.put('/plans/:id/screen-cam', (req, res) => {
  const plan = db.prepare('select id from plans where id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const { enabled, mode, max_streams: maxStreams } = req.body || {};
  if (mode && !['local', 'managed', 'supervised'].includes(mode)) {
    return res.status(400).json({ error: 'mode invalido' });
  }
  screenCamPolicy.setPlanModule(plan.id, { enabled: !!enabled, mode, maxStreams }, req.user.sub);
  res.json({ ok: true });
});

// Vista admin del resumen de cupos y equipos de una cuenta -- mismo shape
// que consumira el futuro panel del cliente (GET /api/screen-cam/devices),
// para que el admin pueda ver exactamente lo que ve el cliente.
router.get('/users/:id/screen-cam', (req, res) => {
  const user = db.prepare('select id from users where id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(screenCamPolicy.listDevicesForCustomer(user.id));
});

router.put('/users/:id/screen-cam', (req, res) => {
  const user = db.prepare('select id from users where id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { enabled, mode, max_streams: maxStreams } = req.body || {};
  if (mode && !['local', 'managed', 'supervised'].includes(mode)) {
    return res.status(400).json({ error: 'mode invalido' });
  }
  // enabled puede venir null explicito para volver a heredar del plan.
  const normalizedEnabled = enabled === null ? null : !!enabled;
  screenCamPolicy.setCustomerModule(user.id, { enabled: normalizedEnabled, mode, maxStreams }, req.user.sub);
  res.json({ ok: true });
});

router.get('/devices/:rustdeskId/screen-cam', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json({
    policy: screenCamPolicy.resolvePolicy(device.owner_user_id, rustdeskId),
    reported: db.prepare(`
      select actual_state, encoder, last_error, rtsp_clients, local_ip, rtsp_port,
             reported_auth_enabled, reported_rtsp_user, last_report_at
      from device_screen_cam_settings where rustdesk_id = ?
    `).get(rustdeskId) || null,
  });
});

// Genera un par de credenciales RTSP nuevo, pisando el anterior si existia.
router.post('/devices/:rustdeskId/screen-cam/rtsp-credentials/regenerate', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  const { rtspUser, rtspPassword } = screenCamPolicy.regenerateRtspCredentials(rustdeskId, req.user.sub);
  res.json({ rtsp_user: rtspUser, rtsp_password: rtspPassword });
});

// Apaga la autenticacion RTSP de ese equipo (el cliente deja el stream sin
// credenciales en cuanto lea esto -- ver docs/CLIENT_INTEGRATION.md seccion 14).
router.delete('/devices/:rustdeskId/screen-cam/rtsp-credentials', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  screenCamPolicy.clearRtspCredentials(rustdeskId, req.user.sub);
  res.json({ ok: true });
});

// ---------- ScreenCam: seleccion remota de pantalla ----------
// Puertos RTSP/ONVIF del equipo. Vacio/null quita el override y lo devuelve a
// 554/80. Ver setDevicePorts: el cambio no surte efecto hasta que el servicio
// del equipo reinicie, porque el puerto se lee una sola vez al arrancar.
router.put('/devices/:rustdeskId/screen-cam/ports', (req, res) => {
  const rustdeskId = req.params.rustdeskId;
  const device = db.prepare('select * from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  const { rtsp_port: rtspPort, onvif_port: onvifPort } = req.body || {};
  try {
    const saved = screenCamPolicy.setDevicePorts(rustdeskId, { rtspPort, onvifPort }, req.user.sub);
    res.json({ ok: true, ...saved });
  } catch (err) {
    if (err.code === 'invalid_port') return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.get('/devices/:rustdeskId/screen-cam/displays', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json(screenCamPolicy.displayStateFor(rustdeskId) || { supports_display_selection: false, displays: [] });
});

// Cambia la pantalla capturada. La URL RTSP y las credenciales NO cambian:
// solo se reconstruye el capturador/encoder del lado cliente.
router.put('/devices/:rustdeskId/screen-cam/display', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  const { display_id: displayId, display_name: displayName, fallback_to_primary: fallbackToPrimary } = req.body || {};
  if (displayId != null && typeof displayId !== 'string') {
    return res.status(400).json({ error: 'display_id invalido' });
  }
  screenCamPolicy.setSelectedDisplay(rustdeskId, {
    displayId: displayId ? displayId.slice(0, 200) : null,
    displayName: typeof displayName === 'string' ? displayName.slice(0, 200) : null,
    fallbackToPrimary,
  }, req.user.sub);
  res.json(screenCamPolicy.displayStateFor(rustdeskId));
});

// ---------- ScreenCam: previsualizacion de video ----------
const SCREEN_CAM_PREVIEW_START_ERRORS = Object.freeze({
  NOT_FOUND: Object.freeze({ status: 404, message: 'Equipo no encontrado' }),
  FORBIDDEN: Object.freeze({
    status: 403,
    message: 'No tienes permiso para abrir una previsualizacion',
  }),
  NOT_ACTIVE: Object.freeze({
    status: 409,
    message: 'ScreenCam no esta activo en este equipo',
  }),
  ALREADY_ACTIVE: Object.freeze({
    status: 409,
    message: 'Ya hay una previsualizacion abierta para este equipo',
  }),
  MEDIA_NOT_CONFIGURED: Object.freeze({
    status: 503,
    message: 'El gateway multimedia no esta configurado en este servidor',
  }),
});

function screenCamPreviewStartError(error) {
  try {
    if (typeof error?.code !== 'string') return null;
    return Object.hasOwn(SCREEN_CAM_PREVIEW_START_ERRORS, error.code)
      ? SCREEN_CAM_PREVIEW_START_ERRORS[error.code]
      : null;
  } catch (_) {
    return null;
  }
}

function safeScreenCamPreviewStartLog(logger) {
  try {
    const result = logger(
      '[screencam] operation=screen-cam-preview-start code=internal_error',
    );
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // La respuesta HTTP no depende de la disponibilidad del logger.
  }
}

function createScreenCamPreviewStartHandler(options = {}) {
  const assertPermission = typeof options.assertPermission === 'function'
    ? options.assertPermission
    : (...args) => screenCamPolicy.assertPermission(...args);
  const startPreview = typeof options.startPreview === 'function'
    ? options.startPreview
    : (...args) => screenCamPreview.startPreview(...args);
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (message) => console.warn(message);

  return (req, res) => {
    try {
      const rustdeskId = String(req.params.rustdeskId);
      assertPermission('screen_cam.open_preview', {
        role: req.user.role,
        userId: req.user.sub,
        rustdeskId,
      });
      return res.status(201).json(startPreview(rustdeskId, req.user.sub));
    } catch (error) {
      const knownError = screenCamPreviewStartError(error);
      if (knownError) {
        return res.status(knownError.status).json({ error: knownError.message });
      }
      safeScreenCamPreviewStartLog(logger);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  };
}

router.post(
  '/devices/:rustdeskId/screen-cam/preview',
  createScreenCamPreviewStartHandler(),
);

// Enriquecimiento de disponibilidad (Tarea 2): ademas del status persistido
// en SQLite, se consulta a MediaMTX (solo desde el backend, nunca desde el
// navegador) si el path YA tiene un publisher con pista de video. Es una
// optimizacion para que el panel no dispare WHEP antes de tiempo -- el
// reintento de WHEP sigue siendo la red de seguridad real si esto falla o
// no esta disponible, por eso null/error se tratan como "seguir adelante".
function createScreenCamPreviewGetHandler(options = {}) {
  const getPreviewForDevice = typeof options.getPreviewForDevice === 'function'
    ? options.getPreviewForDevice
    : (...args) => screenCamPreview.getPreviewForDevice(...args);
  const isPathPublisherReady = typeof options.isPathPublisherReady === 'function'
    ? options.isPathPublisherReady
    : (...args) => mediaMtxApi.isPathPublisherReady(...args);
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (message) => console.warn(message);

  return async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId);
      const rustdeskId = String(req.params.rustdeskId);
      const session = getPreviewForDevice(sessionId, rustdeskId);
      if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });

      if (session.status === 'ready' && session.playback_url) {
        let ready = null;
        try {
          ({ ready } = await isPathPublisherReady(sessionId, options.mediaApiOptions));
        } catch (_) {
          ready = null;
        }
        // false === MediaMTX confirma que todavia no hay publisher; cualquier
        // otro resultado (true o desconocido) deja avanzar al panel.
        session.playback_ready = ready !== false;
      } else {
        session.playback_ready = false;
      }
      return res.json(session);
    } catch (err) {
      try {
        logger('[screencam] operation=screen-cam-preview-get code=internal_error');
      } catch (_) { /* la respuesta HTTP no depende del logger */ }
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  };
}

router.get(
  '/devices/:rustdeskId/screen-cam/preview/:sessionId',
  createScreenCamPreviewGetHandler(),
);

router.delete('/devices/:rustdeskId/screen-cam/preview/:sessionId', async (req, res) => {
  try {
    res.json(await screenCamPreview.stopPreview(
      String(req.params.sessionId),
      req.user.sub,
      { expectedRustdeskId: String(req.params.rustdeskId) },
    ));
  } catch (e) {
    if (e?.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Sesion no encontrada' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

function beaconStopSessionRef(sessionId) {
  const prefix = String(sessionId).slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_');
  return prefix || 'invalid';
}

function beaconStopErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code.slice(0, 40) : '';
  return /^[A-Za-z0-9_-]+$/.test(code) ? code : 'UNEXPECTED';
}

// navigator.sendBeacon solo puede hacer POST, asi que el cierre al abandonar
// la pagina necesita su propia ruta. Sin esto, cerrar la pestana dejaria al
// equipo publicando video hasta que la sesion expire sola.
router.post('/devices/:rustdeskId/screen-cam/preview/:sessionId/beacon-stop', async (req, res) => {
  try {
    await screenCamPreview.stopPreview(
      String(req.params.sessionId),
      req.user.sub,
      { expectedRustdeskId: String(req.params.rustdeskId) },
    );
  } catch (e) {
    // NOT_FOUND es normal e indistinguible para el beacon. Los fallos
    // inesperados solo registran operacion, codigo acotado y prefijo sanitario.
    if (e?.code !== 'NOT_FOUND') {
      console.warn(
        `[screencam] operation=beacon-stop session=${beaconStopSessionRef(req.params.sessionId)}`
        + ` code=${beaconStopErrorCode(e)}`,
      );
    }
  }
  res.status(204).end();
});

router.put('/devices/:rustdeskId/screen-cam', (req, res) => {
  const rustdeskId = String(req.params.rustdeskId);
  const device = db.prepare('select owner_user_id from devices where rustdesk_id = ?').get(rustdeskId);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  const { enabled, desired_state: desiredState, mode, max_streams: maxStreams } = req.body || {};
  if (desiredState && !['running', 'stopped'].includes(desiredState)) {
    return res.status(400).json({ error: 'desired_state invalido' });
  }
  if (mode && !['local', 'managed', 'supervised'].includes(mode)) {
    return res.status(400).json({ error: 'mode invalido' });
  }
  const normalizedEnabled = enabled === null ? null : !!enabled;
  screenCamPolicy.setDeviceOverride(rustdeskId, { enabled: normalizedEnabled, desiredState, mode, maxStreams }, req.user.sub);
  res.json({ ok: true });
});

router.delete('/devices/:id', (req, res) => {
  const device = db.prepare('select * from devices where id = ?').get(req.params.id);
  db.prepare('delete from devices where id = ?').run(req.params.id);
  if (device) hbbsDb.setPeerDisabled(device.rustdesk_id, false); // ya no esta bajo control de membresias
  res.json({ ok: true });
});

// ---------- Pagos y adelantos ----------
router.get('/payments', (req, res) => {
  const rows = db.prepare(`
    select pay.*, u.email as user_email
    from payments pay join users u on u.id = pay.user_id
    order by pay.created_at desc
    limit 500
  `).all();
  res.json(rows);
});

router.get('/users/:id/payments', (req, res) => {
  res.json(db.prepare('select * from payments where user_id = ? order by created_at desc').all(req.params.id));
});

// Extiende plan_expires_at "days" dias exactos a partir de la fecha actual
// de vencimiento (o de hoy si ya vencio o no tenia plan). Se usa tanto al
// registrar un pago ya pagado, como al marcar un pago pendiente como pagado.
function extendPlan(user, days) {
  const base = user.plan_expires_at && new Date(user.plan_expires_at) > new Date()
    ? new Date(user.plan_expires_at)
    : new Date();
  const newExpiresAt = new Date(base.getTime() + Number(days) * 86400000).toISOString();
  db.prepare('update users set plan_expires_at = ?, plan_started_at = coalesce(plan_started_at, ?) where id = ?')
    .run(newExpiresAt, new Date().toISOString(), user.id);
  membershipSync.syncUserDevices(user.id);
}

// Registra un pago, "paid" (pagado) o "pending" (debe). Si viene days_added
// y el pago queda "paid", extiende plan_expires_at de una vez -- si queda
// "pending", el dia se guarda pero NO se aplica todavia (no se le da acceso
// extendido antes de que efectivamente pague); se aplica cuando lo marquen
// pagado despues (ver PUT /payments/:id/status).
router.post('/payments', (req, res) => {
  const { user_id, amount_cents, currency, method, concept, days_added, note, status } = req.body || {};
  if (!user_id || amount_cents == null) {
    return res.status(400).json({ error: 'user_id y amount_cents son requeridos' });
  }
  const payStatus = ['paid', 'pending'].includes(status) ? status : 'paid';
  const user = db.prepare('select * from users where id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const nextReceipt = db.prepare('select coalesce(max(receipt_number), 0) + 1 n from payments').get().n;

  const info = db.prepare(`
    insert into payments (receipt_number, user_id, amount_cents, currency, method, concept, days_added, note, status, registered_by)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nextReceipt, user.id, Number(amount_cents), currency || 'USD', method || 'other',
    concept || null, days_added != null ? Number(days_added) : null, note || null, payStatus, req.user.sub
  );

  if (payStatus === 'paid' && days_added) {
    extendPlan(user, Number(days_added));
  }

  notifications.createAlert({
    userId: user.id,
    type: 'payment_received',
    title: payStatus === 'paid' ? 'Pago registrado' : 'Pago pendiente registrado',
    message: `Se registro un pago ${payStatus === 'paid' ? '' : 'PENDIENTE '}de ${((Number(amount_cents)) / 100).toFixed(2)} ${currency || 'USD'}${payStatus === 'paid' && days_added ? ` (+${days_added} dias)` : ''}.`,
    createdBy: req.user.sub,
  });
  notifications.logActivity(req.user.sub, 'payment_registered', 'user', user.id,
    `${(Number(amount_cents) / 100).toFixed(2)} ${currency || 'USD'} (${payStatus})${payStatus === 'paid' && days_added ? `, +${days_added}d` : ''}`);

  res.status(201).json(db.prepare('select * from payments where id = ?').get(info.lastInsertRowid));
});

// Marca un pago pendiente ("debe") como pagado, aplicando recien ahi la
// extension de plan que tenia guardada (si tenia days_added).
router.put('/payments/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['paid', 'pending'].includes(status)) return res.status(400).json({ error: 'status invalido' });
  const payment = db.prepare('select * from payments where id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });

  const wasPending = payment.status === 'pending';
  db.prepare('update payments set status = ? where id = ?').run(status, payment.id);

  if (wasPending && status === 'paid' && payment.days_added) {
    const user = db.prepare('select * from users where id = ?').get(payment.user_id);
    if (user) extendPlan(user, payment.days_added);
  }

  notifications.logActivity(req.user.sub, 'payment_status_changed', 'payment', payment.id, status);
  res.json(db.prepare('select * from payments where id = ?').get(payment.id));
});

router.get('/payments/:id/receipt', async (req, res) => {
  const payment = db.prepare('select * from payments where id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
  const user = db.prepare(`
    select u.*, p.name as plan_name, p.max_devices, p.duration_days as plan_duration_days
    from users u left join plans p on p.id = u.plan_id where u.id = ?
  `).get(payment.user_id);
  const devices = db.prepare(`
    select d.rustdesk_id, d.alias, s.hostname
    from devices d
    left join device_sysinfo s on s.rustdesk_id = d.rustdesk_id
    where d.owner_user_id = ?
    order by d.claimed_at asc
  `).all(payment.user_id);
  const settings = db.prepare('select * from platform_settings where id = 1').get();
  try {
    const pdf = await buildReceiptPdf({ payment, user, devices, settings });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="comprobante-${String(payment.receipt_number).padStart(6, '0')}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[receipt] error generando PDF:', e);
    res.status(500).json({ error: 'No se pudo generar el comprobante' });
  }
});

router.delete('/payments/:id', (req, res) => {
  db.prepare('delete from payments where id = ?').run(req.params.id);
  notifications.logActivity(req.user.sub, 'payment_deleted', 'payment', req.params.id, null);
  res.json({ ok: true });
});

// ---------- Alertas y mensajes ----------
router.get('/alerts', (req, res) => {
  const rows = db.prepare(`
    select a.*, u.email as user_email,
           (ar.user_id is not null) as read_by_me
    from alerts a
    left join users u on u.id = a.user_id
    left join alert_reads ar on ar.alert_id = a.id and ar.user_id = ?
    order by a.created_at desc
    limit 200
  `).all(req.user.sub);
  res.json(rows);
});

router.post('/alerts/:id/read', (req, res) => {
  db.prepare('insert or ignore into alert_reads (alert_id, user_id) values (?, ?)').run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

// Mensaje manual del admin: user_id null = broadcast a todos los clientes.
router.post('/alerts/message', async (req, res) => {
  const { user_id, title, message, email } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'title y message son requeridos' });
  const id = await notifications.createAlert({
    userId: user_id || null,
    type: 'custom',
    title, message,
    email: !!email,
    createdBy: req.user.sub,
  });
  notifications.logActivity(req.user.sub, 'message_sent', 'user', user_id || 'broadcast', title);
  res.status(201).json({ id });
});

router.post('/alerts/check-expiry', async (req, res) => {
  const created = await notifications.generateExpiryAlerts();
  res.json({ created });
});

// ---------- Bitacora ----------
router.get('/activity', (req, res) => {
  const rows = db.prepare(`
    select l.*, u.email as actor_email
    from activity_log l left join users u on u.id = l.actor_user_id
    where l.created_at >= datetime('now', '-7 days')
    order by l.created_at desc
    limit 300
  `).all();
  res.json(rows);
});

module.exports = router;
module.exports.createScreenCamPreviewStartHandler = createScreenCamPreviewStartHandler;
module.exports.createScreenCamPreviewGetHandler = createScreenCamPreviewGetHandler;
module.exports.screenCamPreviewStartError = screenCamPreviewStartError;
