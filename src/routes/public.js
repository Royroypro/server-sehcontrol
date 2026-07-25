const express = require('express');
const db = require('../db/adminDb');
const rustdeskKey = require('../rustdeskKey');
const clientDownload = require('../clientDownload');

const router = express.Router();

router.get('/client-download/status', (req, res) => {
  res.set('Cache-Control', 'no-store').json(clientDownload.getAllClientInfo());
});

function clientDownloadHandler(platform) {
  return (req, res) => {
    const info = clientDownload.getClientInfo(platform);
    if (!info.available) return res.status(404).json({ error: 'El cliente aun no esta disponible' });
    res.download(clientDownload.platformPath(platform), info.filename);
  };
}

router.get('/client-download/windows', clientDownloadHandler('windows'));
router.get('/client-download/android', clientDownloadHandler('android'));
// Alias retrocompatible con el enlace original, de antes de soportar Android.
router.get('/client-download', clientDownloadHandler('windows'));

router.get('/server-key', (req, res) => {
  try {
    const serverKey = rustdeskKey.getPublicKeyInfo();
    if (!serverKey) return res.status(503).json({ error: 'La key del servidor aun no esta disponible' });
    res.set('Cache-Control', 'no-store').json(serverKey);
  } catch (e) {
    res.status(500).json({ error: `No se pudo leer la key del servidor: ${e.message}` });
  }
});

router.get('/plans', (req, res) => {
  const settings = db.prepare(`
    select business_name, whatsapp_number, default_currency
    from platform_settings where id = 1
  `).get();
  const plans = db.prepare(`
    select id, name, description, max_devices, price_cents, currency, duration_days
    from plans where is_public = 1
    order by price_cents asc, id asc
  `).all();

  res.json({
    business_name: settings?.business_name || 'Sehcontrol',
    whatsapp_number: settings?.whatsapp_number || null,
    default_currency: settings?.default_currency || 'USD',
    plans,
  });
});

module.exports = router;
