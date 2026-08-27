// Pruebas de configuracion del gateway multimedia.
//
// No parsean YAML (no se agregan dependencias): trabajan sobre las lineas
// "efectivas" del archivo, es decir descartando comentarios y lineas vacias.
// El objetivo es que un cambio descuidado no exponga la API de control, que
// no tiene autenticacion propia.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function readFile(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

// Lineas sin comentarios ni vacias. Se quita tambien el comentario que
// pueda venir al final de una linea con valor.
function effectiveLines(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trimEnd())
    .filter((line) => line.trim().length > 0);
}

function countEffective(text, predicate) {
  return effectiveLines(text).filter(predicate).length;
}

const mediamtxYml = readFile('production/mediamtx.yml');
const composeYaml = readFile('production/compose.yaml');

// ---------- API de control ----------

test('existe exactamente una linea efectiva `api: yes`', () => {
  const matches = countEffective(mediamtxYml, (l) => /^api:\s*yes\s*$/.test(l.trim()));
  assert.strictEqual(matches, 1, 'debe haber exactamente una clave api habilitada');
});

test('existe exactamente una linea efectiva `apiAddress: 127.0.0.1:9997`', () => {
  const matches = countEffective(mediamtxYml, (l) => /^apiAddress:\s*127\.0\.0\.1:9997\s*$/.test(l.trim()));
  assert.strictEqual(matches, 1, 'la API debe escuchar solo en localhost');
});

test('la API NO esta vinculada publicamente', () => {
  const lines = effectiveLines(mediamtxYml).map((l) => l.trim());
  const publicBindings = lines.filter((l) => (
    /^apiAddress:\s*:\d+\s*$/.test(l)                       // apiAddress: :9997
    || /^apiAddress:\s*0\.0\.0\.0:\d+\s*$/.test(l)          // apiAddress: 0.0.0.0:9997
    || /^apiAddress:\s*\[::\]:\d+\s*$/.test(l)              // apiAddress: [::]:9997
  ));
  assert.deepStrictEqual(publicBindings, [], 'apiAddress no debe escuchar en todas las interfaces');
});

test('solo la accion interna api queda excluida del callback de autorizacion', () => {
  const lines = effectiveLines(mediamtxYml).map((l) => l.trim());
  const excludeIndex = lines.indexOf('authHTTPExclude:');
  assert.notStrictEqual(excludeIndex, -1, 'debe declararse authHTTPExclude');
  assert.strictEqual(lines[excludeIndex + 1], '- action: api');
  assert.ok(!lines.includes('authHTTPExclude: []'), 'la API de control debe poder operar');
  assert.ok(!lines.includes('- action: publish'), 'publish debe seguir autorizado por el panel');
  assert.ok(!lines.includes('- action: read'), 'read debe seguir autorizado por el panel');
});

// ---------- Compose ----------

test('production/compose.yaml no publica ni menciona el puerto 9997', () => {
  const mentions = effectiveLines(composeYaml).filter((l) => l.includes('9997'));
  assert.deepStrictEqual(mentions, [], 'el puerto de la API no debe aparecer en compose');
});

test('el servicio mediamtx conserva network_mode: host', () => {
  const matches = countEffective(composeYaml, (l) => /^\s*network_mode:\s*host\s*$/.test(l));
  assert.ok(matches >= 1, 'network_mode: host debe seguir presente');
  // Y puntualmente en el servicio del gateway.
  const mediamtxBlock = composeYaml.slice(composeYaml.indexOf('mediamtx:'));
  assert.match(mediamtxBlock, /network_mode:\s*host/);
});

// ---------- Protocolos de entrada y salida ----------

test('SRT continua habilitado en UDP 8890', () => {
  const lines = effectiveLines(mediamtxYml).map((l) => l.trim());
  assert.ok(lines.includes('srt: yes'), 'srt debe seguir habilitado');
  assert.ok(lines.includes('srtAddress: :8890'), 'srt debe seguir en el puerto 8890');
});

test('WebRTC continua con ICE en UDP 8189 y HTTP solo en localhost', () => {
  const lines = effectiveLines(mediamtxYml).map((l) => l.trim());
  assert.ok(lines.includes('webrtc: yes'), 'webrtc debe seguir habilitado');
  assert.ok(lines.includes('webrtcLocalUDPAddress: :8189'), 'el ICE debe seguir en 8189');
  assert.ok(
    lines.includes('webrtcAddress: 127.0.0.1:8889'),
    'el WHEP se sirve por nginx, no directo: debe quedar en localhost',
  );
});

test('RTSP, RTMP y HLS continuan deshabilitados', () => {
  const lines = effectiveLines(mediamtxYml).map((l) => l.trim());
  for (const key of ['rtsp', 'rtmp', 'hls']) {
    assert.ok(lines.includes(`${key}: no`), `${key} debe seguir deshabilitado`);
  }
});

test('record: no continua vigente', () => {
  const matches = countEffective(mediamtxYml, (l) => /^\s*record:\s*no\s*$/.test(l));
  assert.ok(matches >= 1, 'no debe habilitarse la grabacion');
  // Y que no exista ningun record: yes en el archivo.
  const recordYes = countEffective(mediamtxYml, (l) => /^\s*record:\s*yes\s*$/.test(l));
  assert.strictEqual(recordYes, 0, 'no debe existir ninguna grabacion habilitada');
});

// ---------- Secretos ----------

test('la configuracion no contiene credenciales, tokens ni passphrases', () => {
  const lines = effectiveLines(mediamtxYml).map((l) => l.trim());
  const forbidden = [
    /^srtPassphrase:\s*\S+/i,
    /^.*passphrase:\s*\S+/i,
    /^authInternalUsers:/i,
    /^readUser:\s*\S+/i,
    /^readPass:\s*\S+/i,
    /^publishUser:\s*\S+/i,
    /^publishPass:\s*\S+/i,
    /token:\s*\S+/i,
  ];
  const offenders = lines.filter((l) => forbidden.some((re) => re.test(l)));
  assert.deepStrictEqual(offenders, [], 'no debe haber secretos embebidos en el YAML');
});

// ---------- Nginx ----------

test('la API no se expone desde ninguna configuracion de Nginx del repo', () => {
  const nginxFiles = fs.readdirSync(path.join(REPO, 'production'))
    .filter((f) => f.includes('nginx'));
  assert.ok(nginxFiles.length > 0, 'deberia existir al menos una config de nginx que revisar');
  for (const file of nginxFiles) {
    const conf = readFile(path.join('production', file));
    assert.ok(!conf.includes('9997'), `${file} no debe referenciar el puerto de la API`);
    assert.ok(!/proxy_pass\s+https?:\/\/[^;]*9997/.test(conf), `${file} no debe proxear la API`);
  }
});
