// Doble controlado del cliente de la API de MediaMTX.
//
// stopPreview() acepta `options.mediaApi`, asi que las pruebas inyectan este
// objeto en vez de parchear `global.fetch`. No hace ninguna solicitud: con
// node --test corriendo archivos en paralelo, un parche global seria fragil
// y podria filtrarse entre suites.
function makeMediaApiMock(result = { status: 'kicked', matched: 1, kicked: 1 }) {
  const calls = [];
  let nextResult = result;
  let shouldThrow = null;

  return {
    calls,
    async kickSrtPublishersForPath(path, options) {
      calls.push({ path, options });
      if (shouldThrow) throw shouldThrow;
      return nextResult;
    },
    // Simula MediaMTX caido / inaccesible.
    setResult(next) {
      nextResult = next;
      shouldThrow = null;
    },
    // Caso extremo: el cliente lanza en vez de devolver un resumen.
    setThrows(err) {
      shouldThrow = err;
    },
    lastPath() {
      return calls.length ? calls[calls.length - 1].path : null;
    },
    reset() {
      calls.length = 0;
      nextResult = result;
      shouldThrow = null;
    },
  };
}

module.exports = { makeMediaApiMock };
