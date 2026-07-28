// Endpoints NO estandar, pensados para un cliente RustDesk modificado (ver
// docs/CLIENT_INTEGRATION.md). El cliente oficial no los llama y los ignora
// si no existen (no rompe nada usarlos con el cliente stock).
const express = require('express');
const db = require('../db/adminDb');
const { requireBearerAuth } = require('../auth');
const membershipSync = require('../membershipSync');
const { formatCurrency } = require('../format');
const rustdeskKey = require('../rustdeskKey');
const deviceClaim = require('../deviceClaim');
const screenCamPolicy = require('../screenCamPolicy');

const router = express.Router();

// Se consulta ANTES de loguearse (sin auth), en el arranque de la app, para
// decidir si se debe forzar el modal de login antes de mostrar la ventana
// principal. Toggle operativo via .env, sin tocar codigo.
//
// Acepta un query param opcional `id` (el rustdesk_id del propio equipo, que
// el cliente ya conoce localmente aunque no haya sesion activa) para poder
// devolver tambien la politica de ScreenCam de ese dispositivo -- necesario
// para que un equipo en modo "supervised" siga sin poder apagarse aunque el
// usuario cierre sesion o no la haya iniciado todavia en este arranque. Sin
// `id`, o si el equipo no esta reclamado por ninguna cuenta, se devuelve la
// politica por defecto (no licenciado).
// Numero de WhatsApp de soporte, configurable en el panel (Configuracion ->
// "Datos de la plataforma" -> WhatsApp para ventas). Valor unico a nivel
// instancia, no depende de cuenta ni plan. Se normaliza a solo digitos
// (sin "+") porque el cliente arma el link como https://wa.me/{numero}.
function getWhatsappNumber() {
  const row = db.prepare('select whatsapp_number from platform_settings where id = 1').get();
  const digits = String(row?.whatsapp_number || '').replace(/\D/g, '');
  return digits || null;
}

router.get('/client-policy', (req, res) => {
  try {
    const rustdeskId = typeof req.query.id === 'string' ? req.query.id.trim().slice(0, 100) : null;
    const owner = rustdeskId ? deviceClaim.getDeviceOwner(rustdeskId) : null;
    res.set('Cache-Control', 'no-store').json({
      force_login: (process.env.FORCE_LOGIN || 'true') === 'true',
      server_key: rustdeskKey.getPublicKeyInfo(),
      whatsapp_number: getWhatsappNumber(),
      screen_cam: screenCamPolicy.resolvePolicy(owner?.owner_user_id, rustdeskId),
    });
  } catch (e) {
    res.status(500).json({ error: `No se pudo leer la key del servidor: ${e.message}` });
  }
});

// Pensado para sondeo periodico (polling) desde el cliente ya logueado, para
// mostrar banners/modales de aviso o bloqueo en vivo sin depender de que el
// usuario intente conectarse a algo o reinicie la app.
router.get('/membership/status', requireBearerAuth, (req, res) => {
  const user = db.prepare(`
    select u.*, p.name as plan_name, p.max_devices, p.price_cents as plan_price_cents, p.currency as plan_currency
    from users u left join plans p on p.id = u.plan_id where u.id = ?
  `).get(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

  const deviceCount = db.prepare('select count(*) c from devices where owner_user_id = ?').get(user.id).c;
  // Misma logica que el push por WebSocket (membershipSync.membershipStatus)
  // -- una sola fuente de verdad para blocked/reason/message/days_left,
  // incluye el caso "vence pronto" (reason: "expiring_soon") que antes
  // solo devolvia "Cuenta activa" sin avisar nada hasta el bloqueo real.
  const { blocked, reason, message, daysLeft } = membershipSync.membershipStatus(user);

  // plan_amount = precio del plan vigente (lo que cuesta la membresia que
  // tiene ahora), separado de last_payment = el ultimo pago que realmente
  // se le registro (puede diferir: adelantos parciales, descuentos, etc).
  const lastPayment = db.prepare(`
    select amount_cents, currency, concept, created_at from payments
    where user_id = ? order by created_at desc limit 1
  `).get(user.id);

  res.json({
    blocked,
    reason,
    message,
    plan_name: user.plan_name || null,
    plan_expires_at: user.plan_expires_at || null,
    days_left: daysLeft,
    device_count: deviceCount,
    max_devices: user.max_devices ?? null,
    plan_amount: user.plan_price_cents ?? null,
    plan_currency: user.plan_currency || null,
    plan_amount_formatted: formatCurrency(user.plan_price_cents, user.plan_currency),
    last_payment: lastPayment ? {
      amount: lastPayment.amount_cents,
      currency: lastPayment.currency,
      amount_formatted: formatCurrency(lastPayment.amount_cents, lastPayment.currency),
      concept: lastPayment.concept || null,
      paid_at: lastPayment.created_at,
    } : null,
  });
});

// Mensajes/alertas para el usuario logueado: los suyos + broadcast (avisos
// automaticos de vencimiento y mensajes manuales del admin). Pensado para
// que el cliente modificado los muestre como notificacion/toast.
router.get('/messages', requireBearerAuth, (req, res) => {
  const onlyUnread = req.query.unread === '1';
  const rows = db.prepare(`
    select a.id, a.type, a.title, a.message, a.created_at,
           (ar.user_id is not null) as read
    from alerts a
    left join alert_reads ar on ar.alert_id = a.id and ar.user_id = ?
    where (a.user_id = ? or a.user_id is null)
      ${onlyUnread ? 'and ar.user_id is null' : ''}
    order by a.created_at desc
    limit 50
  `).all(req.user.sub, req.user.sub);
  res.json(rows);
});

router.post('/messages/:id/ack', requireBearerAuth, (req, res) => {
  const alert = db.prepare('select id from alerts where id = ? and (user_id = ? or user_id is null)').get(req.params.id, req.user.sub);
  if (!alert) return res.status(404).json({ error: 'No encontrado' });
  db.prepare('insert or ignore into alert_reads (alert_id, user_id) values (?, ?)').run(alert.id, req.user.sub);
  res.json({ ok: true });
});

// Panel del cliente para ScreenCam (docs/CLIENT_INTEGRATION.md seccion 12):
// el usuario final ve sus equipos y elige en cuales gastar el cupo que le
// dio su plan. Sin pantalla propia todavia (solo API), pero es lo que va a
// consumir esa pantalla cuando se construya.
router.get('/screen-cam/devices', requireBearerAuth, (req, res) => {
  res.json(screenCamPolicy.listDevicesForCustomer(req.user.sub));
});

function handleModuleError(res, e) {
  const statusByCode = { NOT_FOUND: 404, NOT_LICENSED: 403, QUOTA_EXCEEDED: 409 };
  const status = statusByCode[e.code] || 400;
  res.status(status).json({ error: e.message });
}

router.post('/screen-cam/devices/:rustdeskId/activate', requireBearerAuth, (req, res) => {
  try {
    screenCamPolicy.activateDevice(req.user.sub, String(req.params.rustdeskId));
    res.json({ ok: true });
  } catch (e) {
    handleModuleError(res, e);
  }
});

router.post('/screen-cam/devices/:rustdeskId/deactivate', requireBearerAuth, (req, res) => {
  try {
    screenCamPolicy.deactivateDevice(req.user.sub, String(req.params.rustdeskId));
    res.json({ ok: true });
  } catch (e) {
    handleModuleError(res, e);
  }
});

module.exports = router;
