// Mock controlado de ws.pushToUser.
//
// screenCamPreview hace `const ws = require('./ws')` y llama
// `ws.pushToUser(...)`. Como el require.cache devuelve siempre el mismo
// objeto de exports, reemplazar la propiedad alcanza para interceptar los
// envios sin abrir ningun WebSocket real ni tocar la red.
const path = require('path');

function installWsMock() {
  const ws = require(path.resolve(__dirname, '..', '..', 'src', 'ws.js'));
  const originalPushToUser = ws.pushToUser;
  const originalPushToAll = ws.pushToAll;
  const sent = [];

  ws.pushToUser = (userId, payload) => {
    sent.push({ userId, payload });
    return 1;
  };
  ws.pushToAll = (payload) => {
    sent.push({ userId: null, payload });
    return 1;
  };

  return {
    sent,
    // Ultimo payload cuyo type/event coincida con el nombre dado. Se mira
    // en las dos formas a proposito: asi el helper sirve tanto para
    // caracterizar el formato actual como para verificar el corregido.
    lastByName(name) {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        const p = sent[i].payload;
        if (p?.type === name || p?.event === name) return p;
      }
      return null;
    },
    clear() {
      sent.length = 0;
    },
    restore() {
      ws.pushToUser = originalPushToUser;
      ws.pushToAll = originalPushToAll;
      sent.length = 0;
    },
  };
}

module.exports = { installWsMock };
