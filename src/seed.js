require('dotenv').config();
const db = require('./db/adminDb');
const { hashPassword } = require('./auth');

const plans = [
  { name: 'Free', max_devices: 1, price_cents: 0, duration_days: 3650 },
  { name: 'Pro', max_devices: 5, price_cents: 999, duration_days: 30 },
  { name: 'Enterprise', max_devices: 50, price_cents: 4999, duration_days: 30 },
];

for (const p of plans) {
  const exists = db.prepare('select 1 from plans where name = ?').get(p.name);
  if (!exists) {
    db.prepare('insert into plans (name, max_devices, price_cents, duration_days, is_public) values (?, ?, ?, ?, 1)')
      .run(p.name, p.max_devices, p.price_cents, p.duration_days);
    console.log(`Plan creado: ${p.name}`);
  }
}

const adminEmail = (process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'changeme123';
const existingAdmin = db.prepare('select 1 from users where email = ?').get(adminEmail);
if (!existingAdmin) {
  db.prepare('insert into users (email, password_hash, role) values (?, ?, ?)')
    .run(adminEmail, hashPassword(adminPassword), 'admin');
  console.log(`Usuario admin creado: ${adminEmail} / ${adminPassword} (cambia esta contrasena despues de entrar)`);
} else {
  console.log(`El admin ${adminEmail} ya existe, no se crea de nuevo.`);
}

console.log('Seed completado.');
