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

// La app corre detras de nginx y sin `trust proxy`, asi que `req.protocol` dice
// siempre "http" aunque el cliente haya llegado por HTTPS. Publicar esa URL
// haria que cada descarga empiece por un 301, o peor, por texto plano si algun
// dia el redirect no estuviera. Se usa X-Forwarded-Proto, que este nginx
// siempre fija (ver nginx-sehcontrol.conf), validado contra los dos unicos
// valores aceptables para no confiar en un encabezado arbitrario.
function publicOrigin(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const scheme = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol;
  return `${scheme}://${req.get('host')}`;
}

// Lo que consulta el cliente instalado para saber si hay una version nueva.
//
// Publico y sin autenticacion a proposito: un equipo que todavia no inicio
// sesion igual debe poder actualizarse, y la respuesta no expone nada que no
// este ya en la pagina de descarga. Devuelve 200 con version vacia -- en vez
// de 404 -- cuando no hay nada declarado, para que el cliente distinguga
// "no hay actualizacion" de "no pude preguntar" sin tratar un error de red
// como si fuera una respuesta.
router.get('/client-version/:platform', (req, res) => {
  const { platform } = req.params;
  if (!clientDownload.PLATFORMS[platform]) {
    return res.status(404).json({ error: 'Plataforma desconocida' });
  }
  const info = clientDownload.getClientInfo(platform);
  const announce = info.available && !!info.version;
  res.set('Cache-Control', 'no-store').json({
    version: announce ? info.version : '',
    // Absoluta: el cliente la usa tal cual, sin componer nombres de archivo.
    // Componerlos fue justamente lo que ato el flujo original al esquema de
    // URLs de GitHub.
    // Termina en el nombre del archivo a proposito: ver la ruta con
    // :filename mas arriba.
    url: announce ? `${publicOrigin(req)}${info.download_url}/${info.filename}` : '',
    notes: announce ? (info.notes || '') : '',
  });
});

// Misma descarga, pero con el nombre del archivo en la URL.
//
// El cliente instalado guarda la actualizacion usando el ultimo segmento de la
// URL como nombre local, y despues se niega a ejecutar nada que no termine en
// .exe o .msi. Con la URL terminada en "/windows" el archivo quedaba sin
// extension y la instalacion fallaba sin decir nada. El nombre se valida
// contra el esperado para que la ruta no acepte cualquier cosa.
router.get('/client-download/:platform/:filename', (req, res) => {
  const { platform, filename } = req.params;
  const config = clientDownload.PLATFORMS[platform];
  if (!config) return res.status(404).json({ error: 'Plataforma desconocida' });
  if (filename !== config.filename) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  return clientDownloadHandler(platform)(req, res);
});

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
