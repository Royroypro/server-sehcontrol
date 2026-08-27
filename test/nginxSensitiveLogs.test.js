const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(
  __dirname,
  '..',
  'production',
  'nginx-sehcontrol.conf',
);
const config = fs.readFileSync(configPath, 'utf8');

function extractBlock(source, marker, fromIndex = 0) {
  const markerIndex = source.indexOf(marker, fromIndex);
  assert.notStrictEqual(markerIndex, -1, `No se encontro ${marker}`);
  const openIndex = source.indexOf('{', markerIndex);
  assert.notStrictEqual(openIndex, -1, `No se encontro el bloque de ${marker}`);

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  assert.fail(`El bloque de ${marker} no esta cerrado`);
}

function assertSensitiveLocationDoesNotLog(location) {
  assert.match(location, /\baccess_log\s+off\s*;/);
  for (const unsafeVariable of [
    '$request',
    '$request_uri',
    '$args',
    '$query_string',
    '$arg_token',
  ]) {
    assert.ok(
      !location.includes(unsafeVariable),
      `${unsafeVariable} no debe aparecer en la ubicacion sensible`,
    );
  }
}

test('las ubicaciones sensibles desactivan por completo el access log', () => {
  assertSensitiveLocationDoesNotLog(extractBlock(config, 'location = /api/ws'));
  assertSensitiveLocationDoesNotLog(extractBlock(config, 'location /media/'));
});

test('la redireccion HTTP tampoco registra queries con credenciales', () => {
  const httpServer = extractBlock(config, 'server {');
  assert.match(httpServer, /\baccess_log\s+off\s*;/);
  assert.match(httpServer, /return\s+301\s+https:\/\/\$host\$request_uri\s*;/);
});

test('la configuracion conserva puertos y proxies de produccion', () => {
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8889\/\s*;/);
  assert.match(config, /proxy_pass\s+http:\/\/127\.0\.0\.1:8899\s*;/);
  assert.ok(!config.includes('9997'));

  let depth = 0;
  for (const character of config) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    assert.ok(depth >= 0, 'La configuracion cierra un bloque inexistente');
  }
  assert.strictEqual(depth, 0);
});
