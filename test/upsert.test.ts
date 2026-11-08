import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import types from '../src/lib/type.js';
import { createPostgresFixture, type PostgresFixture } from './helpers/postgres-fixture.js';

let fixture: PostgresFixture;
const schema = {
  id: types.string(),
  userKey: types.string().required(),
  status: types.string().required(),
  reason: types.string(),
  secret: types.string().sensitive().default('hidden-default'),
  computed: types.virtual(),
};
before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'upsert',
    tableDefs: [
      {
        name: 'overrides',
        create: table => `CREATE TABLE ${table} (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, reason TEXT, secret TEXT
    )`,
      },
    ],
    modelDefs: [
      { name: 'overrides', hasRevisions: false, schema, camelToSnake: { userKey: 'user_key' } },
    ],
  });
});
beforeEach(async () => {
  await fixture.cleanupTables(['overrides']);
});
after(async () => {
  if (fixture) await fixture.cleanup();
});
const options = { conflictFields: ['userKey'], updateFields: ['status'] };

test('inserts and updates by mapped unique key, returns persisted identity and selected fields', async () => {
  const Model = fixture.models.overrides;
  const first = await Model.upsert(
    { userKey: 'a', status: 'yes', reason: 'original', secret: 'private' },
    options
  );
  const updated = await Model.upsert({ userKey: 'a', status: 'no', reason: 'ignored' }, options);
  assert.equal(updated.id, first.id);
  assert.equal(updated.userKey, 'a');
  assert.equal(updated.status, 'no');
  assert.equal(updated.reason, 'original');
  assert.equal(first.secret, undefined);
  assert.equal(updated._isNew, false);
  assert.equal((updated._changed as Set<string>).size, 0);
  await updated.save();
});

test('concurrent upserts persist exactly one row', async () => {
  const rows = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      fixture.models.overrides.upsert({ userKey: 'race', status: String(i) }, options)
    )
  );
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  const result = await fixture.dal.query(`SELECT * FROM ${fixture.getTableName('overrides')}`);
  assert.equal(result.rows.length, 1);
});

test('honors sensitive update and return opt-ins', async () => {
  const Model = fixture.models.overrides;
  await Model.upsert({ userKey: 'a', status: 'yes', secret: 'old' }, options);
  await assert.rejects(
    Model.upsert(
      { userKey: 'a', status: 'yes', secret: 'new' },
      {
        ...options,
        updateFields: ['secret'],
      }
    ),
    /updateSensitive/
  );
  const updated = await Model.upsert(
    { userKey: 'a', status: 'yes', secret: 'new' },
    {
      ...options,
      updateFields: ['secret'],
      updateSensitive: ['secret'],
      includeSensitive: ['secret'],
    }
  );
  assert.equal(updated.secret, 'new');
});

test('rejects unknown, virtual, missing and malformed fields and invalid values', async () => {
  const Model = fixture.models.overrides;
  for (const field of ['unknown', 'user_key', 'status) DO NOTHING; --', 'computed']) {
    await assert.rejects(
      Model.upsert({ userKey: 'a', status: 'yes', [field]: 'bad' }, options),
      /Invalid persisted/
    );
    await assert.rejects(
      Model.upsert({ userKey: 'a', status: 'yes' }, { ...options, conflictFields: [field] }),
      /Invalid persisted/
    );
    await assert.rejects(
      Model.upsert({ userKey: 'a', status: 'yes' }, { ...options, updateFields: [field] }),
      /Invalid persisted/
    );
  }
  await assert.rejects(
    Model.upsert({ userKey: 'a', status: 'yes' }, { ...options, updateFields: [] }),
    /non-empty/
  );
  await assert.rejects(Model.upsert({ userKey: 'a' }, options), /explicit insert value/);
  await assert.rejects(Model.upsert({ userKey: 'a', status: 123 }, options));
});

test('transaction rollback undoes both insert and conflict update', async () => {
  const Model = fixture.models.overrides;
  await Model.upsert({ userKey: 'existing', status: 'old' }, options);
  await assert.rejects(
    fixture.dal.transaction(async transaction => {
      await Model.upsert({ userKey: 'new', status: 'new' }, { ...options, transaction });
      await Model.upsert({ userKey: 'existing', status: 'changed' }, { ...options, transaction });
      throw new Error('rollback');
    }),
    /rollback/
  );
  const result = await fixture.dal.query(`SELECT * FROM ${fixture.getTableName('overrides')}`);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, 'old');
});

test('revisioned models reject upsert before executing SQL', async () => {
  const Model = fixture.dal.createModel('revisioned', { ...schema, _revID: types.string() });
  await assert.rejects(Model.upsert({ userKey: 'a', status: 'yes' }, options), /revisioned models/);
});

test('composite conflict keys and schema defaults work', async () => {
  await fixture.dal.query(`CREATE TABLE ${fixture.getTableName('composite')} (
    user_key TEXT, scope TEXT, status TEXT, PRIMARY KEY (user_key, scope))`);
  const Model = fixture.dal.createModel(fixture.getTableName('composite'), {
    user_key: types.string().required(),
    scope: types.string().default('global'),
    status: types.string().required(),
  });
  const config = { conflictFields: ['user_key', 'scope'], updateFields: ['status'] };
  await Model.upsert({ user_key: 'a', status: 'first' }, config);
  const row = await Model.upsert({ user_key: 'a', status: 'second' }, config);
  assert.equal(row.scope, 'global');
  assert.equal(row.status, 'second');
  const result = await fixture.dal.query(`SELECT * FROM ${fixture.getTableName('composite')}`);
  assert.equal(result.rows.length, 1);
});
