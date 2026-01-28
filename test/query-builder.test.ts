import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult } from 'pg';

import * as dalModule from '../src/index.js';
import { createOperators, FilterWhereBuilder } from '../src/lib/filter-where.js';
import type { ModelRuntime } from '../src/lib/model.js';
import Model, { type ModelSchema } from '../src/lib/model.js';
import { initializeModel } from '../src/lib/model-initializer.js';
import type { JsonObject, ModelConstructor, ModelInstance } from '../src/lib/model-types.js';
import QueryBuilder from '../src/lib/query-builder.js';
import typesLib from '../src/lib/type.js';
import type { RuntimeModel } from './helpers/dal-mocks.js';
import {
  createMockDAL,
  createQueryBuilderHarness,
  createQueryResult,
} from './helpers/dal-mocks.js';

type DefaultRecord = {
  id: string;
  name?: string;
  createdOn?: string;
};

type DefaultInstance = ModelInstance<DefaultRecord, JsonObject>;

type RevisionRecord = DefaultRecord & { _revID?: string };

type RevisionInstance = ModelInstance<RevisionRecord, JsonObject>;

/**
 * Unit tests for QueryBuilder functionality
 *
 * Tests the query builder methods without requiring database connection
 */

test('QueryBuilder can be instantiated', () => {
  const { qb } = createQueryBuilderHarness();
  assert.ok(qb);
  assert.strictEqual(qb.tableName, 'test_table');
});

test('FilterWhereBuilder applies literal predicates to QueryBuilder', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );

  const result = builder.and({ id: 'test-id' });

  assert.strictEqual(result, builder, 'FilterWhereBuilder.and should return the builder instance');
  assert.strictEqual(qb._where.length, 1);
  const predicate = qb._where[0];
  if (predicate?.type !== 'basic') {
    assert.fail('Expected FilterWhereBuilder to add a basic predicate for literal values');
  }
  assert.strictEqual(predicate.column, 'id');
  assert.strictEqual(predicate.operator, '=');
  assert.strictEqual(predicate.value, 'test-id');
});

test('QueryBuilder supports orderBy method', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const result = qb.orderBy('created_on', 'DESC');

  assert.strictEqual(result, qb);
  assert.ok(qb._orderBy.length > 0);
  assert.strictEqual(qb._orderBy[0], 'created_on DESC');
});

test('FilterWhereBuilder resolves manifest keys before delegating', () => {
  const schema = {
    id: typesLib.string(),
    createdOn: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    schema,
    camelToSnake: { createdOn: 'created_on' },
  });

  type Data = { id: string; createdOn: string };
  type Instance = ModelInstance<Data, JsonObject>;

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);

  builder.orderBy('createdOn', 'DESC').whereIn('id', ['a', 'b']);

  assert.deepStrictEqual(qb._orderBy, ['created_on DESC']);
  const predicate = qb._where[0] as { column: string } | undefined;
  assert.ok(predicate);
  assert.strictEqual(predicate?.column, 'id');
});

test('FilterWhere operator helpers build advanced predicates', () => {
  type Data = {
    id: string;
    status: string;
    score: number;
    createdOn: Date;
    isActive: boolean | null;
    metadata: JsonObject;
  };
  type Instance = ModelInstance<Data, JsonObject>;

  const schema = {
    id: typesLib.string(),
    status: typesLib.string(),
    score: typesLib.number(),
    created_on: typesLib.date(),
    is_active: typesLib.boolean(),
    metadata: typesLib.object(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    schema,
    camelToSnake: { createdOn: 'created_on', isActive: 'is_active' },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);
  const ops = createOperators<Data>();

  builder
    .and({
      status: ops.in(['draft', 'published']),
      id: ops.in(['one'], { cast: 'uuid[]' }),
    })
    .and({ score: ops.between(10, 20, { leftBound: 'open', rightBound: 'closed' }) })
    .and({ score: ops.notBetween(30, 40, { leftBound: 'open', rightBound: 'open' }) })
    .and({ metadata: ops.jsonContains({ foo: 'bar' }) })
    .and({ isActive: ops.not() });

  assert.strictEqual(qb._where.length, 6);

  const [
    anyPredicate,
    castPredicate,
    betweenGroup,
    notBetweenGroup,
    jsonPredicate,
    booleanPredicate,
  ] = qb._where;

  if (!anyPredicate || anyPredicate.type !== 'basic') {
    assert.fail('Expected first predicate to be basic');
  }
  assert.strictEqual(anyPredicate.operator, '= ANY');
  assert.deepStrictEqual(anyPredicate.value, ['draft', 'published']);
  assert.ok(anyPredicate.valueTransform);
  assert.strictEqual(anyPredicate.valueTransform?.('__value__'), '(__value__)');

  if (!castPredicate || castPredicate.type !== 'basic') {
    assert.fail('Expected second predicate to be basic');
  }
  assert.strictEqual(castPredicate.operator, '= ANY');
  assert.deepStrictEqual(castPredicate.value, ['one']);
  assert.strictEqual(castPredicate.valueTransform?.('__value__'), '(__value__::uuid[])');

  if (!betweenGroup || betweenGroup.type !== 'group') {
    assert.fail('Expected third predicate to be a group');
  }
  assert.strictEqual(betweenGroup.conjunction, 'AND');
  const [lowerBetween, upperBetween] = betweenGroup.predicates;
  assert.ok(lowerBetween && upperBetween);
  if (lowerBetween?.type === 'basic' && upperBetween?.type === 'basic') {
    assert.strictEqual(lowerBetween.operator, '>');
    assert.strictEqual(upperBetween.operator, '<=');
    assert.strictEqual(lowerBetween.value, 10);
    assert.strictEqual(upperBetween.value, 20);
  } else {
    assert.fail('Between group predicates should be basic');
  }

  if (!notBetweenGroup || notBetweenGroup.type !== 'group') {
    assert.fail('Expected fourth predicate to be a group');
  }
  assert.strictEqual(notBetweenGroup.conjunction, 'OR');
  const [lowerNotBetween, upperNotBetween] = notBetweenGroup.predicates;
  assert.ok(lowerNotBetween && upperNotBetween);
  if (lowerNotBetween?.type === 'basic' && upperNotBetween?.type === 'basic') {
    assert.strictEqual(lowerNotBetween.operator, '<=');
    assert.strictEqual(upperNotBetween.operator, '>=');
    assert.strictEqual(lowerNotBetween.value, 30);
    assert.strictEqual(upperNotBetween.value, 40);
  } else {
    assert.fail('NotBetween group predicates should be basic');
  }

  if (!jsonPredicate || jsonPredicate.type !== 'basic') {
    assert.fail('Expected fifth predicate to be basic');
  }
  assert.strictEqual(jsonPredicate.operator, '@>');
  assert.strictEqual(jsonPredicate.value, JSON.stringify({ foo: 'bar' }));
  assert.strictEqual(jsonPredicate.valueTransform?.('__value__'), '__value__::jsonb');

  if (!booleanPredicate || booleanPredicate.type !== 'basic') {
    assert.fail('Expected sixth predicate to be basic');
  }
  assert.strictEqual(booleanPredicate.operator, 'IS NOT');
  assert.strictEqual(booleanPredicate.value, true);
  assert.strictEqual(booleanPredicate.valueTransform?.('__value__'), '__value__');
});

test('FilterWhere operators enforce non-empty IN arrays at runtime', () => {
  type MinimalRecord = JsonObject & { id: string };
  const ops = createOperators<MinimalRecord>();
  assert.throws(() => ops.in([] as unknown as [string, ...string[]]), {
    message: /requires at least one value/i,
  });
});

test('FilterWhere between participates in OR groups', () => {
  type Data = { value: number };
  type Instance = ModelInstance<Data, JsonObject>;

  const schema = {
    value: typesLib.number(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({ schema });
  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);
  const ops = createOperators<Data>();

  builder.or({ value: ops.between(1, 5) });

  assert.strictEqual(qb._where.length, 1);
  const groupPredicate = qb._where[0];
  if (groupPredicate?.type !== 'group') {
    assert.fail('Expected OR predicate to be grouped');
  }
  assert.strictEqual(groupPredicate.conjunction, 'OR');
  assert.strictEqual(groupPredicate.predicates.length, 1);
  const nested = groupPredicate.predicates[0];
  if (nested?.type !== 'group') {
    assert.fail('Expected nested between group');
  }
  assert.strictEqual(nested.conjunction, 'AND');
});

test('whereRelated joins relation and applies predicate with camelCase field', () => {
  const { qb } = createQueryBuilderHarness({
    relations: [
      {
        name: 'creator',
        targetTable: 'users',
        sourceKey: 'created_by',
        targetKey: 'id',
        hasRevisions: false,
        cardinality: 'one',
      },
    ],
  });

  qb.whereRelated('creator', 'isTrusted', '=', true);

  assert.ok(qb._joins.some(join => join.includes('users')));
  const predicate = qb._where[qb._where.length - 1];
  if (!predicate || predicate.type !== 'basic') {
    assert.fail('Expected basic predicate for related join');
  }
  assert.strictEqual(predicate.column, 'is_trusted');
  assert.strictEqual(predicate.operator, '=');
  assert.strictEqual(predicate.value, true);
});

test('chronologicalFeed applies revision guards, cursor predicate, and trims to limit', async () => {
  type Data = { id: string; createdOn: Date };
  type Instance = ModelInstance<Data, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    schema: {
      id: typesLib.string(),
      created_on: typesLib.date(),
    } as unknown as ModelSchema<JsonObject, JsonObject>,
    camelToSnake: { createdOn: 'created_on' },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, true);

  const fakeRows: Instance[] = [
    {
      id: 'a',
      createdOn: new Date('2025-01-03'),
      _data: {},
      _changed: new Set(),
      _isNew: false,
      _originalData: {},
      save: async () => null as never,
      saveAll: async () => null as never,
      delete: async () => false,
      getValue: () => null as never,
      setValue: () => undefined,
      generateVirtualValues: () => undefined,
    },
    {
      id: 'b',
      createdOn: new Date('2025-01-02'),
      _data: {},
      _changed: new Set(),
      _isNew: false,
      _originalData: {},
      save: async () => null as never,
      saveAll: async () => null as never,
      delete: async () => false,
      getValue: () => null as never,
      setValue: () => undefined,
      generateVirtualValues: () => undefined,
    },
    {
      id: 'c',
      createdOn: new Date('2025-01-01'),
      _data: {},
      _changed: new Set(),
      _isNew: false,
      _originalData: {},
      save: async () => null as never,
      saveAll: async () => null as never,
      delete: async () => false,
      getValue: () => null as never,
      setValue: () => undefined,
      generateVirtualValues: () => undefined,
    },
  ];

  let runCalled = false;
  qb.run = (async () => {
    runCalled = true;
    return fakeRows as unknown as Awaited<ReturnType<typeof qb.run>>;
  }) as typeof qb.run;

  const result = await builder.chronologicalFeed({
    cursorField: 'createdOn',
    cursor: new Date('2025-01-04'),
    limit: 2,
  });

  assert.ok(runCalled);
  assert.deepStrictEqual(qb._orderBy, ['created_on DESC']);
  assert.strictEqual(qb._limit, 3);
  assert.strictEqual(result.hasMore, true);
  assert.deepStrictEqual(
    result.rows.map(row => row.id),
    ['a', 'b']
  );
  assert.deepStrictEqual(result.nextCursor, fakeRows[1].createdOn);

  assert.strictEqual(qb._where[0]?.column, '_old_rev_of');
  assert.strictEqual(qb._where[0]?.operator, 'IS');
  assert.strictEqual(qb._where[1]?.column, '_rev_deleted');
  assert.strictEqual(qb._where[1]?.operator, '=');
  assert.strictEqual(qb._where[2]?.column, 'created_on');
  assert.strictEqual(qb._where[2]?.operator, '<');
});

test('chronologicalFeed short-circuits when limit is zero', async () => {
  type Data = { id: string; createdOn: Date };
  type Instance = ModelInstance<Data, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    schema: {
      id: typesLib.string(),
      created_on: typesLib.date(),
    } as unknown as ModelSchema<JsonObject, JsonObject>,
    camelToSnake: { createdOn: 'created_on' },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, true);

  qb.run = (async () => {
    assert.fail('run should not be called when limit is zero');
    return [] as unknown as Awaited<ReturnType<typeof qb.run>>;
  }) as typeof qb.run;

  const result = await builder.chronologicalFeed({
    cursorField: 'createdOn',
    limit: 0,
  });

  assert.deepStrictEqual(result.rows, []);
  assert.strictEqual(result.hasMore, false);
  assert.strictEqual(result.nextCursor, undefined);
});

test('QueryBuilder supports limit method', () => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.limit(10);

  assert.strictEqual(result, qb);
  assert.strictEqual(qb._limit, 10);
});

test('QueryBuilder supports offset method', () => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.offset(5);

  assert.strictEqual(result, qb);
  assert.strictEqual(qb._offset, 5);
});

test('FilterWhereBuilder enforces revision guards before execution', async () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    true
  );

  await builder.run();

  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  assert.ok(oldRevisionPredicate);
  assert.strictEqual(oldRevisionPredicate?.operator, 'IS');

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  assert.ok(deletedPredicate);
  assert.strictEqual(deletedPredicate?.operator, '=');
  assert.strictEqual(deletedPredicate?.value, false);
});

test('FilterWhereBuilder can include deleted and stale revisions on demand', async () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    true
  );

  await builder.includeDeleted().includeStale().run();

  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  assert.ok(!oldRevisionPredicate);

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  assert.ok(!deletedPredicate);
});

test('FilterWhereBuilder sample enforces revision guards before delegating', async () => {
  type Data = JsonObject & { id: string };
  type Instance = ModelInstance<Data, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>();
  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, true);

  const sampleRows = [{ id: 'example' }];
  let delegatedCount: number | undefined;

  const originalSample = qb.sample.bind(qb);
  type SampleReturn = Awaited<ReturnType<typeof originalSample>>;

  qb.sample = (async (count = 1) => {
    delegatedCount = count;
    return sampleRows as unknown as SampleReturn;
  }) as typeof qb.sample;

  const results = await builder.sample(2);

  assert.strictEqual(delegatedCount, 2);
  assert.strictEqual(results, sampleRows as unknown as Instance[]);

  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  assert.ok(oldRevisionPredicate);
  assert.strictEqual(oldRevisionPredicate.operator, 'IS');

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  assert.ok(deletedPredicate);
  assert.strictEqual(deletedPredicate.operator, '=');
  assert.strictEqual(deletedPredicate.value, false);
});

test('FilterWhereBuilder.revisionData applies revision predicates', () => {
  const schema = {
    id: typesLib.string(),
    name: typesLib.string(),
    created_on: typesLib.string(),
    _rev_id: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness<RevisionRecord, JsonObject, RevisionInstance, string>({
    schema,
    camelToSnake: { createdOn: 'created_on', _revID: '_rev_id' },
  });

  const builder = new FilterWhereBuilder<RevisionRecord, JsonObject, RevisionInstance, string>(
    qb,
    true
  );

  const revId = 'rev-123';
  builder.revisionData({ _revID: revId });

  const predicate = qb._where.find(entry => entry.column === '_rev_id');
  assert.ok(predicate);
  assert.strictEqual(predicate?.operator, '=');
  assert.strictEqual(predicate?.value, revId);
});

test('QueryBuilder supports revision tag filtering', () => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.filterByRevisionTags(['test-tag']);

  assert.strictEqual(result, qb);
  assert.ok(qb._where.length > 0);
  const tagPredicate = qb._where[0];
  assert.strictEqual(tagPredicate.operator, '&&');
  assert.deepStrictEqual(tagPredicate.value, ['test-tag']);

  const { params } = qb._buildSelectQuery();
  assert.deepStrictEqual(params, [['test-tag']]);
});

test('QueryBuilder supports between date ranges', () => {
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');

  const { qb } = createQueryBuilderHarness();
  const result = qb.between(startDate, endDate);

  assert.strictEqual(result, qb);
  assert.ok(qb._where.length >= 2);
  const { params: betweenParams } = qb._buildSelectQuery();
  assert.ok(betweenParams.includes(startDate));
  assert.ok(betweenParams.includes(endDate));
});

test('QueryBuilder supports array contains operations', () => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.contains('urls', 'https://example.com');

  assert.strictEqual(result, qb);
  assert.ok(qb._where.length > 0);
  const containsPredicate = qb._where[0];
  assert.strictEqual(containsPredicate.operator, '@>');
  assert.deepStrictEqual(containsPredicate.value, ['https://example.com']);

  const { sql, params } = qb._buildSelectQuery();
  assert.ok(sql.includes('::text[]'));
  assert.deepStrictEqual(params, [['https://example.com']]);
});

test('QueryBuilder supports simple joins', () => {
  const { qb } = createQueryBuilderHarness({
    tableName: 'reviews',
    relations: [
      {
        name: 'thing',
        targetTable: 'things',
        sourceColumn: 'thing_id',
        hasRevisions: true,
      },
    ],
  });
  const result = qb.getJoin({ thing: true });

  assert.strictEqual(result, qb);
  assert.ok(qb._joinSpecs);
  assert.strictEqual(qb._joinSpecs.length, 1);
  assert.deepStrictEqual(qb._joinSpecs[0], { thing: true });
});

test('QueryBuilder supports complex joins with _apply', () => {
  const { qb } = createQueryBuilderHarness({
    tableName: 'reviews',
    relations: [
      {
        name: 'creator',
        targetTable: 'users',
        sourceColumn: 'created_by',
        hasRevisions: false,
      },
    ],
  });

  const result = qb.getJoin({
    creator: {
      _apply: seq => seq.without('password'),
    },
  });

  assert.strictEqual(result, qb);
  assert.ok(qb._joinSpecs);
  assert.strictEqual(qb._joinSpecs.length, 1);
  const joinSpec = qb._joinSpecs?.[0];
  assert.ok(joinSpec);
  if (joinSpec && typeof joinSpec === 'object' && 'creator' in joinSpec) {
    const creatorSpec = joinSpec.creator;
    if (creatorSpec && typeof creatorSpec === 'object' && '_apply' in creatorSpec) {
      assert.strictEqual(typeof creatorSpec._apply, 'function');
    } else {
      assert.fail('Creator join spec missing _apply handler');
    }
  }
});

test('QueryBuilder builds SELECT queries correctly', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });
  qb.orderBy('created_on', 'DESC');
  qb.limit(10);
  qb.offset(5);

  const { sql: selectSql, params: selectParams } = qb._buildSelectQuery();

  assert.ok(selectSql.includes('SELECT'));
  assert.ok(selectSql.includes('FROM test_table'));
  assert.ok(selectSql.includes('WHERE'));
  assert.ok(selectSql.includes('ORDER BY test_table.created_on DESC'));
  assert.ok(selectSql.includes('LIMIT 10'));
  assert.ok(selectSql.includes('OFFSET 5'));
  assert.deepStrictEqual(selectParams, ['test-id']);
});

test('QueryBuilder builds COUNT queries correctly', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const { sql: countSql, params: countParams } = qb._buildCountQuery();

  assert.ok(countSql.includes('SELECT COUNT(*)'));
  assert.ok(countSql.includes('FROM test_table'));
  assert.ok(countSql.includes('WHERE'));
  assert.deepStrictEqual(countParams, ['test-id']);
});

test('QueryBuilder builds AVG aggregates correctly', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>({
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(
        sql?: string,
        params: unknown[] = []
      ): Promise<QueryResult<TRecord>> {
        queries.push({ sql: sql ?? '', params });
        return createQueryResult<{ value: number }>([
          { value: 3.5 },
        ]) as unknown as QueryResult<TRecord>;
      },
    },
  });

  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const average = await qb.average('created_on');

  assert.strictEqual(average, 3.5);
  assert.strictEqual(queries.length, 1);
  assert.ok(queries[0].sql.includes('SELECT AVG(test_table.created_on) as value'));
  assert.deepStrictEqual(queries[0].params, ['test-id']);
});

test('FilterWhereBuilder.average resolves manifest columns', async () => {
  type Data = { createdOn: string };
  type Instance = ModelInstance<Data, JsonObject>;
  const schema = {
    created_on: typesLib.date(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    schema,
    camelToSnake: { createdOn: 'created_on' },
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(
        sql?: string,
        params: unknown[] = []
      ): Promise<QueryResult<TRecord>> {
        queries.push({ sql: sql ?? '', params });
        return createQueryResult<{ value: number }>([
          { value: 42 },
        ]) as unknown as QueryResult<TRecord>;
      },
    },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);
  const average = await builder.average('createdOn');

  assert.strictEqual(average, 42);
  assert.strictEqual(queries.length, 1);
  assert.ok(queries[0].sql.includes('AVG(test_table.created_on)'));
});

test('QueryBuilder builds DELETE queries correctly', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const { sql: deleteSql, params: deleteParams } = qb._buildDeleteQuery();

  assert.ok(deleteSql.includes('DELETE FROM test_table'));
  assert.ok(deleteSql.includes('WHERE'));
  assert.deepStrictEqual(deleteParams, ['test-id']);
});

test('QueryBuilder handles join information lookup', () => {
  const { qb } = createQueryBuilderHarness({
    tableName: 'reviews',
    relations: [
      {
        name: 'thing',
        targetTable: 'things',
        sourceColumn: 'thing_id',
        hasRevisions: true,
      },
      {
        name: 'creator',
        targetTable: 'users',
        sourceColumn: 'created_by',
        hasRevisions: false,
      },
    ],
  });

  const thingJoin = qb._getJoinInfo('thing');
  assert.ok(thingJoin);
  assert.strictEqual(thingJoin.table, 'things');
  assert.strictEqual(thingJoin.hasRevisions, true);
  assert.strictEqual(thingJoin.condition, 'reviews.thing_id = things.id');
  assert.strictEqual(thingJoin.sourceColumn, 'thing_id');
  assert.strictEqual(thingJoin.targetColumn, 'id');
  assert.strictEqual(thingJoin.cardinality, 'one');
  assert.strictEqual(thingJoin.type, 'direct');

  const creatorJoin = qb._getJoinInfo('creator');
  assert.ok(creatorJoin);
  assert.strictEqual(creatorJoin.table, 'users');
  assert.strictEqual(creatorJoin.hasRevisions, false);
  assert.strictEqual(creatorJoin.condition, 'reviews.created_by = users.id');
  assert.strictEqual(creatorJoin.sourceColumn, 'created_by');
  assert.strictEqual(creatorJoin.targetColumn, 'id');
  assert.strictEqual(creatorJoin.cardinality, 'one');

  const unknownJoin = qb._getJoinInfo('unknown');
  assert.strictEqual(unknownJoin, null);
});

test('QueryBuilder handles schema namespace prefixing', () => {
  const { qb } = createQueryBuilderHarness({
    dalOverrides: { schemaNamespace: 'test_schema.' },
  });

  const tableName = qb._getTableName('users');
  assert.strictEqual(tableName, 'test_schema.users');

  const { qb: qb2 } = createQueryBuilderHarness();
  const tableName2 = qb2._getTableName('users');
  assert.strictEqual(tableName2, 'users');
});

test('FilterWhereBuilder method chaining works correctly', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    true
  );

  const result = builder
    .and({ id: 'active-record' })
    .orderBy('createdOn', 'DESC')
    .limit(10)
    .offset(5)
    .getJoin({ creator: true });

  assert.strictEqual(result, builder);
  assert.ok(qb._where.length > 0);
  assert.ok(qb._orderBy.length > 0);
  assert.strictEqual(qb._limit, 10);
  assert.strictEqual(qb._offset, 5);
  assert.ok(qb._joinSpecs);
});

test('Model constructor maps camelCase fields to snake_case columns', async () => {
  const dalTypes = dalModule.types;
  const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
  const mockDAL = createMockDAL({
    async query<TRecord extends JsonObject = JsonObject>(
      sql: string,
      params: unknown[] = [],
      _client?: import('pg').Pool | import('pg').PoolClient | null
    ) {
      capturedQueries.push({ sql, params });
      const row = { id: 'generated-id', camel_case_field: params[0] } as unknown as TRecord;
      return createQueryResult<TRecord>([row]);
    },
  });

  const { model: TestModel } = initializeModel({
    dal: mockDAL,
    baseTable: 'tmp_models',
    schema: {
      id: dalTypes.string(),
      camelCaseField: dalTypes.string().default('fallback'),
    },
    camelToSnake: {
      camelCaseField: 'camel_case_field',
    },
  });

  const instance = new TestModel({ camelCaseField: 'value' });

  assert.strictEqual(instance._data['camel_case_field'], 'value');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(instance._data, 'camelCaseField'), false);

  await instance.save();

  assert.ok(capturedQueries[0].sql.includes('camel_case_field'));
  assert.deepStrictEqual(capturedQueries[0].params, ['value']);

  const defaultedInstance = new TestModel();
  assert.strictEqual(defaultedInstance._data['camel_case_field'], 'fallback');
});

test('Model.getSafeColumnNames excludes sensitive fields', () => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL) as unknown as typeof Model;
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const safeColumns = TestModel.getSafeColumnNames();

  assert.ok(safeColumns.includes('id'));
  assert.ok(safeColumns.includes('name'));
  assert.ok(safeColumns.includes('email'));
  assert.strictEqual(safeColumns.includes('password'), false);
});

test('Model.getColumnNames includes sensitive fields when requested', () => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    token: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL) as unknown as typeof Model;
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('token', 'token');
  TestModel._registerFieldMapping('email', 'email');

  const allColumns = TestModel.getColumnNames(['password', 'token']);

  assert.ok(allColumns.includes('id'));
  assert.ok(allColumns.includes('name'));
  assert.ok(allColumns.includes('email'));
  assert.ok(allColumns.includes('password'));
  assert.ok(allColumns.includes('token'));
});

test('Model.getSensitiveFieldNames returns all sensitive fields', () => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    token: types.string().sensitive(),
    apiKey: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL) as unknown as typeof Model;

  const sensitiveFields = TestModel.getSensitiveFieldNames();

  assert.strictEqual(sensitiveFields.length, 3);
  assert.ok(sensitiveFields.includes('password'));
  assert.ok(sensitiveFields.includes('token'));
  assert.ok(sensitiveFields.includes('apiKey'));
  assert.strictEqual(sensitiveFields.includes('id'), false);
  assert.strictEqual(sensitiveFields.includes('name'), false);
  assert.strictEqual(sensitiveFields.includes('email'), false);
});

test('QueryBuilder excludes sensitive fields from SELECT by default', () => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('users', schema, {}, mockDAL) as RuntimeModel;
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const qb = new QueryBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    TestModel as unknown as ModelRuntime<DefaultRecord, JsonObject> &
      ModelConstructor<DefaultRecord, JsonObject, DefaultInstance, string>,
    mockDAL
  );
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const { sql } = qb._buildSelectQuery();

  assert.ok(sql.includes('users.id'));
  assert.ok(sql.includes('users.name'));
  assert.ok(sql.includes('users.email'));
  assert.strictEqual(sql.includes('users.password'), false);
});

test('QueryBuilder includes sensitive fields when includeSensitive is called', () => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('users', schema, {}, mockDAL) as RuntimeModel;
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const qb = new QueryBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    TestModel as unknown as ModelRuntime<DefaultRecord, JsonObject> &
      ModelConstructor<DefaultRecord, JsonObject, DefaultInstance, string>,
    mockDAL
  );
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });
  qb.includeSensitive(['password']);

  const { sql } = qb._buildSelectQuery();

  assert.ok(sql.includes('users.id'));
  assert.ok(sql.includes('users.name'));
  assert.ok(sql.includes('users.email'));
  assert.ok(sql.includes('users.password'));
});

test('QueryBuilder.includeSensitive accepts string or array', () => {
  const { qb: qb1 } = createQueryBuilderHarness();
  qb1.includeSensitive('password');
  assert.deepStrictEqual(qb1._includeSensitive, ['password']);

  const { qb: qb2 } = createQueryBuilderHarness();
  qb2.includeSensitive(['password', 'token']);
  assert.deepStrictEqual(qb2._includeSensitive, ['password', 'token']);
});

test('QueryBuilder.increment updates numeric columns with returning support', async () => {
  const schema = {
    id: typesLib.string(),
    counter: typesLib.number(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const calls: Array<{ sql?: string; params?: unknown[] }> = [];
  const { qb } = createQueryBuilderHarness({
    tableName: 'counters',
    schema,
    camelToSnake: { counter: 'counter' },
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(sql?: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return createQueryResult([{ counter: 2 } as unknown as TRecord]);
      },
    },
  });

  qb._addWhereCondition('id', '=', 'user-1');
  const result = await qb.increment('counter', 1, { returning: ['counter'] });

  assert.strictEqual(result.rowCount, 1);
  assert.deepStrictEqual(result.rows[0], { counter: 2 });
  assert.ok(calls[0]?.sql?.includes('counter = counter + $2'));
  assert.deepStrictEqual(calls[0]?.params, ['user-1', 1]);
});

test('QueryBuilder.increment rejects non-numeric schema columns', async () => {
  const schema = {
    id: typesLib.string(),
    title: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness({
    tableName: 'posts',
    schema,
    camelToSnake: { title: 'title' },
  });

  await assert.rejects(
    () => qb.increment('title' as unknown as string, 1, { returning: ['title'] }),
    {
      message: /numeric schema field/,
    }
  );
});

test('FilterWhereBuilder.decrement delegates to increment with negative amount', async () => {
  type Data = { id: string; counter: number };
  const schema = {
    id: typesLib.string(),
    counter: typesLib.number(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const calls: Array<{ sql?: string; params?: unknown[] }> = [];
  const { qb, model } = createQueryBuilderHarness<
    Data,
    JsonObject,
    ModelInstance<Data, JsonObject>,
    string
  >({
    tableName: 'counters',
    schema,
    camelToSnake: { counter: 'counter' },
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(sql?: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return createQueryResult([{ counter: 4 } as unknown as TRecord]);
      },
    },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, ModelInstance<Data, JsonObject>, string>(
    qb,
    false
  );

  builder.and({ id: 'user-1' });
  const result = await builder.decrement('counter', { by: 2, returning: ['counter'] });

  assert.strictEqual(result.rowCount, 1);
  assert.deepStrictEqual(result.rows[0], { counter: 4 });
  assert.ok(calls[0]?.sql?.includes('counter = counter + $2'));
  assert.deepStrictEqual(calls[0]?.params, ['user-1', -2]);
  assert.strictEqual(model.tableName, 'counters');
});

test('QueryBuilder.groupBy adds GROUP BY clause', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();

  const result = qb.groupBy('name');

  assert.strictEqual(result, qb, 'groupBy should return builder for chaining');
  assert.strictEqual(qb._groupBy.length, 1);
  assert.strictEqual(qb._groupBy[0], 'test_table.name');
});

test('QueryBuilder.groupBy handles multiple fields', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();

  qb.groupBy(['name', 'id']);

  assert.strictEqual(qb._groupBy.length, 2);
  assert.strictEqual(qb._groupBy[0], 'test_table.name');
  assert.strictEqual(qb._groupBy[1], 'test_table.id');
});

test('QueryBuilder.groupBy preserves qualified field references', () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();

  qb.groupBy('other_table.field');

  assert.strictEqual(qb._groupBy[0], 'other_table.field');
});

test('QueryBuilder.aggregateGrouped requires groupBy first', async () => {
  const { qb } = createQueryBuilderHarness<DefaultRecord, JsonObject, DefaultInstance, string>();

  await assert.rejects(async () => qb.aggregateGrouped('COUNT'), {
    message: /aggregateGrouped requires groupBy/,
  });
});

test('QueryBuilder.aggregateGrouped executes grouped COUNT query', async () => {
  type Data = { id: string; category: string };
  const calls: Array<{ sql?: string; params?: unknown[] }> = [];

  const { qb } = createQueryBuilderHarness<
    Data,
    JsonObject,
    ModelInstance<Data, JsonObject>,
    string
  >({
    tableName: 'items',
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(sql?: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return createQueryResult([
          { group_key: 'electronics', aggregate_value: 5 },
          { group_key: 'books', aggregate_value: 3 },
        ] as unknown as TRecord[]);
      },
    },
  });

  qb.groupBy('category');
  const result = await qb.aggregateGrouped('COUNT');

  assert.strictEqual(result.size, 2);
  assert.strictEqual(result.get('electronics'), 5);
  assert.strictEqual(result.get('books'), 3);
  assert.ok(calls[0]?.sql?.includes('GROUP BY'));
  assert.ok(calls[0]?.sql?.includes('COUNT(*)'));
});

test('QueryBuilder.aggregateGrouped supports AVG with field', async () => {
  type Data = { id: string; category: string; price: number };
  const calls: Array<{ sql?: string; params?: unknown[] }> = [];

  const { qb } = createQueryBuilderHarness<
    Data,
    JsonObject,
    ModelInstance<Data, JsonObject>,
    string
  >({
    tableName: 'products',
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(sql?: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return createQueryResult([
          { group_key: 'electronics', aggregate_value: 299.99 },
          { group_key: 'books', aggregate_value: 19.99 },
        ] as unknown as TRecord[]);
      },
    },
  });

  qb.groupBy('category');
  const result = await qb.aggregateGrouped('AVG', { aggregateField: 'price' });

  assert.strictEqual(result.size, 2);
  assert.strictEqual(result.get('electronics'), 299.99);
  assert.strictEqual(result.get('books'), 19.99);
  assert.ok(calls[0]?.sql?.includes('AVG(products.price)'));
});

test('FilterWhereBuilder.groupBy resolves camelCase fields', () => {
  type Data = { id: string; createdBy: string };
  type Instance = ModelInstance<Data, JsonObject>;

  const schema = {
    id: typesLib.string(),
    createdBy: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    schema,
    camelToSnake: { createdBy: 'created_by' },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);
  builder.groupBy('createdBy');

  assert.strictEqual(qb._groupBy.length, 1);
  assert.strictEqual(qb._groupBy[0], 'test_table.created_by');
});

test('FilterWhereBuilder.aggregateGrouped applies revision filters', async () => {
  type Data = { id: string; thingID: string; _old_rev_of?: string | null; _rev_deleted?: boolean };
  type Instance = ModelInstance<Data, JsonObject>;

  const calls: Array<{ sql?: string; params?: unknown[] }> = [];
  const { qb } = createQueryBuilderHarness<Data, JsonObject, Instance, string>({
    tableName: 'reviews',
    dalOverrides: {
      async query<TRecord extends JsonObject = JsonObject>(sql?: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return createQueryResult([
          { group_key: 'thing-1', aggregate_value: 2 },
        ] as unknown as TRecord[]);
      },
    },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, true);
  builder.groupBy('thingID');
  const result = await builder.aggregateGrouped('COUNT');

  assert.strictEqual(result.size, 1);
  assert.strictEqual(result.get('thing-1'), 2);

  assert.ok(calls[0]?.sql?.includes('_old_rev_of IS'));
  assert.ok(calls[0]?.sql?.includes('_rev_deleted'));
});
