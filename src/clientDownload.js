const fs = require('fs');
const path = require('path');

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

function getClientInfo(platform) {
  const config = PLATFORMS[platform];
  const clientPath = platformPath(platform);
  if (!fs.existsSync(clientPath)) return { available: false };
  const stat = fs.statSync(clientPath);
  return {
    available: true,
    filename: config.filename,
    size_bytes: stat.size,
    updated_at: stat.mtime.toISOString(),
    download_url: `/api/public/client-download/${platform}`,
  };
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

module.exports = { PLATFORMS, platformPath, getClientInfo, getAllClientInfo, saveClient };
