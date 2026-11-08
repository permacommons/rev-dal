import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperators, FilterWhereBuilder } from '../src/lib/filter-where.js';
import types from '../src/lib/type.js';
import { createQueryBuilderHarness, createQueryResult } from './helpers/dal-mocks.js';

function setup(hasRevisions = false) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const { qb } = createQueryBuilderHarness({
    tableName: 'app.pages',
    schema: {
      id: types.string(),
      body: types.string(),
      bodyEditCounts: types.object(),
      password: types.string().sensitive(),
      computed: { isVirtual: true, validate: () => 0 },
      ...(hasRevisions ? { _revID: types.string() } : {}),
    },
    camelToSnake: { bodyEditCounts: 'body_edit_counts', _revID: '_rev_id' },
    dalOverrides: {
      async query(sql = '', params = []) {
        calls.push({ sql, params });
        return createQueryResult([]);
      },
    },
  });
  return { qb, calls, builder: new FilterWhereBuilder(qb, hasRevisions) };
}

test('projection selects only requested mapped fields with revision guards and plain frozen results', async () => {
  const { qb, builder, calls } = setup(true);
  const date = new Date();
  qb.dal.query = async (sql = '', params = []) => {
    calls.push({ sql, params });
    return createQueryResult([{ _revID: 'rev', bodyEditCounts: { en: 2 }, extra: date }]) as never;
  };
  const rows = await builder.select('_revID', 'bodyEditCounts');
  assert.deepEqual(rows, [{ _revID: 'rev', bodyEditCounts: { en: 2 } }]);
  assert.ok(Object.isFrozen(rows[0]));
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  assert.equal(rows[0]?.save, undefined);
  assert.match(
    calls[0]!.sql,
    /^SELECT "app"\."pages"\."_rev_id" AS "_revID", "app"\."pages"\."body_edit_counts" AS "bodyEditCounts" FROM/
  );
  assert.doesNotMatch(calls[0]!.sql, /\.body\b/);
  assert.match(calls[0]!.sql, /_old_rev_of IS NULL/);
  assert.match(calls[0]!.sql, /_rev_deleted =/);
});

test('projection snapshots predicates, values, ordering and pagination', async () => {
  const { builder, qb, calls } = setup(true);
  const ids: [string, ...string[]] = ['a', 'b'];
  builder
    .getAllRevisions('page')
    .revisionData({ _revID: createOperators<{ _revID: string }>().in(ids) })
    .orderBy('id')
    .limit(5)
    .offset(2);
  const projected = builder.select('bodyEditCounts');
  ids.push('c');
  builder.and({ body: 'changed' }).orderBy('body').limit(100);
  await projected.run();
  await projected.first();
  assert.doesNotMatch(calls[0]!.sql, /_rev_deleted|_old_rev_of IS NULL|changed|ORDER BY.*body/);
  assert.deepEqual(calls[0]!.params, ['page', 'page', ['a', 'b'], 5, 2]);
  assert.deepEqual(calls[1]!.params, ['page', 'page', ['a', 'b'], 1, 2]);
  assert.deepEqual(qb._select, ['*']);
  assert.equal(qb._limit, 100);
});

test('projection validates fields and preserves sensitive opt-in', async () => {
  const { qb, builder, calls } = setup();
  for (const fields of [
    [],
    ['missing'],
    ['computed'],
    ['id; DROP TABLE pages'],
    ['_revID'],
    ['password'],
  ]) {
    assert.throws(() => qb._project(fields), TypeError);
  }
  await builder.includeSensitive('password').select('id');
  assert.doesNotMatch(calls[0]!.sql, /password/);
  await builder.select('password');
  assert.match(calls[1]!.sql, /AS "password"/);
  assert.deepEqual(qb._select, ['*']);
});

test('projection rejects loaded relations and grouping', () => {
  for (const configure of [
    (qb: ReturnType<typeof setup>['qb']) => qb._joins.push('JOIN other ON true'),
    (qb: ReturnType<typeof setup>['qb']) => {
      qb._complexJoins = { posts: {} as never };
    },
    (qb: ReturnType<typeof setup>['qb']) => qb.groupBy('id'),
  ]) {
    const { qb, builder } = setup();
    configure(qb);
    assert.throws(() => builder.select('id'), /getJoin\(\) or groupBy\(\)/);
  }
});

test('first preserves a zero limit and returns null for an empty result', async () => {
  const { builder, calls } = setup();
  assert.equal(await builder.limit(0).select('id').first(), null);
  assert.deepEqual(calls[0]!.params, [0]);
});
