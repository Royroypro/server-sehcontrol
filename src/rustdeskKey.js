const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.RUSTDESK_DATA_PATH || './rustdesk-data');
const privateKeyPath = path.join(dataDir, 'id_ed25519');
const publicKeyPath = path.join(dataDir, 'id_ed25519.pub');

function readPublicKey() {
  if (!fs.existsSync(publicKeyPath)) return null;
  const publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();
  if (Buffer.from(publicKey, 'base64').length !== 32) {
    throw new Error('La key publica de RustDesk tiene un formato invalido');
  }
  return publicKey;
}

function getPublicKeyInfo() {
  const publicKey = readPublicKey();
  if (!publicKey) return null;

  return {
    algorithm: 'Ed25519',
    public_key: publicKey,
    fingerprint_sha256: crypto
      .createHash('sha256')
      .update(Buffer.from(publicKey, 'base64'))
      .digest('hex'),
    updated_at: fs.statSync(publicKeyPath).mtime.toISOString(),
  };
}

function generateRustdeskKeyPair() {
  // RustDesk evita "/" en la key publica para que sea facil usarla en URLs
  // y configuraciones. La probabilidad de necesitar muchos intentos es baja.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    const seed = privateDer.subarray(-32);
    const publicBytes = publicDer.subarray(-32);
    const encodedPublicKey = publicBytes.toString('base64');

    if (!encodedPublicKey.includes('/')) {
      return {
        privateKey: Buffer.concat([seed, publicBytes]).toString('base64'),
        publicKey: encodedPublicKey,
      };
    }
  }
  throw new Error('No se pudo generar una key compatible');
}

function writeAtomic(filePath, content, mode) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, mode);
}

function rotateKeyPair() {
  fs.mkdirSync(dataDir, { recursive: true });
  const backupDir = path.join(dataDir, 'key-backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(privateKeyPath)) {
    fs.copyFileSync(privateKeyPath, path.join(backupDir, `id_ed25519.${stamp}`));
  }
  if (fs.existsSync(publicKeyPath)) {
    fs.copyFileSync(publicKeyPath, path.join(backupDir, `id_ed25519.pub.${stamp}`));
  }

  const pair = generateRustdeskKeyPair();
  writeAtomic(privateKeyPath, pair.privateKey, 0o600);
  writeAtomic(publicKeyPath, pair.publicKey, 0o644);

  // Cada contenedor consume su propio marcador para reiniciar el proceso.
  fs.writeFileSync(path.join(dataDir, '.reload-hbbs'), stamp);
  fs.writeFileSync(path.join(dataDir, '.reload-hbbr'), stamp);

  return pair.publicKey;
}

module.exports = {
  readPublicKey,
  getPublicKeyInfo,
  rotateKeyPair,
  generateRustdeskKeyPair,
};
