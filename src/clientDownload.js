const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.ADMIN_DATA_PATH || './data');
const downloadDir = path.join(dataDir, 'downloads');
const clientPath = path.join(downloadDir, 'sehcontrol.exe');

function getClientInfo() {
  if (!fs.existsSync(clientPath)) return { available: false };
  const stat = fs.statSync(clientPath);
  return {
    available: true,
    filename: 'sehcontrol.exe',
    size_bytes: stat.size,
    updated_at: stat.mtime.toISOString(),
    download_url: '/api/public/client-download',
  };
}

function saveClient(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error('El archivo no parece ser un ejecutable de Windows valido');
  }

  fs.mkdirSync(downloadDir, { recursive: true });
  const tempPath = `${clientPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, buffer, { mode: 0o644 });
  fs.renameSync(tempPath, clientPath);
  return getClientInfo();
}

module.exports = { clientPath, getClientInfo, saveClient };
