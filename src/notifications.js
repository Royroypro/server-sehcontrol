// Motor de alertas: genera avisos automaticos de vencimiento y permite
// mandar mensajes manuales. Siempre queda un registro en la tabla "alerts"
// (canal in-app, visible en ambos paneles y consultable por el cliente
// nativo via /api/messages). El envio por correo es opcional: si no hay SMTP
// configurado en .env, se guarda la alerta igual pero no se manda email
// (no revienta nada, solo se loguea que no se pudo enviar).
const nodemailer = require('nodemailer');
const db = require('./db/adminDb');
const ws = require('./ws');

let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = false; // marca "ya revisamos, no hay config"
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendEmail(to, subject, text) {
  const t = getTransporter();
  if (!t) {
    console.log(`[notifications] SMTP no configurado, no se envio email a ${to}: ${subject}`);
    return false;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return true;
  } catch (err) {
    console.error(`[notifications] fallo el envio de email a ${to}:`, err.message);
    return false;
  }
}

// Crea la alerta (in-app siempre) y, si se pide, intenta mandarla por correo.
// dedupeKey evita duplicar la misma alerta automatica dos veces (insert
// ignora si ya existe una fila con esa clave unica).
async function createAlert({ userId = null, type, title, message, dedupeKey = null, email = false, createdBy = null }) {
  let info;
  try {
    info = db.prepare(`
      insert into alerts (user_id, type, title, message, dedupe_key, created_by)
      values (?, ?, ?, ?, ?, ?)
    `).run(userId, type, title, message, dedupeKey, createdBy);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return null; // ya se habia mandado esta alerta, no duplicar
    throw e;
  }

  // Push inmediato por WebSocket a quien este conectado en este momento.
  // Si no hay nadie conectado (o el cliente no implementa ws todavia), no
  // pasa nada: la alerta ya quedo guardada y el polling de /api/messages
  // la va a traer igual, solo que no al instante.
  const pushPayload = {
    type: 'message',
    data: { id: info.lastInsertRowid, type: type, title, message, created_at: new Date().toISOString() },
  };
  if (userId) ws.pushToUser(userId, pushPayload);
  else ws.pushToAll(pushPayload);

  if (email) {
    const recipients = userId
      ? db.prepare('select email from users where id = ?').all(userId)
      : db.prepare("select email from users where role = 'client'").all();
    for (const r of recipients) {
      const sent = await sendEmail(r.email, title, message);
      if (sent) db.prepare('update alerts set email_sent = 1 where id = ?').run(info.lastInsertRowid);
    }
  }
  return info.lastInsertRowid;
}

const DEFAULT_THRESHOLDS_DAYS = [10, 7, 5, 3, 1];

// Configurable desde el panel (Configuracion -> Avisos de vencimiento).
// Guardado como JSON en platform_settings.expiry_warning_days.
function getExpiryThresholds() {
  const row = db.prepare('select expiry_warning_days from platform_settings where id = 1').get();
  try {
    const parsed = JSON.parse(row?.expiry_warning_days || '[]');
    if (Array.isArray(parsed) && parsed.length && parsed.every((d) => Number.isInteger(d) && d >= 0)) {
      return parsed;
    }
  } catch (_) {
    // config invalida o ausente: usar el default
  }
  return DEFAULT_THRESHOLDS_DAYS;
}

// Recorre usuarios activos con plan y genera avisos de vencimiento proximo,
// vencido, y suspension. dedupe_key incluye la fecha de vencimiento actual:
// si el usuario renueva, plan_expires_at cambia y los avisos se pueden
// volver a generar en el siguiente ciclo.
async function generateExpiryAlerts() {
  const thresholds = getExpiryThresholds();
  const users = db.prepare(`
    select id, email, status, plan_expires_at from users where role = 'client'
  `).all();

  let created = 0;
  for (const u of users) {
    if (u.status !== 'active') {
      const id = await createAlert({
        userId: u.id,
        type: 'suspended',
        title: 'Cuenta suspendida',
        message: `La cuenta ${u.email} esta suspendida.`,
        dedupeKey: `suspended:${u.id}`,
        email: true,
      });
      if (id) created++;
      continue;
    }
    if (!u.plan_expires_at) continue;
    const daysLeft = Math.ceil((new Date(u.plan_expires_at) - new Date()) / 86400000);
    if (daysLeft < 0) {
      const id = await createAlert({
        userId: u.id,
        type: 'expired',
        title: 'Plan vencido',
        message: `El plan de ${u.email} vencio el ${new Date(u.plan_expires_at).toLocaleDateString()}.`,
        dedupeKey: `expired:${u.id}:${u.plan_expires_at}`,
        email: true,
      });
      if (id) created++;
      continue;
    }
    for (const threshold of thresholds) {
      if (daysLeft === threshold) {
        const id = await createAlert({
          userId: u.id,
          type: 'expiry_warning',
          title: `Tu plan vence en ${threshold} dia(s)`,
          message: `El plan de ${u.email} vence el ${new Date(u.plan_expires_at).toLocaleDateString()} (en ${threshold} dia(s)).`,
          dedupeKey: `expiry_warning:${u.id}:${threshold}:${u.plan_expires_at}`,
          email: true,
        });
        if (id) created++;
      }
    }
  }
  return created;
}

function startAlertScheduler(intervalMs = 60 * 60 * 1000, options = {}) {
  if (!options || typeof options !== 'object') options = {};
  const generateAlerts = typeof options.generateExpiryAlerts === 'function'
    ? options.generateExpiryAlerts : generateExpiryAlerts;
  const setIntervalImpl = typeof options.setInterval === 'function'
    ? options.setInterval : setInterval;
  const clearIntervalImpl = typeof options.clearInterval === 'function'
    ? options.clearInterval : clearInterval;
  const logger = typeof options.logger === 'function'
    ? options.logger : (message) => console.error(message);
  let stopped = false;
  let intervalCleared = false;

  const logCycleFailure = () => {
    try {
      const result = logger('[notifications] operation=expiry-alert-scheduler code=cycle_failed');
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      // La generacion de alertas no depende del logger.
    }
  };
  const runProtectedGeneration = () => {
    if (stopped) return;
    try {
      const result = generateAlerts();
      if (result && typeof result.catch === 'function') result.catch(logCycleFailure);
    } catch (_) {
      logCycleFailure();
    }
  };

  runProtectedGeneration();
  const interval = setIntervalImpl(runProtectedGeneration, intervalMs);
  try {
    if (interval && typeof interval.unref === 'function') interval.unref();
  } catch (_) {
    // unref es una optimizacion de lifecycle, no una condicion funcional.
  }

  return Object.freeze({
    stop() {
      if (intervalCleared) return false;
      stopped = true;
      intervalCleared = true;
      try {
        clearIntervalImpl(interval);
      } catch (_) {
        // El flag impide nuevas ejecuciones aunque el timer inyectado falle.
      }
      return true;
    },
  });
}

function logActivity(actorUserId, action, targetType, targetId, detail) {
  db.prepare(`
    insert into activity_log (actor_user_id, action, target_type, target_id, detail)
    values (?, ?, ?, ?, ?)
  `).run(actorUserId ?? null, action, targetType ?? null, targetId != null ? String(targetId) : null, detail ?? null);
}

module.exports = { createAlert, sendEmail, generateExpiryAlerts, startAlertScheduler, logActivity };
