const express = require('express');
const db = require('../db/adminDb');

const router = express.Router();

router.get('/plans', (req, res) => {
  const settings = db.prepare(`
    select business_name, whatsapp_number, default_currency
    from platform_settings where id = 1
  `).get();
  const plans = db.prepare(`
    select id, name, max_devices, price_cents, currency, duration_days
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
