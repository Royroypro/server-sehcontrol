const express = require('express');
const db = require('../db/adminDb');
const hbbsDb = require('../db/hbbsDb');
const deviceInfo = require('../deviceInfo');
const deviceClaim = require('../deviceClaim');
const { requireAuth } = require('../auth');
const screenCamPolicy = require('../screenCamPolicy');

const router = express.Router();
router.use(requireAuth);

function getSelf(req) {
  return db.prepare(`
    select u.*, p.name as plan_name, p.max_devices
    from users u left join plans p on p.id = u.plan_id
    where u.id = ?
  `).get(req.user.sub);
}

router.get('/me/plan', (req, res) => {
  const self = getSelf(req);
  if (!self) return res.status(404).json({ error: 'Usuario no encontrado' });
  const deviceCount = db.prepare('select count(*) c from devices where owner_user_id = ?').get(self.id).c;
  res.json({
    email: self.email,
    plan_name: self.plan_name || 'Sin plan',
    max_devices: self.max_devices ?? 0,
    device_count: deviceCount,
    plan_expires_at: self.plan_expires_at,
    status: self.status,
  });
});

router.get('/me/devices', (req, res) => {
  const rows = db.prepare('select * from devices where owner_user_id = ? order by claimed_at desc').all(req.user.sub);
  const enriched = rows.map((d) => ({ ...d, live: deviceInfo.enrichDevice(d.rustdesk_id) }));
  res.json(enriched);
});

router.post('/me/devices', (req, res) => {
  const { rustdesk_id, alias } = req.body || {};
  if (!rustdesk_id) return res.status(400).json({ error: 'rustdesk_id es requerido' });

  const self = getSelf(req);
  if (self.status !== 'active') return res.status(403).json({ error: 'Cuenta suspendida' });
  if (self.plan_expires_at && new Date(self.plan_expires_at) < new Date()) {
    return res.status(403).json({ error: 'Tu plan ha expirado, contacta al administrador' });
  }

  if (hbbsDb.isAvailable() && !hbbsDb.peerExists(rustdesk_id.trim())) {
    return res.status(400).json({ error: 'Ese ID de RustDesk no esta registrado en el servidor' });
  }

  const currentCount = deviceClaim.countDevices(self.id);
  const limit = self.max_devices ?? 0;
  if (currentCount >= limit) {
    return res.status(400).json({ error: `Alcanzaste el limite de ${limit} equipo(s) de tu plan (${self.plan_name || 'sin plan'})` });
  }

  try {
    const info = deviceClaim.claimDevice(self.id, rustdesk_id.trim(), alias || null, {
      actorUserId: self.id,
      source: 'client_panel',
    });
    res.status(201).json(db.prepare('select * from devices where id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ese equipo ya esta reclamado' : e.message });
  }
});

router.delete('/me/devices/:id', (req, res) => {
  const device = db.prepare('select * from devices where id = ? and owner_user_id = ?').get(req.params.id, req.user.sub);
  if (!device) return res.status(404).json({ error: 'Equipo no encontrado' });
  deviceClaim.releaseDevice(req.user.sub, device.rustdesk_id);
  res.json({ ok: true });
});

router.get('/me/payments', (req, res) => {
  res.json(db.prepare('select * from payments where user_id = ? order by created_at desc').all(req.user.sub));
});

// Mensajes/alertas propios: los suyos + los de broadcast (user_id null).
// read_by_me es por-usuario (tabla alert_reads), asi que un broadcast leido
// por un cliente no se oculta para los demas.
router.get('/me/alerts', (req, res) => {
  res.json(db.prepare(`
    select a.*, (ar.user_id is not null) as read_by_me
    from alerts a
    left join alert_reads ar on ar.alert_id = a.id and ar.user_id = ?
    where a.user_id = ? or a.user_id is null
    order by a.created_at desc
    limit 100
  `).all(req.user.sub, req.user.sub));
});

router.post('/me/alerts/:id/read', (req, res) => {
  const alert = db.prepare('select * from alerts where id = ? and (user_id = ? or user_id is null)').get(req.params.id, req.user.sub);
  if (!alert) return res.status(404).json({ error: 'No encontrado' });
  db.prepare('insert or ignore into alert_reads (alert_id, user_id) values (?, ?)').run(alert.id, req.user.sub);
  res.json({ ok: true });
});

// ScreenCam: el cliente ve sus equipos y elige en cuales gastar el cupo que
// le dio su plan (ver docs/CLIENT_INTEGRATION.md seccion 12). Mismo shape
// que consume el admin en GET /api/admin/users/:id/screen-cam.
router.get('/me/screen-cam', (req, res) => {
  res.json(screenCamPolicy.listDevicesForCustomer(req.user.sub));
});

function handleModuleError(res, e) {
  const statusByCode = { NOT_FOUND: 404, NOT_LICENSED: 403, QUOTA_EXCEEDED: 409 };
  const status = statusByCode[e.code] || 400;
  res.status(status).json({ error: e.message });
}

router.post('/me/screen-cam/devices/:rustdeskId/activate', (req, res) => {
  try {
    screenCamPolicy.activateDevice(req.user.sub, String(req.params.rustdeskId));
    res.json({ ok: true });
  } catch (e) {
    handleModuleError(res, e);
  }
});

router.post('/me/screen-cam/devices/:rustdeskId/deactivate', (req, res) => {
  try {
    screenCamPolicy.deactivateDevice(req.user.sub, String(req.params.rustdeskId));
    res.json({ ok: true });
  } catch (e) {
    handleModuleError(res, e);
  }
});

module.exports = router;
