const fs = require('fs');
const crypto = require('crypto');
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

// Hash del binario publicado, para que quien lo descargue pueda comprobar que
// llego entero. Calcularlo son ~100 ms sobre 30 MB, y getClientInfo se llama en
// cada sondeo de actualizacion de cada equipo, asi que se memoriza.
//
// La clave es (tamano, mtime) y no la ruta: si alguien reemplaza el fichero a
// mano por fuera del panel, cualquiera de los dos cambia y el hash se recalcula
// solo. Un sidecar .sha256 en disco no daria esa garantia -- quedaria obsoleto
// en silencio, que es peor que no tener hash.
const hashCache = new Map();

function fileSha256(clientPath, stat) {
  const key = `${clientPath}|${stat.size}|${stat.mtimeMs}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(clientPath)).digest('hex');
  // Solo interesa la entrada vigente de cada plataforma; sin esto el mapa
  // creceria una entrada por cada version que se haya subido nunca.
  for (const previous of hashCache.keys()) {
    if (previous.startsWith(`${clientPath}|`)) hashCache.delete(previous);
  }
  hashCache.set(key, hash);
  return hash;
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
    sha256: fileSha256(clientPath, stat),
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

// `expectedBytes` es el Content-Length declarado por quien sube. Comprobarlo es
// el unico modo de distinguir "el binario entero" de "la parte que llego antes
// de que se cortara la conexion": los bytes magicos solo miran los dos primeros
// bytes, asi que un ejecutable truncado los pasa igual de bien que uno completo.
//
// Y sin esta comprobacion el truncado seria peor que un fallo ruidoso: la
// escritura es atomica, de modo que un binario incompleto quedaria publicado
// limpiamente y los equipos se lo descargarian creyendolo bueno.
function saveClient(platform, buffer, expectedBytes) {
  const config = PLATFORMS[platform];
  const [b0, b1] = config.magicBytes;
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer[0] !== b0 || buffer[1] !== b1) {
    throw new Error(config.invalidMessage);
  }
  if (Number.isInteger(expectedBytes) && expectedBytes > 0 && buffer.length !== expectedBytes) {
    throw new Error(
      `La subida quedo incompleta: se declararon ${expectedBytes} bytes y llegaron ${buffer.length}. `
      + 'No se publico nada; vuelva a intentarlo.',
    );
  }

  const clientPath = platformPath(platform);
  fs.mkdirSync(downloadDir, { recursive: true });
  const tempPath = `${clientPath}.${process.pid}.tmp`;
  // El rename solo ocurre despues de que los datos esten en disco de verdad:
  // sin el fsync, un corte de corriente entre ambos puede dejar publicado un
  // fichero de tamano correcto y contenido basura.
  const handle = fs.openSync(tempPath, 'w', 0o644);
  try {
    fs.writeSync(handle, buffer);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
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
