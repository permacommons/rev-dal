import assert from 'node:assert/strict';
import test from 'node:test';

import DataAccessLayer from '../src/lib/data-access-layer.js';
import { resolveTestConfig } from './helpers/postgres-fixture.js';

/**
 * Regression tests for DataAccessLayer.connect():
 * - `pool` is available as soon as connect() starts (apps read it while the
 *   connection is still being verified)
 * - concurrent connect() calls share one pool
 * - a failed connect leaves no pool behind
 */

test('connect() exposes the pool immediately and reports connected once verified', async () => {
  const dal = new DataAccessLayer(resolveTestConfig());
  try {
    const connecting = dal.connect();
    const earlyPool = dal.pool;
    assert.ok(earlyPool, 'pool is set before connect() resolves');
    assert.strictEqual(dal.isConnected(), false, 'not connected until verified');

    await connecting;
    assert.strictEqual(dal.pool, earlyPool, 'the same pool stays in place');
    assert.strictEqual(dal.isConnected(), true);
  } finally {
    await dal.disconnect();
  }
});

test('a caller that reads pool while another caller is connecting gets a usable pool', async () => {
  // Mirrors an app that starts connect() at module load and later, possibly
  // before it resolves, hands dal.pool to a library (e.g. a session store).
  const dal = new DataAccessLayer(resolveTestConfig());
  try {
    const startup = dal.connect();
    const pool = dal.pool;
    assert.ok(pool);
    const result = await pool.query('SELECT 1 AS ok');
    assert.strictEqual(result.rows[0].ok, 1);
    await startup;
  } finally {
    await dal.disconnect();
  }
});

test('concurrent connect() calls share one pool', async () => {
  const dal = new DataAccessLayer(resolveTestConfig());
  try {
    const first = dal.connect();
    const pool = dal.pool;
    const second = dal.connect();
    assert.strictEqual(dal.pool, pool, 'the second call does not replace the pool');

    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, dal);
    assert.strictEqual(b, dal);
    assert.strictEqual(dal.pool, pool);
    assert.strictEqual(dal.isConnected(), true);

    await dal.connect();
    assert.strictEqual(dal.pool, pool, 'connecting again is a no-op');
  } finally {
    await dal.disconnect();
  }
});

test('a failed connect() clears the pool it exposed', async () => {
  const dal = new DataAccessLayer({
    host: '127.0.0.1',
    port: 1,
    connectionTimeoutMillis: 1000,
  });

  const attempt = dal.connect();
  assert.ok(dal.pool, 'pool is exposed while the attempt runs');
  await assert.rejects(attempt);
  assert.strictEqual(dal.pool, null);
  assert.strictEqual(dal.isConnected(), false);
});
