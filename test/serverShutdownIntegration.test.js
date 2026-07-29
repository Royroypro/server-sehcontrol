const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const CHILD_PATH = path.join(__dirname, 'helpers', 'serverShutdownChild.js');
const CHILD_TIMEOUT_MS = 8_000;

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child_ready_timeout')), CHILD_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onEarlyExit);
      child.removeListener('message', onMessage);
    };
    const onError = () => {
      cleanup();
      reject(new Error('child_start_failed'));
    };
    const onEarlyExit = () => {
      cleanup();
      reject(new Error('child_exited_before_ready'));
    };
    const onMessage = (message) => {
      if (!message || message.type !== 'ready' || !Number.isInteger(message.port)) return;
      cleanup();
      resolve(message);
    };
    child.once('error', onError);
    child.once('exit', onEarlyExit);
    child.on('message', onMessage);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child_shutdown_timeout')), CHILD_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('child_runtime_failed'));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`proceso real con intervalos y WebSocket abierto termina limpiamente por ${signal}`, async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sehcontrol-shutdown-'));
    const child = fork(CHILD_PATH, [], {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        ADMIN_DB_PATH: path.join(tmpDir, 'admin.sqlite3'),
        HBBS_DB_PATH: path.join(tmpDir, 'missing-hbbs.sqlite3'),
        RUSTDESK_DATA_PATH: path.join(tmpDir, 'rustdesk-data'),
        JWT_SECRET: 'shutdown-test-secret-no-usar-0123456789',
        MEDIA_PUBLISH_URL: 'srt://127.0.0.1:18890',
        MEDIA_PLAYBACK_BASE: 'http://127.0.0.1:18889/media',
        MEDIA_API_URL: 'http://127.0.0.1:19997',
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let exited = false;
    t.after(() => {
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const ready = await waitForReady(child);
    assert.ok(ready.port > 0 && ready.port < 65536);
    if (child.connected) {
      await new Promise((resolve) => child.once('disconnect', resolve));
    }

    const startedAt = Date.now();
    assert.strictEqual(child.kill(signal), true);
    const result = await waitForExit(child);
    exited = true;
    const elapsedMs = Date.now() - startedAt;

    assert.deepStrictEqual(result, { code: 0, signal: null });
    assert.ok(elapsedMs < 5_000, `shutdown demoro ${elapsedMs}ms`);
    assert.strictEqual(child.exitCode, 0);
    assert.strictEqual(child.signalCode, null);
  });
}
