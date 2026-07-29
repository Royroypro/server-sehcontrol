// Caracterizacion del parser de streamid de MediaMTX 1.9.3.
//
// Esta prueba NO ejercita codigo del servidor: reproduce localmente la rama
// relevante del parser oficial para dejar documentado, de forma ejecutable,
// por que el formato que hoy figura en docs/CLIENT_INTEGRATION.md nunca
// puede funcionar.
//
// Fuente: bluenviron/mediamtx, tag v1.9.3,
// internal/servers/srt/streamid.go, funcion (*streamID).unmarshal, rama
// "else" (sintaxis simple, la que no empieza con "#!::"):
//
//     parts := strings.Split(raw, ":")
//     if len(parts) < 2 || len(parts) > 5 { return error }
//     switch parts[0] { case "read": ...; case "publish": ...; default: error }
//     s.path = parts[1]
//     if len(parts) == 4 || len(parts) == 5 { s.user, s.pass = parts[2], parts[3] }
//     if len(parts) == 3 { s.query = parts[2] } else if len(parts) == 5 { s.query = parts[4] }
//
// Lo decisivo: divide por ":" y NUNCA por "?".
const test = require('node:test');
const assert = require('node:assert');

// Port fiel de la rama simple del parser. Solo para pruebas.
function parseStreamId(raw) {
  if (raw.startsWith('#!::')) {
    throw new Error('sintaxis estandar Haivision: fuera del alcance de esta prueba');
  }
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 5) {
    throw new Error("stream ID must be 'action:pathname[:query]' or 'action:pathname:user:pass[:query]'");
  }
  if (parts[0] !== 'read' && parts[0] !== 'publish') {
    throw new Error("stream ID must be 'action:pathname[:query]' or 'action:pathname:user:pass[:query]'");
  }
  const out = { action: parts[0], path: parts[1], user: '', pass: '', query: '' };
  if (parts.length === 4 || parts.length === 5) {
    out.user = parts[2];
    out.pass = parts[3];
  }
  if (parts.length === 3) out.query = parts[2];
  else if (parts.length === 5) out.query = parts[4];
  return out;
}

test('formato correcto: publish:pv_123:token=ABC separa path y query', () => {
  const parsed = parseStreamId('publish:pv_123:token=ABC');
  assert.strictEqual(parsed.action, 'publish');
  assert.strictEqual(parsed.path, 'pv_123');
  assert.strictEqual(parsed.query, 'token=ABC');
});

test('formato antiguo incorrecto: publish:pv_123?token=ABC mete el token DENTRO del path', () => {
  const parsed = parseStreamId('publish:pv_123?token=ABC');
  assert.strictEqual(parsed.action, 'publish');
  // El "?" no es separador para MediaMTX: queda pegado al path.
  assert.strictEqual(parsed.path, 'pv_123?token=ABC');
  assert.strictEqual(parsed.query, '');
});

test('consecuencia: con el formato con ?token dentro del path, media-auth no encuentra token ni sesion', () => {
  const parsed = parseStreamId('publish:pv_123?token=ABC');
  // Asi es como src/routes/clientExtensions.js extrae el token del query.
  const token = new URLSearchParams(parsed.query).get('token');
  assert.strictEqual(token, null, 'no hay token que validar');
  // Y el path tampoco coincide con ningun session_id guardado.
  assert.notStrictEqual(parsed.path, 'pv_123');
});

test('con el formato correcto, media-auth si extrae el token', () => {
  const parsed = parseStreamId('publish:pv_123:token=ABC');
  const token = new URLSearchParams(parsed.query).get('token');
  assert.strictEqual(token, 'ABC');
  assert.strictEqual(parsed.path, 'pv_123');
});

test('los tokens base64url no colisionan con el separador ":"', () => {
  // crypto.randomBytes(24).toString('base64url') usa [A-Za-z0-9-_], sin ":".
  const token = require('node:crypto').randomBytes(24).toString('base64url');
  assert.doesNotMatch(token, /[:?=]/);
  const parsed = parseStreamId(`publish:pv_123:token=${token}`);
  assert.strictEqual(parsed.path, 'pv_123');
  assert.strictEqual(new URLSearchParams(parsed.query).get('token'), token);
});

test('un streamid de una sola parte es invalido para MediaMTX', () => {
  assert.throws(() => parseStreamId('pv_123'));
});

// ------------------------------------------------------------------
// Regresion documental: la guia que leen los desarrolladores del
// cliente no debe volver a describir el formato con "?", porque ese
// formato hace que toda publicacion sea rechazada con 401.
// Solo lee el archivo del repo; no usa red ni imprime tokens.
// ------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

function readIntegrationDoc() {
  return fs.readFileSync(
    path.resolve(__dirname, '..', 'docs', 'CLIENT_INTEGRATION.md'),
    'utf8',
  );
}

test('la documentacion describe el formato correcto de streamid', () => {
  const doc = readIntegrationDoc();
  // La plantilla generica y al menos un ejemplo concreto con path real.
  assert.match(doc, /publish:<stream_name>:token=<publish_token>/);
  assert.match(doc, /publish:pv_[0-9a-f]{10}:token=\S+/);
});

test('la documentacion NO contiene el patron incorrecto publish:<path>?token=', () => {
  const doc = readIntegrationDoc();
  const wrongPattern = /publish:[A-Za-z0-9_<>]+\?token=/g;
  const offenders = doc.match(wrongPattern) || [];
  // El unico uso admitido es dentro del bloque que explica por que ese
  // formato esta MAL. Se identifica por la marca "← no coincide" / "(vacío)"
  // que acompana a ese ejemplo pedagogico.
  const explanatoryBlock = doc.includes('path   = pv_8f12ab34c5?token=ABC')
    && doc.includes('query  = (vacío)');
  assert.ok(
    explanatoryBlock,
    'el bloque que explica por que el formato con "?" es incorrecto debe seguir presente',
  );
  // Fuera de ese bloque explicativo, no debe quedar ninguna INSTRUCCION que
  // use el formato con "?". Se comprueba que ninguna de las ocurrencias este
  // en una linea que suene a indicacion de uso.
  const instructionLines = doc.split('\n').filter((line) => (
    wrongPattern.test(line)
    && !line.includes('←')
    && !line.trimStart().startsWith('publish:pv_8f12ab34c5?token=ABC')
  ));
  assert.deepStrictEqual(instructionLines, [], 'no debe haber instrucciones con el formato "?"');
});

test('la documentacion no muestra URLs con ?token= dentro del valor de streamid', () => {
  const doc = readIntegrationDoc();
  // Un streamid=... seguido de "?token=" antes de terminar el valor.
  const badUrl = /streamid=[^\s`]*\?token=/;
  assert.doesNotMatch(doc, badUrl, 'ninguna URL de ejemplo debe meter ?token= dentro de streamid');
  // Y la URL correcta si debe estar presente.
  assert.match(doc, /streamid=publish:pv_[0-9a-f]{10}:token=/);
});

test('la documentacion explica que el token llega como query en el tercer segmento', () => {
  const doc = readIntegrationDoc();
  assert.match(doc, /action:pathname\[:query\]/, 'debe citar la sintaxis de MediaMTX');
  assert.match(doc, /query\s*=\s*token=/, 'debe mostrar que el tercer segmento es el query');
  assert.ok(
    doc.includes('nunca por `?`') || doc.includes('nunca por "?"'),
    'debe decir explicitamente que MediaMTX no divide por "?"',
  );
});

test('la documentacion lista las validaciones que debe hacer el cliente', () => {
  const doc = readIntegrationDoc();
  assert.match(doc, /`pv_` seguido de 10 caracteres hexadecimales/);
  assert.match(doc, /base64url/);
  assert.ok(doc.includes('No registren el `streamid` completo'), 'debe pedir no loguear el streamid');
});
