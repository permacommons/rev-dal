import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, beforeEach } from 'node:test';

import type { JsonObject } from '../src/lib/model-types.js';
import types from '../src/lib/type.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';

/**
 * Regression tests for inline (direct, to-one) joins: joined columns must be
 * separated from main-table columns even when a main column's name starts
 * with the relation name (relation `owner`, column `owner_id`).
 */

type Person = JsonObject & { id: string; name: string; _data: Record<string, unknown> };
type Thing = JsonObject & {
  id: string;
  _data: Record<string, unknown>;
  owner?: Person | null;
  editor?: Person | null;
  parent?: Thing | null;
};
type ThingQuery = {
  getJoin(spec: JsonObject): ThingQuery;
  whereRelated(relation: string, field: string, value: unknown): ThingQuery;
  orderByRelation(relation: string, field: string, direction?: 'ASC' | 'DESC'): ThingQuery;
  orderBy(field: string, direction?: 'ASC' | 'DESC'): ThingQuery;
  run(): Promise<Thing[]>;
  _builder: { _buildSelectQuery(): { sql: string } };
};
type ThingModel = {
  filterWhere(literal: JsonObject): ThingQuery;
  defineRelation(name: string, config: JsonObject): void;
};

let fixture: PostgresFixture;
let Things: ThingModel;
const alice = randomUUID();
const bob = randomUUID();

const insertThing = async (values: {
  title: string;
  ownerID: string | null;
  editorID?: string | null;
  ownerNote?: string | null;
  parentID?: string | null;
}) => {
  const result = await fixture.dal.query(
    `INSERT INTO ${fixture.getTableName('things')} (title, owner_id, editor_id, owner_note, parent_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      values.title,
      values.ownerID,
      values.editorID ?? null,
      values.ownerNote ?? null,
      values.parentID ?? null,
    ]
  );
  return String(result.rows[0].id);
};

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_joins',
    tableDefs: [
      {
        name: 'people',
        create: (tableName: string) =>
          `CREATE TABLE ${tableName} (id UUID PRIMARY KEY, name TEXT, owner_level INT)`,
      },
      {
        name: 'things',
        create: (tableName: string) => `
          CREATE TABLE ${tableName} (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title TEXT,
            owner_id UUID,
            owner_note TEXT,
            editor_id UUID,
            parent_id UUID
          )
        `,
      },
    ],
    modelDefs: [
      {
        name: 'people',
        hasRevisions: false,
        schema: {
          id: types.string().uuid(4),
          name: types.string(),
          ownerLevel: types.number(),
        },
        camelToSnake: { ownerLevel: 'owner_level' },
      },
      {
        name: 'things',
        hasRevisions: false,
        schema: {
          id: types.string().uuid(4),
          title: types.string(),
          ownerID: types.string(),
          ownerNote: types.string(),
          editorID: types.string(),
          parentID: types.string(),
        },
        camelToSnake: {
          ownerID: 'owner_id',
          ownerNote: 'owner_note',
          editorID: 'editor_id',
          parentID: 'parent_id',
        },
        options: {
          relations: [
            {
              name: 'owner',
              targetTable: 'people',
              sourceColumn: 'owner_id',
              targetColumn: 'id',
              cardinality: 'one',
            },
            {
              name: 'editor',
              targetTable: 'people',
              sourceColumn: 'editor_id',
              targetColumn: 'id',
              cardinality: 'one',
            },
            {
              name: 'parent',
              targetTable: 'things',
              sourceColumn: 'parent_id',
              targetColumn: 'id',
              cardinality: 'one',
            },
          ],
        },
      },
    ],
  });
  Things = fixture.models.things as unknown as ThingModel;
});

beforeEach(async () => {
  await fixture.cleanupTables(['things', 'people']);
  await fixture.dal.query(
    `INSERT INTO ${fixture.getTableName('people')} (id, name, owner_level) VALUES ($1, 'Alice', 3), ($2, 'Bob', 7)`,
    [alice, bob]
  );
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

test('main-table columns that start with the relation name survive an inline join', async () => {
  const id = await insertThing({ title: 'Lamp', ownerID: alice, ownerNote: 'keep dry' });

  const [thing] = await Things.filterWhere({ id }).getJoin({ owner: true }).run();

  assert.strictEqual(thing._data.owner_id, alice, 'owner_id stays on the main row');
  assert.strictEqual(thing._data.owner_note, 'keep dry', 'owner_note stays on the main row');
  assert.strictEqual(thing._data.title, 'Lamp');
  assert.ok(thing.owner, 'owner is attached');
  assert.strictEqual(thing.owner._data.id, alice);
  assert.strictEqual(thing.owner._data.name, 'Alice');
  assert.strictEqual(thing.owner._data.owner_level, 3, "the related row's own columns are kept");
});

test('an unmatched inline join yields null without touching main columns', async () => {
  const id = await insertThing({ title: 'Orphan', ownerID: null, ownerNote: 'none yet' });

  const [thing] = await Things.filterWhere({ id }).getJoin({ owner: true }).run();

  assert.strictEqual(thing.owner, null);
  assert.strictEqual(thing._data.owner_id, null);
  assert.strictEqual(thing._data.owner_note, 'none yet');
});

test('two to-one relations to the same table both load (the second via a batch query)', async () => {
  const id = await insertThing({ title: 'Desk', ownerID: alice, editorID: bob });

  const [thing] = await Things.filterWhere({ id }).getJoin({ owner: true, editor: true }).run();

  assert.strictEqual(thing.owner?._data.name, 'Alice');
  assert.strictEqual(thing.editor?._data.name, 'Bob');
  assert.strictEqual(thing._data.owner_id, alice);
  assert.strictEqual(thing._data.editor_id, bob);
});

test('a relation back to the queried table loads via a batch query', async () => {
  const parentID = await insertThing({ title: 'Room', ownerID: bob });
  const id = await insertThing({ title: 'Lamp', ownerID: alice, parentID });

  const [thing] = await Things.filterWhere({ id }).getJoin({ parent: true, owner: true }).run();

  assert.strictEqual(thing._data.title, 'Lamp');
  assert.strictEqual(thing._data.parent_id, parentID);
  assert.strictEqual(thing.parent?._data.id, parentID);
  assert.strictEqual(thing.parent?._data.title, 'Room');
  assert.strictEqual(thing.owner?._data.name, 'Alice');
});

test('getJoin after whereRelated on the same relation joins it once', async () => {
  const id = await insertThing({ title: 'Shelf', ownerID: alice, ownerNote: 'n' });
  await insertThing({ title: 'Stool', ownerID: bob });

  const things = await Things.filterWhere({})
    .whereRelated('owner', 'name', 'Alice')
    .getJoin({ owner: true })
    .run();

  assert.strictEqual(things.length, 1);
  assert.strictEqual(things[0].id, id);
  assert.strictEqual(things[0].owner?._data.name, 'Alice');
  assert.strictEqual(things[0]._data.owner_note, 'n');
});

test('filtering on a relation whose table is already joined fails with a clear error', () => {
  assert.throws(
    () =>
      Things.filterWhere({})
        .whereRelated('owner', 'name', 'Alice')
        .whereRelated('editor', 'name', 'Bob'),
    /Cannot join relation 'editor' inline: '.*people' is already joined by another relation/
  );
  assert.throws(
    () => Things.filterWhere({}).whereRelated('parent', 'title', 'Room'),
    /Cannot join relation 'parent' inline: it refers back to/
  );
});

test('whereRelated and orderByRelation keep main-table columns intact', async () => {
  await insertThing({ title: 'Chair', ownerID: bob, ownerNote: 'b' });
  await insertThing({ title: 'Table', ownerID: alice, ownerNote: 'a' });

  const filtered = await Things.filterWhere({}).whereRelated('owner', 'name', 'Alice').run();
  assert.deepStrictEqual(
    filtered.map(thing => [thing._data.title, thing._data.owner_id, thing._data.owner_note]),
    [['Table', alice, 'a']]
  );

  const ordered = await Things.filterWhere({}).orderByRelation('owner', 'name', 'ASC').run();
  assert.deepStrictEqual(
    ordered.map(thing => [thing._data.title, thing._data.owner_id]),
    [
      ['Table', alice],
      ['Chair', bob],
    ]
  );
});

test('joined columns are aliased as "relation.column"', () => {
  const { sql } = Things.filterWhere({}).getJoin({ owner: true })._builder._buildSelectQuery();
  assert.match(sql, /\.id AS "owner\.id"/);
  assert.match(sql, /\.owner_level AS "owner\.owner_level"/);
  assert.doesNotMatch(sql, /AS "owner_/);
});

test('relation names must be plain identifiers', () => {
  for (const name of ['owner.name', 'own er', '1st', 'a"b', 'owner-x', '']) {
    assert.throws(
      () => Things.defineRelation(name, { targetTable: 'people', sourceColumn: 'owner_id' }),
      /Relation name/,
      `rejects ${JSON.stringify(name)}`
    );
  }
  assert.doesNotThrow(() =>
    Things.defineRelation('previousOwner_2', { targetTable: 'people', sourceColumn: 'owner_id' })
  );
});
