import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, beforeEach } from 'node:test';

import { defineModel, initializeManifestModels } from '../src/lib/create-model.js';
import DataAccessLayer from '../src/lib/data-access-layer.js';
import { referenceModel, setBootstrapResolver } from '../src/lib/model-handle.js';
import type { ModelManifest } from '../src/lib/model-manifest.js';
import type { JsonObject, ModelConstructor } from '../src/lib/model-types.js';
import revision from '../src/lib/revision.js';
import types from '../src/lib/type.js';
import { resolveTestConfig } from './helpers/postgres-fixture.js';

/**
 * `dal.getModel(manifestOrHandle)` resolves in the receiving DAL's own
 * registry. Two DALs share the same manifests but use separate schemas, so a
 * lookup that leaks to the other DAL or the global resolver shows up as data
 * in the wrong schema.
 */

const userManifest = {
  tableName: 'gm_users',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    displayName: types.string().max(255).required(true),
    email: types.string().max(255),
  },
  camelToSnake: { displayName: 'display_name' },
} as const satisfies ModelManifest;

const pageManifest = {
  tableName: 'gm_pages',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    title: types.string().max(255),
    ...revision.getSchema(),
  },
} as const satisfies ModelManifest;

const User = defineModel(userManifest, {
  staticMethods: {
    async countUsers(this: ModelConstructor): Promise<number> {
      const result = await this.dal.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${this.tableName}`
      );
      return Number(result.rows[0]?.count);
    },
  },
  instanceMethods: {
    greeting(this: { displayName: string }): string {
      return `Hello, ${this.displayName}`;
    },
  },
  statics: { handleOnly: 'handle' as const },
});

const Page = defineModel(pageManifest);

type Side = { dal: DataAccessLayer; schemaName: string };

let a: Side;
let b: Side;
let resolverCalls = 0;
const revUser = { id: randomUUID() };

const createSide = async (prefix: string): Promise<Side> => {
  const dal = new DataAccessLayer(resolveTestConfig());
  await dal.connect();
  const schemaName = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await dal.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  await dal.query(`CREATE SCHEMA ${schemaName}`);
  await dal.query(`
    CREATE TABLE ${schemaName}.gm_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      display_name VARCHAR(255) NOT NULL,
      email VARCHAR(255)
    )
  `);
  await dal.query(`
    CREATE TABLE ${schemaName}.gm_pages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(255),
      _rev_user UUID NOT NULL,
      _rev_date TIMESTAMP NOT NULL,
      _rev_id UUID NOT NULL,
      _old_rev_of UUID,
      _rev_deleted BOOLEAN DEFAULT FALSE,
      _rev_tags TEXT[] DEFAULT '{}',
      _rev_summary JSONB
    )
  `);
  dal.schemaNamespace = `${schemaName}.`;
  initializeManifestModels(dal);
  return { dal, schemaName };
};

const dropSide = async (side: Side | undefined) => {
  if (!side) return;
  try {
    await side.dal.query(`DROP SCHEMA IF EXISTS ${side.schemaName} CASCADE`);
  } finally {
    await side.dal.disconnect();
  }
};

/** Global resolver that counts calls before delegating to DAL A. */
const pointResolverAtA = () => {
  setBootstrapResolver(() => {
    resolverCalls += 1;
    return { getModel: name => a.dal.getModel(name) };
  });
};

/** Global resolver that fails, so any global lookup aborts the test. */
const breakResolver = () => {
  setBootstrapResolver(() => {
    resolverCalls += 1;
    throw new Error('global resolver must not be used');
  });
};

before(async () => {
  a = await createSide('rev_dal_get_model_a');
  b = await createSide('rev_dal_get_model_b');
});

beforeEach(async () => {
  resolverCalls = 0;
  pointResolverAtA();
  for (const side of [a, b]) {
    await side.dal.query(`TRUNCATE ${side.schemaName}.gm_users, ${side.schemaName}.gm_pages`);
  }
});

after(async () => {
  await dropSide(a);
  await dropSide(b);
});

const countRows = async (side: Side, table: string) => {
  const result = await side.dal.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${side.schemaName}.${table}`
  );
  return Number(result.rows[0]?.count);
};

test('each DAL returns its own registered constructor', () => {
  const userA = a.dal.getModel(userManifest);
  const userB = b.dal.getModel(userManifest);

  assert.notEqual(userA, userB);
  assert.equal(userA.dal, a.dal);
  assert.equal(userB.dal, b.dal);
  assert.equal(b.dal.getModel(User), userB);
  assert.equal(b.dal.getModel(referenceModel(userManifest)), userB);
  assert.equal(b.dal.getModel('gm_users'), userB);
  assert.equal(b.dal.getModel(`${b.schemaName}.gm_users`), userB);
  assert.equal(resolverCalls, 0);
});

test('lookup and queries never consult the global resolver', async () => {
  breakResolver();
  const UserB = b.dal.getModel(User);

  await UserB.create({ displayName: 'Ada', email: 'ada@example.com' });
  await UserB.create({ displayName: 'Grace', email: 'grace@example.com' });
  const rows = await UserB.filterWhere({ displayName: 'Ada' }).select('id', 'displayName');

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.displayName, 'Ada');
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ['displayName', 'id']);
  assert.equal(await countRows(b, 'gm_users'), 2);
  assert.equal(await countRows(a, 'gm_users'), 0);
  assert.equal(resolverCalls, 0);
});

test('interleaved writes and reads stay on their own DAL', async () => {
  const UserA = a.dal.getModel(userManifest);
  const UserB = b.dal.getModel(userManifest);

  const ada = await UserA.create({ displayName: 'Ada' });
  const grace = await UserB.create({ displayName: 'Grace' });
  await UserA.create({ displayName: 'Alan' });

  assert.equal((await UserB.get(grace.id)).displayName, 'Grace');
  assert.equal((await UserA.get(ada.id)).displayName, 'Ada');
  await assert.rejects(UserB.get(ada.id));
  assert.equal((await UserA.filterWhere({}).run()).length, 2);
  assert.equal((await UserB.filterWhere({}).run()).length, 1);

  // The global handle still follows the resolver (DAL A).
  assert.equal((await User.filterWhere({}).run()).length, 2);
});

test('custom methods registered with defineModel() run against the resolved DAL', async () => {
  breakResolver();
  const UserB = b.dal.getModel(User);

  const created = await UserB.create({ displayName: 'Ada' });
  assert.equal(await UserB.countUsers(), 1);
  assert.equal(created.greeting(), 'Hello, Ada');
  assert.equal(await countRows(a, 'gm_users'), 0);

  // `statics` live on the handle only, not on the registered constructor.
  assert.equal(User.handleOnly, 'handle');
  assert.equal(Object.hasOwn(UserB, 'handleOnly'), false);
  assert.equal(resolverCalls, 0);
});

test('revisioned models keep revision behavior and history on the resolved DAL', async () => {
  breakResolver();
  const PageB = b.dal.getModel(Page);

  const first = await PageB.createFirstRevision(revUser, { tags: ['create'] });
  first.title = 'Original';
  await first.save();
  const second = await first.newRevision(revUser, { tags: ['edit'] });
  second.title = 'Edited';
  await second.save();

  const history = await PageB.filterWhere({}).getAllRevisions(first.id).run();
  assert.deepEqual(history.map(rev => rev.title).sort(), ['Edited', 'Original']);
  const current = await PageB.filterWhere({}).select('id', 'title', '_revID');
  assert.deepEqual(
    current.map(row => row.title),
    ['Edited']
  );
  assert.equal(await countRows(b, 'gm_pages'), 2);
  assert.equal(await countRows(a, 'gm_pages'), 0);
  assert.equal(resolverCalls, 0);
});

test("cast handles and other DALs' constructors resolve to this DAL's constructor", async () => {
  breakResolver();
  const castHandle = referenceModel(userManifest) as unknown as ModelConstructor;
  const userA = a.dal.getModel(userManifest);
  const userB = b.dal.getModel(userManifest);

  assert.equal(b.dal.getModel(castHandle), userB);
  assert.equal(b.dal.getModel(userA), userB);
  assert.equal(a.dal.getModel(userB), userA);
  assert.equal(b.dal.getModel(b.dal.getModel(Page)), b.dal.getModel(Page));

  await b.dal.getModel(userA).create({ displayName: 'Ada' });
  assert.equal(await countRows(b, 'gm_users'), 1);
  assert.equal(await countRows(a, 'gm_users'), 0);

  const onlyOnA = a.dal.createModel('gm_ctor_only_a', { id: types.string() });
  assert.throws(() => b.dal.getModel(onlyOnA), { message: "Model 'gm_ctor_only_a' not found" });
  assert.equal(resolverCalls, 0);
});

test('missing models throw without falling back to another DAL', async () => {
  const onlyOnA = {
    tableName: 'gm_only_a',
    hasRevisions: false as const,
    schema: { id: types.string() },
  } as const satisfies ModelManifest;
  a.dal.createModel('gm_only_a', onlyOnA.schema);

  assert.ok(a.dal.getModel(onlyOnA));
  assert.throws(() => b.dal.getModel(onlyOnA), { message: "Model 'gm_only_a' not found" });
  assert.equal(resolverCalls, 0);
});

test('lookup performs no queries and does not change the registry', async () => {
  const originalQuery = b.dal.query.bind(b.dal);
  let queries = 0;
  b.dal.query = (async (...args: Parameters<typeof originalQuery>) => {
    queries += 1;
    return originalQuery(...args);
  }) as typeof b.dal.query;

  try {
    const before = [...b.dal.getRegisteredModels().keys()];
    b.dal.getModel(userManifest);
    b.dal.getModel(User);
    b.dal.getModel(Page);
    assert.throws(() => b.dal.getModel({ ...userManifest, tableName: 'gm_unregistered' }));
    assert.deepEqual([...b.dal.getRegisteredModels().keys()], before);
    assert.equal(queries, 0);
  } finally {
    b.dal.query = originalQuery;
  }
});

test('malformed arguments are rejected with TypeError', () => {
  const lookup = b.dal.getModel.bind(b.dal) as (value: unknown) => unknown;
  for (const value of [
    null,
    undefined,
    42,
    [],
    {},
    { tableName: '' },
    { tableName: 7 },
    () => undefined,
  ]) {
    assert.throws(() => lookup(value), TypeError, `expected TypeError for ${String(value)}`);
  }
});

test('lookups fail after disconnect until models are registered again', async () => {
  const side = await createSide('rev_dal_get_model_c');
  try {
    const before = side.dal.getModel(userManifest);
    await side.dal.disconnect();
    assert.throws(() => side.dal.getModel(userManifest), { message: "Model 'gm_users' not found" });
    assert.throws(() => side.dal.getModel(User), { message: "Model 'gm_users' not found" });

    await side.dal.connect();
    initializeManifestModels(side.dal);
    const after = side.dal.getModel(userManifest) as ModelConstructor<JsonObject>;
    assert.notEqual(after, before);
    assert.equal(after.dal, side.dal);
  } finally {
    await dropSide(side);
  }
});
