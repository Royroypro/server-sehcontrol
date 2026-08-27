const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { startServer } = require('../../src/server');

const lifecycle = startServer({
  host: '127.0.0.1',
  port: 0,
  logger: () => {},
});

lifecycle.server.once('listening', () => {
  const address = lifecycle.server.address();
  const token = jwt.sign({ sub: 1 }, process.env.JWT_SECRET);
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/ws?token=${encodeURIComponent(token)}`,
  );
  socket.once('open', () => {
    if (typeof process.send !== 'function') {
      process.exitCode = 2;
      socket.close();
      return;
    }
    process.send({ type: 'ready', port: address.port }, () => {
      if (typeof process.disconnect === 'function') process.disconnect();
    });
  });
  socket.once('close', (code) => {
    if (code !== 1001) process.exitCode = 3;
  });
  socket.once('error', () => {
    process.exitCode = 4;
  });
});
