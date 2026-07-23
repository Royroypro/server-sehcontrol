require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const membershipSync = require('./membershipSync');
const notifications = require('./notifications');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');
const hbbsHttpRoutes = require('./routes/hbbsHttp');
const clientExtensionsRoutes = require('./routes/clientExtensions');
const { initWebSocketServer } = require('./ws');

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/ayuda', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ayuda.html'));
});

app.get('/mas-informacion', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'mas-informacion.html'));
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
// Protocolo nativo del cliente RustDesk: rutas fijas /api/login, /api/currentUser, etc.
app.use('/api', hbbsHttpRoutes);
// Extensiones no estandar para un cliente modificado (ver docs/CLIENT_INTEGRATION.md)
app.use('/api', clientExtensionsRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const port = process.env.PORT || 8899;
const server = app.listen(port, () => {
  console.log(`rustdesk-admin-panel escuchando en http://localhost:${port}`);
  membershipSync.startPeriodicSync();
  notifications.startAlertScheduler();
});
initWebSocketServer(server);
console.log(`WebSocket de tiempo real en ws://localhost:${port}/api/ws?token=<access_token>`);
