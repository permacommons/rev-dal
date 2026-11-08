import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import types from '../src/lib/type.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';

test('projection reads mapped revision metadata and JSON from PostgreSQL without bodies', async () => {
  const fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_projection',
    tableDefs: [
      {
        name: 'pages',
        create: table => `CREATE TABLE ${table} (
        id UUID PRIMARY KEY, body TEXT, body_edit_counts JSONB, secret TEXT,
        _rev_id UUID, _rev_date TIMESTAMPTZ, _old_rev_of UUID, _rev_deleted BOOLEAN
      )`,
      },
    ],
    modelDefs: [
      {
        name: 'pages',
        hasRevisions: true,
        schema: {
          id: types.string(),
          body: types.string(),
          bodyEditCounts: types.object(),
          secret: types.string().sensitive(),
        },
        camelToSnake: { bodyEditCounts: 'body_edit_counts' },
      },
    ],
  });
  try {
    const Page = fixture.models.pages!;
    const pageId = randomUUID();
    const oldId = randomUUID();
    const currentRev = randomUUID();
    const oldRev = randomUUID();
    const otherRev = randomUUID();
    const date = new Date('2026-01-01T00:00:00Z');
    await fixture.dal.query(
      `INSERT INTO ${Page.tableName}
      (id, body, body_edit_counts, secret, _rev_id, _rev_date, _old_rev_of, _rev_deleted)
      VALUES ($1, 'large current body', '{"en":3}', 'private', $2, $3, NULL, false),
             ($4, 'large old body', '{"en":1}', 'private', $5, $3, $1, false),
             ($6, 'unrelated body', '{"en":9}', 'private', $7, $3, NULL, false)`,
      [pageId, currentRev, date, oldId, oldRev, randomUUID(), otherRev]
    );

    const calls: string[] = [];
    const originalQuery = fixture.dal.query.bind(fixture.dal);
    fixture.dal.query = ((sql: string, ...args: unknown[]) => {
      calls.push(sql);
      return originalQuery(sql, ...(args as [unknown[]]));
    }) as typeof fixture.dal.query;

    const current = await Page.filterWhere({ id: pageId }).select('_revID', '_revDate').first();
    assert.deepEqual(current, { _revID: currentRev, _revDate: date });
    const rows = await Page.filterWhere({})
      .getAllRevisions(pageId)
      .revisionData({ _revID: Page.ops.in([currentRev, oldRev, otherRev]) })
      .select('_revID', 'bodyEditCounts');
    assert.deepEqual(
      new Map(rows.map(row => [row._revID, row.bodyEditCounts])),
      new Map([
        [currentRev, { en: 3 }],
        [oldRev, { en: 1 }],
      ])
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => Object.isFrozen(row) && !('save' in row) && !('body' in row)));
    assert.ok(calls.every(sql => !/\."?body"?[, ]/.test(sql)));
    assert.throws(() => Page.filterWhere({}).select('secret'), /includeSensitive/);
    const secret = await Page.filterWhere({ id: pageId })
      .includeSensitive('secret')
      .select('secret')
      .first();
    assert.deepEqual(secret, { secret: 'private' });
  } finally {
    await fixture.cleanup();
  }
});
