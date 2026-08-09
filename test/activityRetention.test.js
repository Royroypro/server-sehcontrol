const test = require('node:test');
const assert = require('node:assert');
const { setupTestEnv } = require('./helpers/env');

const env = setupTestEnv();
const db = require('../src/db/adminDb');
const {
  ACTIVITY_RETENTION_DAYS,
  cleanupActivityLog,
} = require('../src/notifications');

test.after(() => {
  db.close();
  env.cleanup();
});

test('la actividad conserva como maximo los ultimos siete dias', () => {
  assert.strictEqual(ACTIVITY_RETENTION_DAYS, 7);
  const now = Date.UTC(2026, 7, 9, 12, 0, 0);
  const insert = db.prepare(`
    insert into activity_log (action, detail, created_at)
    values (?, ?, ?)
  `);

  insert.run('old', 'ocho dias', '2026-08-01 11:59:59');
  insert.run('boundary', 'exactamente siete dias', '2026-08-02 12:00:00');
  insert.run('recent', 'seis dias', '2026-08-03 12:00:00');

  assert.strictEqual(cleanupActivityLog(now), 1);
  assert.deepStrictEqual(
    db.prepare('select action from activity_log order by created_at').all(),
    [{ action: 'boundary' }, { action: 'recent' }],
  );
});
