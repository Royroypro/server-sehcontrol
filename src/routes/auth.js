const express = require('express');
const db = require('../db/adminDb');
const nativeSessions = require('../nativeSessions');
const { closeUserConnections } = require('../ws');
const { verifyPassword, hashPassword, issueToken, requireAuth } = require('../auth');

const router = express.Router();
const cookieSecure = process.env.COOKIE_SECURE === 'true';

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y password son requeridos' });
  }
  const user = db.prepare('select * from users where email = ?').get(email.toLowerCase().trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales invalidas' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Cuenta suspendida' });
  }
  const token = issueToken(user);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true, role: user.role, email: user.email });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('select id, email, name, role, plan_id, plan_expires_at, status from users where id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user });
});

// Perfil propio: cualquier usuario logueado (admin o cliente) puede cambiar
// su nombre y su contrasena. Cambiar la contrasena exige la actual, por
// seguridad -- no queremos que un token robado sirva para bloquear al dueno
// real de la cuenta cambiandole la clave sin confirmar nada.
router.put('/me', requireAuth, (req, res) => {
  const { name, current_password, new_password } = req.body || {};
  const user = db.prepare('select * from users where id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  let newHash = user.password_hash;
  if (new_password) {
    if (!current_password || !verifyPassword(current_password, user.password_hash)) {
      return res.status(400).json({ error: 'La contrasena actual no es correcta' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'La nueva contrasena debe tener al menos 6 caracteres' });
    }
    newHash = hashPassword(new_password);
  }

  db.prepare('update users set name = ?, password_hash = ? where id = ?')
    .run(name !== undefined ? name : user.name, newHash, user.id);

  // Cambiar la contraseña invalida todas las sesiones persistentes nativas.
  // El usuario deberá autenticarse nuevamente en esos dispositivos.
  if (new_password) {
    nativeSessions.revokeUserNativeSessions(user.id);
    closeUserConnections(user.id);
  }

  res.json({ ok: true });
});

module.exports = router;
