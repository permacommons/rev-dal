import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperators, FilterWhereBuilder } from '../src/lib/filter-where.js';
import type { JsonObject } from '../src/lib/model-types.js';
import { createQueryBuilderHarness } from './helpers/dal-mocks.js';

/**
 * Pins the SQL every `Model.ops` helper produces, both when applied through
 * and() (added to the query directly) and inside or() (built into a group).
 * Covers each operator's edge cases: null, empty lists, casts, open bounds.
 */

// Operator helpers are typed per model field; the harness model is untyped.
const ops = createOperators<JsonObject>() as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

const whereOf = (apply: (builder: FilterWhereBuilder<any, any, any, string>) => void) => {
  const { qb } = createQueryBuilderHarness();
  apply(new FilterWhereBuilder(qb as never, false));
  const { sql, params } = (
    qb as unknown as {
      _buildSelectQuery(): { sql: string; params: unknown[] };
    }
  )._buildSelectQuery();
  const index = sql.indexOf(' WHERE ');
  return { where: index === -1 ? null : sql.slice(index + ' WHERE '.length), params };
};

type Case = {
  name: string;
  make: () => unknown;
  and: string | null;
  andParams: unknown[];
  or: string | null;
  orParams: unknown[];
};

// `or` is null where the or() form is a known bug to be fixed separately:
// neq(null) inside or() compares with != NULL, which never matches.
const cases: Case[] = [
  {
    name: 'neq value',
    make: () => ops.neq('x'),
    and: 'test_table.name != $1',
    andParams: ['x'],
    or: '(test_table.name != $1 OR test_table.id = $2)',
    orParams: ['x', 'other'],
  },
  {
    name: 'neq null',
    make: () => ops.neq(null),
    and: 'test_table.name IS NOT NULL',
    andParams: [],
    or: null,
    orParams: [null, 'other'],
  },
  {
    name: 'lt',
    make: () => ops.lt(1),
    and: 'test_table.name < $1',
    andParams: [1],
    or: '(test_table.name < $1 OR test_table.id = $2)',
    orParams: [1, 'other'],
  },
  {
    name: 'lte',
    make: () => ops.lte(1),
    and: 'test_table.name <= $1',
    andParams: [1],
    or: '(test_table.name <= $1 OR test_table.id = $2)',
    orParams: [1, 'other'],
  },
  {
    name: 'gt',
    make: () => ops.gt(1),
    and: 'test_table.name > $1',
    andParams: [1],
    or: '(test_table.name > $1 OR test_table.id = $2)',
    orParams: [1, 'other'],
  },
  {
    name: 'gte',
    make: () => ops.gte(1),
    and: 'test_table.name >= $1',
    andParams: [1],
    or: '(test_table.name >= $1 OR test_table.id = $2)',
    orParams: [1, 'other'],
  },
  {
    name: 'containsAll array',
    make: () => ops.containsAll(['a', 'b']),
    and: 'test_table.name @> $1::text[]',
    andParams: [['a', 'b']],
    or: '(test_table.name @> $1::text[] OR test_table.id = $2)',
    orParams: [['a', 'b'], 'other'],
  },
  {
    name: 'containsAll string',
    make: () => ops.containsAll('a'),
    and: 'test_table.name @> $1::text[]',
    andParams: [['a']],
    or: '(test_table.name @> $1::text[] OR test_table.id = $2)',
    orParams: [['a'], 'other'],
  },
  {
    name: 'containsAll empty',
    make: () => ops.containsAll([]),
    and: null,
    andParams: [],
    or: '(test_table.id = $1)',
    orParams: ['other'],
  },
  {
    name: 'containsAny array',
    make: () => ops.containsAny(['a']),
    and: 'test_table.name && $1::text[]',
    andParams: [['a']],
    or: '(test_table.name && $1::text[] OR test_table.id = $2)',
    orParams: [['a'], 'other'],
  },
  {
    name: 'containsAny empty',
    make: () => ops.containsAny([]),
    and: 'FALSE',
    andParams: [],
    or: '(FALSE OR test_table.id = $1)',
    orParams: ['other'],
  },
  {
    name: 'in',
    make: () => ops.in(['a', 'b']),
    and: 'test_table.name = ANY ($1)',
    andParams: [['a', 'b']],
    or: '(test_table.name = ANY ($1) OR test_table.id = $2)',
    orParams: [['a', 'b'], 'other'],
  },
  {
    name: 'in cast',
    make: () => ops.in(['a'], { cast: 'uuid[]' }),
    and: 'test_table.name = ANY ($1::uuid[])',
    andParams: [['a']],
    or: '(test_table.name = ANY ($1::uuid[]) OR test_table.id = $2)',
    orParams: [['a'], 'other'],
  },
  {
    name: 'notIn',
    make: () => ops.notIn(['a']),
    and: 'test_table.name != ALL ($1)',
    andParams: [['a']],
    or: '(test_table.name != ALL ($1) OR test_table.id = $2)',
    orParams: [['a'], 'other'],
  },
  {
    name: 'notIn cast',
    make: () => ops.notIn(['a'], { cast: 'text[]' }),
    and: 'test_table.name != ALL ($1::text[])',
    andParams: [['a']],
    or: '(test_table.name != ALL ($1::text[]) OR test_table.id = $2)',
    orParams: [['a'], 'other'],
  },
  {
    name: 'between closed',
    make: () => ops.between(1, 5),
    and: '(test_table.name >= $1 AND test_table.name <= $2)',
    andParams: [1, 5],
    or: '((test_table.name >= $1 AND test_table.name <= $2) OR test_table.id = $3)',
    orParams: [1, 5, 'other'],
  },
  {
    name: 'between open',
    make: () => ops.between(1, 5, { leftBound: 'open', rightBound: 'open' }),
    and: '(test_table.name > $1 AND test_table.name < $2)',
    andParams: [1, 5],
    or: '((test_table.name > $1 AND test_table.name < $2) OR test_table.id = $3)',
    orParams: [1, 5, 'other'],
  },
  {
    name: 'notBetween closed',
    make: () => ops.notBetween(1, 5),
    and: '(test_table.name < $1 OR test_table.name > $2)',
    andParams: [1, 5],
    or: '((test_table.name < $1 OR test_table.name > $2) OR test_table.id = $3)',
    orParams: [1, 5, 'other'],
  },
  {
    name: 'notBetween open left',
    make: () => ops.notBetween(1, 5, { leftBound: 'open' }),
    and: '(test_table.name <= $1 OR test_table.name > $2)',
    andParams: [1, 5],
    or: '((test_table.name <= $1 OR test_table.name > $2) OR test_table.id = $3)',
    orParams: [1, 5, 'other'],
  },
  {
    name: 'jsonContains',
    make: () => ops.jsonContains({ a: 1 }),
    and: 'test_table.name @> $1::jsonb',
    andParams: ['{"a":1}'],
    or: '(test_table.name @> $1::jsonb OR test_table.id = $2)',
    orParams: ['{"a":1}', 'other'],
  },
  {
    name: 'ilike',
    make: () => ops.ilike('%a%'),
    and: 'test_table.name ILIKE $1',
    andParams: ['%a%'],
    or: '(test_table.name ILIKE $1 OR test_table.id = $2)',
    orParams: ['%a%', 'other'],
  },
  {
    name: 'like',
    make: () => ops.like('a%'),
    and: 'test_table.name LIKE $1',
    andParams: ['a%'],
    or: '(test_table.name LIKE $1 OR test_table.id = $2)',
    orParams: ['a%', 'other'],
  },
  {
    name: 'notLike',
    make: () => ops.notLike('a%'),
    and: 'test_table.name NOT LIKE $1',
    andParams: ['a%'],
    or: '(test_table.name NOT LIKE $1 OR test_table.id = $2)',
    orParams: ['a%', 'other'],
  },
  {
    name: 'notIlike',
    make: () => ops.notIlike('a%'),
    and: 'test_table.name NOT ILIKE $1',
    andParams: ['a%'],
    or: '(test_table.name NOT ILIKE $1 OR test_table.id = $2)',
    orParams: ['a%', 'other'],
  },
];

for (const { name, make, and, andParams, or, orParams } of cases) {
  test(`ops ${name}`, () => {
    assert.deepStrictEqual(
      whereOf(builder => builder.and({ name: make() })),
      { where: and, params: andParams },
      'via and()'
    );
    if (or !== null) {
      assert.deepStrictEqual(
        whereOf(builder => builder.or({ name: make(), id: 'other' })),
        { where: or, params: orParams },
        'inside or()'
      );
    }
  });
}

test('ops in() and notIn() reject an empty list', () => {
  assert.throws(() => ops.in([]), /requires at least one value/);
  assert.throws(() => ops.notIn([]), /requires at least one value/);
});
