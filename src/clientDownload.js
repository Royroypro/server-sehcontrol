const fs = require('fs');
const path = require('path');
const db = require('./db/adminDb');

const dataDir = path.resolve(process.env.ADMIN_DATA_PATH || './data');
const downloadDir = path.join(dataDir, 'downloads');

const PLATFORMS = {
  windows: {
    filename: 'sehcontrol.exe',
    magicBytes: [0x4d, 0x5a], // "MZ", cabecera de ejecutables PE de Windows
    invalidMessage: 'El archivo no parece ser un ejecutable de Windows valido',
  },
  android: {
    filename: 'sehcontrol.apk',
    magicBytes: [0x50, 0x4b], // "PK", cabecera de ZIP (los APK son un ZIP)
    invalidMessage: 'El archivo no parece ser un paquete de Android (.apk) valido',
  },
};

function platformPath(platform) {
  return path.join(downloadDir, PLATFORMS[platform].filename);
}

// Solo digitos y puntos: es lo que el cliente compara numericamente
// (get_version_number en src/common.rs del cliente). Una version con sufijos
// no se puede ordenar de forma confiable contra la que corre en el equipo, asi
// que se rechaza al declararla en vez de anunciarse y no aplicarse nunca.
const VERSION_PATTERN = /^\d+(\.\d+){1,3}$/;
const MAX_NOTES_LENGTH = 2000;

function isValidClientVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version.trim());
}

function readRelease(platform) {
  try {
    const row = db.prepare(
      `select client_version_${platform} as version, client_notes_${platform} as notes
       from platform_settings where id = 1`,
    ).get();
    const version = row && typeof row.version === 'string' ? row.version.trim() : '';
    const notes = row && typeof row.notes === 'string' ? row.notes : '';
    return { version: isValidClientVersion(version) ? version : '', notes };
  } catch (_) {
    // Migracion no corrida todavia: se comporta como "sin version declarada",
    // que es exactamente no anunciar ninguna actualizacion.
    return { version: '', notes: '' };
  }
}

function getClientInfo(platform) {
  const config = PLATFORMS[platform];
  const clientPath = platformPath(platform);
  const release = readRelease(platform);
  if (!fs.existsSync(clientPath)) return { available: false, version: release.version };
  const stat = fs.statSync(clientPath);
  return {
    available: true,
    filename: config.filename,
    size_bytes: stat.size,
    updated_at: stat.mtime.toISOString(),
    download_url: `/api/public/client-download/${platform}`,
    version: release.version,
    notes: release.notes,
  };
}

// La version se declara por separado del binario a proposito: subir el archivo
// y anunciarlo son dos decisiones distintas, y esto permite corregir una
// version mal escrita sin volver a subir 100 MB.
function setClientRelease(platform, version, notes) {
  if (!PLATFORMS[platform]) throw new Error('Plataforma desconocida');
  const trimmed = typeof version === 'string' ? version.trim() : '';
  // Vacio es valido y significa "dejar de anunciar".
  if (trimmed !== '' && !isValidClientVersion(trimmed)) {
    throw new Error('La version debe ser numerica, por ejemplo 1.4.9');
  }
  const safeNotes = typeof notes === 'string' ? notes.slice(0, MAX_NOTES_LENGTH) : '';
  db.prepare(
    `update platform_settings
     set client_version_${platform} = ?, client_notes_${platform} = ?
     where id = 1`,
  ).run(trimmed, safeNotes);
  return getClientInfo(platform);
}

function getAllClientInfo() {
  return Object.fromEntries(Object.keys(PLATFORMS).map((platform) => [platform, getClientInfo(platform)]));
}

function saveClient(platform, buffer) {
  const config = PLATFORMS[platform];
  const [b0, b1] = config.magicBytes;
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer[0] !== b0 || buffer[1] !== b1) {
    throw new Error(config.invalidMessage);
  }

  const clientPath = platformPath(platform);
  fs.mkdirSync(downloadDir, { recursive: true });
  const tempPath = `${clientPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, buffer, { mode: 0o644 });
  fs.renameSync(tempPath, clientPath);
  return getClientInfo(platform);
}

module.exports = {
  PLATFORMS,
  platformPath,
  getClientInfo,
  getAllClientInfo,
  saveClient,
  setClientRelease,
  isValidClientVersion,
};
