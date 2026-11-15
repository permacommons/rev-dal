import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import DataAccessLayer from '../src/lib/data-access-layer.js';
import type { SaveOptions } from '../src/lib/model-types.js';
import { runInTransaction } from '../src/lib/transaction.js';
import types from '../src/lib/type.js';

test('transaction helpers reject a pool before executing work', async () => {
  const dal = new DataAccessLayer();
  const pool = new Pool();
  const options = { transaction: pool } as unknown as SaveOptions;
  let executed = false;
  const work = async () => {
    executed = true;
  };
  dal.transaction = async callback => {
    executed = true;
    return callback(null as unknown as PoolClient);
  };
  const Record = dal.createModel('records', { title: types.string() });
  try {
    await assert.rejects(() => runInTransaction(dal, options.transaction, work), /not a pool/);
    await assert.rejects(() => new Record({ title: 'test' }).saveAll({}, options), /not a pool/);
    await assert.rejects(() => new Record({ title: 'test' }).save(options), /not a pool/);
    assert.equal(executed, false);
  } finally {
    await pool.end();
  }
});

test('transaction helper joins a supplied client without owning its transaction', async () => {
  const dal = new DataAccessLayer();
  const client = {
    query() {
      assert.fail('helper must not issue transaction statements');
    },
    release() {
      assert.fail('caller owns the client');
    },
  } as unknown as PoolClient;
  dal.transaction = async () => assert.fail('must join the existing transaction');
  assert.equal(await runInTransaction(dal, client, async supplied => supplied), client);
});

test('transaction helper delegates to DAL when no client is supplied', async () => {
  const dal = new DataAccessLayer();
  const client = {} as PoolClient;
  let calls = 0;
  dal.transaction = async callback => {
    calls++;
    return callback(client);
  };
  for (const absent of [undefined, null]) {
    assert.equal(await runInTransaction(dal, absent, async supplied => supplied), client);
  }
  assert.equal(calls, 2);
});
