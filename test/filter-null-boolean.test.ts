import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createOperators, FilterWhereBuilder } from '../src/lib/filter-where.js';
import types from '../src/lib/type.js';
import { createQueryBuilderHarness } from './helpers/dal-mocks.js';
import { resolveTestConfig } from './helpers/postgres-fixture.js';

type Row = { id: string; name: string | null; enabled: boolean | null };
const ops = createOperators<Row>();

test('null and boolean operators preserve SQL semantics across filter compositions', async () => {
  const pool = new pg.Pool(resolveTestConfig());
  try {
    for (const [field, operator, expected, sqlPredicate] of [
      ['name', ops.neq(null), ['a', 'c'], 'name IS NOT NULL'],
      ['enabled', ops.not(), ['b', 'c'], 'enabled IS NOT TRUE'],
    ] as const) {
      for (const composition of ['filter', 'and', 'or', 'multi-or'] as const) {
        const { qb } = createQueryBuilderHarness<Row>({
          schema: { id: types.string(), name: types.string(), enabled: types.boolean() },
        });
        const builder = new FilterWhereBuilder(qb, false);
        const predicate = { [field]: operator };
        if (composition === 'filter') {
          builder.and(predicate);
        } else {
          builder.and({ id: ops.neq('before') });
          if (composition === 'and') builder.and(predicate);
          else if (composition === 'or') builder.or(predicate);
          else builder.or({ ...predicate, id: 'missing' });
          builder.and({ id: ops.neq('after') });
        }
        const { sql, params } = qb._buildWhereClause();
        const grouped = composition === 'or' || composition === 'multi-or';
        const expectedPredicate = grouped
          ? `(${sqlPredicate}${composition === 'multi-or' ? ' OR id = $2' : ''})`
          : sqlPredicate;
        assert.equal(
          sql,
          composition === 'filter'
            ? expectedPredicate
            : `id != $1 AND ${expectedPredicate} AND id != $${composition === 'multi-or' ? 3 : 2}`
        );
        assert.deepEqual(
          params,
          composition === 'filter'
            ? []
            : composition === 'multi-or'
              ? ['before', 'missing', 'after']
              : ['before', 'after']
        );
        const result = await pool.query(
          `SELECT id FROM (VALUES
            ('a', 'x'::text, TRUE),
            ('b', NULL::text, FALSE),
            ('c', 'y'::text, NULL::boolean)
          ) AS items(id, name, enabled) WHERE ${sql} ORDER BY id`,
          params
        );
        assert.deepEqual(
          result.rows.map(row => row.id),
          expected,
          `${field} via ${composition}`
        );
      }
    }
  } finally {
    await pool.end();
  }
});
