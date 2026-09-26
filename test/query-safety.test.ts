import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import type { JsonObject } from '../src/lib/model-types.js';
import types from '../src/lib/type.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';
import {
  countAllRevisions,
  createTestDocumentWithRevisions,
  getTestModelDefinitions,
  getTestTableDefinitions,
  getTestUserData,
  type RevisionModel,
} from './helpers/revision-helpers.js';

/**
 * Regression tests for query-safety fixes:
 * - LIMIT/OFFSET are validated and bound as parameters; sort direction is validated
 * - empty `whereIn` / `ops.containsAny` match no rows instead of dropping the filter
 * - deletes require a WHERE clause, and hard deletes on revisioned models require `purge`
 */

type Row = JsonObject & { id: string; label: string; tags: string[] };

type QueryChain = PromiseLike<Row[]> & {
  run(): Promise<Row[]>;
  count(): Promise<number>;
  limit(count: unknown): QueryChain;
  offset(count: unknown): QueryChain;
  sample(count: unknown): Promise<Row[]>;
  orderBy(field: string, direction?: unknown): QueryChain;
  whereIn(field: string, values: unknown, options?: { cast?: string }): QueryChain;
  or(literal: JsonObject): QueryChain;
  chronologicalFeed(options: JsonObject): Promise<unknown>;
  delete(options?: JsonObject): Promise<number>;
  deleteById(id: string, options?: JsonObject): Promise<number>;
};

type LabelModel = {
  filterWhere(literal: JsonObject): QueryChain;
  ops: { containsAny(value: string[]): unknown; neq(value: unknown): unknown };
  delete(id: string, options?: JsonObject): Promise<boolean>;
};

type RevisionDoc = Awaited<ReturnType<typeof createTestDocumentWithRevisions>> & {
  delete(options?: JsonObject): Promise<boolean>;
};

type RevisionModelWithDeletes = RevisionModel & {
  filterWhere(literal: JsonObject): QueryChain;
  delete(id: string, options?: JsonObject): Promise<boolean>;
};

let fixture: PostgresFixture;
let Labels: LabelModel;
let Revisions: RevisionModelWithDeletes;
const testUser = getTestUserData();

const countRows = async (table: string) => {
  const result = await fixture.dal.query(
    `SELECT COUNT(*) AS count FROM ${fixture.getTableName(table)}`
  );
  return Number.parseInt(String(result.rows[0].count), 10);
};

const insertLabel = async (label: string, tags: string[]) => {
  const result = await fixture.dal.query(
    `INSERT INTO ${fixture.getTableName('labels')} (label, tags) VALUES ($1, $2) RETURNING id`,
    [label, tags]
  );
  return String(result.rows[0].id);
};

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_query_safety',
    tableDefs: [
      ...getTestTableDefinitions(),
      {
        name: 'labels',
        create: (tableName: string) => `
          CREATE TABLE ${tableName} (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            label TEXT NOT NULL,
            tags TEXT[] NOT NULL DEFAULT '{}'
          )
        `,
      },
    ],
    modelDefs: [
      ...getTestModelDefinitions(),
      {
        name: 'labels',
        hasRevisions: false,
        schema: {
          id: types.string().uuid(4),
          label: types.string(),
          tags: types.array(types.string()),
        },
      },
    ],
  });
  Labels = fixture.models.labels as unknown as LabelModel;
  Revisions = fixture.models.revisions as unknown as RevisionModelWithDeletes;
});

beforeEach(async () => {
  await fixture.cleanupTables(['labels', 'revisions', 'users']);
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

test('limit and offset reject values that are not non-negative integers', () => {
  const invalid = ['1; DROP TABLE labels', '10', -1, 1.5, Number.NaN, Infinity, undefined, {}];
  for (const value of invalid) {
    assert.throws(() => Labels.filterWhere({}).limit(value), TypeError, `limit(${String(value)})`);
    assert.throws(
      () => Labels.filterWhere({}).offset(value),
      TypeError,
      `offset(${String(value)})`
    );
  }
});

test('limit and offset accept zero and positive integers', async () => {
  await insertLabel('a', []);
  await insertLabel('b', []);
  await insertLabel('c', []);

  const rows = await Labels.filterWhere({}).orderBy('label').limit(2).offset(1).run();
  assert.deepStrictEqual(
    rows.map(row => row.label),
    ['b', 'c']
  );
  assert.strictEqual((await Labels.filterWhere({}).limit(0).run()).length, 0);
});

type BuilderInternals = {
  _builder: {
    _limit: unknown;
    _offset: unknown;
    _buildSelectQuery(): { sql: string; params: unknown[] };
  };
};

test('limit and offset are bound as parameters after the WHERE parameters', async () => {
  await insertLabel('a', []);
  await insertLabel('b', []);
  await insertLabel('c', []);

  const makeQuery = () =>
    Labels.filterWhere({ label: Labels.ops.neq('b') })
      .orderBy('label')
      .limit(1)
      .offset(1);

  const { sql, params } = (makeQuery() as unknown as BuilderInternals)._builder._buildSelectQuery();
  assert.match(sql, /LIMIT \$2 OFFSET \$3$/);
  assert.deepStrictEqual(params, ['b', 1, 1]);

  const rows = await makeQuery().run();
  assert.deepStrictEqual(
    rows.map(row => row.label),
    ['c']
  );
});

test('LIMIT/OFFSET values that bypass validation are never spliced into SQL', async () => {
  await insertLabel('a', []);

  // Simulate a caller writing the internal field directly, skipping limit().
  const builder = Labels.filterWhere({});
  const qb = (builder as unknown as BuilderInternals)._builder;
  qb._limit = '1; DROP TABLE labels';

  const { sql } = qb._buildSelectQuery();
  assert.ok(!sql.includes('DROP TABLE'), 'raw value must not appear in the SQL text');
  await assert.rejects(() => builder.run());
  assert.strictEqual(await countRows('labels'), 1);
});

test('sample rejects an invalid count', async () => {
  await assert.rejects(() => Labels.filterWhere({}).sample('1 OFFSET 0'), TypeError);
});

test('orderBy rejects directions other than ASC/DESC and normalizes case', async () => {
  for (const direction of ['ASC, (SELECT 1)', 'DESC; --', 'sideways', '', null]) {
    assert.throws(
      () => Labels.filterWhere({}).orderBy('label', direction),
      TypeError,
      `direction ${String(direction)}`
    );
  }

  await insertLabel('a', []);
  await insertLabel('b', []);
  const rows = await Labels.filterWhere({}).orderBy('label', 'desc').run();
  assert.deepStrictEqual(
    rows.map(row => row.label),
    ['b', 'a']
  );
});

test('chronologicalFeed rejects an invalid direction', async () => {
  await assert.rejects(
    () =>
      Revisions.filterWhere({}).chronologicalFeed({
        cursorField: '_revDate',
        direction: 'DESC, (SELECT 1)',
      }),
    TypeError
  );
});

test('whereIn with an empty array matches no rows', async () => {
  await insertLabel('a', []);
  await insertLabel('b', []);

  assert.strictEqual((await Labels.filterWhere({}).whereIn('id', []).run()).length, 0);
  assert.strictEqual(await Labels.filterWhere({}).whereIn('id', []).count(), 0);
  assert.strictEqual(
    (await Labels.filterWhere({}).whereIn('id', [], { cast: 'uuid[]' }).run()).length,
    0
  );
});

test('whereIn rejects a non-array value', () => {
  assert.throws(() => Labels.filterWhere({}).whereIn('id', undefined), TypeError);
  assert.throws(() => Labels.filterWhere({}).whereIn('id', 'abc'), TypeError);
});

test('whereIn with an empty array deletes nothing', async () => {
  await insertLabel('a', []);
  assert.strictEqual(await Labels.filterWhere({}).whereIn('id', []).delete(), 0);
  assert.strictEqual(await countRows('labels'), 1);
});

test('ops.containsAny with an empty array matches no rows', async () => {
  await insertLabel('a', ['x']);
  await insertLabel('b', ['y']);
  const { containsAny } = Labels.ops;

  const rows = await Labels.filterWhere({ tags: containsAny([]) }).run();
  assert.strictEqual(rows.length, 0);

  // Inside an OR group the empty overlap is simply false.
  const orRows = await Labels.filterWhere({})
    .or({ tags: containsAny([]), label: 'b' })
    .run();
  assert.deepStrictEqual(
    orRows.map(row => row.label),
    ['b']
  );

  const matching = await Labels.filterWhere({ tags: containsAny(['x']) }).run();
  assert.deepStrictEqual(
    matching.map(row => row.label),
    ['a']
  );
});

test('delete without any predicate is refused and removes nothing', async () => {
  await insertLabel('a', []);
  await insertLabel('b', []);

  await assert.rejects(() => Labels.filterWhere({}).delete(), /requires a WHERE clause/);
  assert.strictEqual(await countRows('labels'), 2);
});

test('delete with a predicate removes only matching rows on non-revisioned models', async () => {
  await insertLabel('a', []);
  await insertLabel('b', []);

  assert.strictEqual(await Labels.filterWhere({ label: 'a' }).delete(), 1);
  const remaining = await Labels.filterWhere({}).run();
  assert.deepStrictEqual(
    remaining.map(row => row.label),
    ['b']
  );
});

test('FilterWhereBuilder.deleteById honours the builder predicates', async () => {
  const id = await insertLabel('a', []);

  assert.strictEqual(await Labels.filterWhere({ label: 'not-a' }).deleteById(id), 0);
  assert.strictEqual(await countRows('labels'), 1);

  assert.strictEqual(await Labels.filterWhere({ label: 'a' }).deleteById(id), 1);
  assert.strictEqual(await countRows('labels'), 0);
});

test('Model.delete still hard-deletes by id on non-revisioned models', async () => {
  const id = await insertLabel('a', []);
  assert.strictEqual(await Labels.delete(id), true);
  assert.strictEqual(await countRows('labels'), 0);
});

test('hard deletes on revisioned models are refused without purge', async () => {
  const doc = (await createTestDocumentWithRevisions(Revisions, testUser, 3)) as RevisionDoc;
  const docId = doc.id;
  const tableName = fixture.getTableName('revisions');
  assert.strictEqual(await countAllRevisions(fixture.dal, tableName, docId), 3);

  await assert.rejects(
    () => Revisions.filterWhere({ id: docId }).delete(),
    /revision tracking.*purge: true/s
  );
  await assert.rejects(() => Revisions.filterWhere({}).deleteById(docId), /purge: true/);
  await assert.rejects(() => Revisions.delete(docId), /purge: true/);
  await assert.rejects(() => doc.delete(), /purge: true/);

  assert.strictEqual(await countAllRevisions(fixture.dal, tableName, docId), 3);
});

test('purge removes revisioned documents together with their archived revisions', async () => {
  const tableName = fixture.getTableName('revisions');
  const docA = await createTestDocumentWithRevisions(Revisions, testUser, 3, 'A ');
  const docB = await createTestDocumentWithRevisions(Revisions, testUser, 2, 'B ');
  const docC = (await createTestDocumentWithRevisions(Revisions, testUser, 2, 'C ')) as RevisionDoc;
  const docD = await createTestDocumentWithRevisions(Revisions, testUser, 2, 'D ');

  assert.strictEqual(await Revisions.filterWhere({ id: docA.id }).delete({ purge: true }), 3);
  assert.strictEqual(await countAllRevisions(fixture.dal, tableName, docA.id), 0);

  assert.strictEqual(await Revisions.delete(docB.id, { purge: true }), true);
  assert.strictEqual(await countAllRevisions(fixture.dal, tableName, docB.id), 0);

  assert.strictEqual(await docC.delete({ purge: true }), true);
  assert.strictEqual(await countAllRevisions(fixture.dal, tableName, docC.id), 0);

  // Unrelated documents and their history are untouched.
  assert.strictEqual(await countAllRevisions(fixture.dal, tableName, docD.id), 2);
  assert.strictEqual(await countRows('revisions'), 2);
});
