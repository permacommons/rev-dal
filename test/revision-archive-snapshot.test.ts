import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { RevisionConflictError } from '../src/lib/errors.js';
import type { JsonObject } from '../src/lib/model-types.js';
import revision from '../src/lib/revision.js';
import types from '../src/lib/type.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';
import { getTestUserData } from './helpers/revision-helpers.js';

/**
 * Regression tests: the archived copy written by `save()` after
 * `newRevision()` must hold the pre-edit values, even when the new revision
 * is edited in place (nested JSONB, arrays, Dates) rather than reassigned.
 */

type Doc = JsonObject & {
  id: string;
  title: Record<string, string>;
  metadata: { description: Record<string, string>; sources: string[] };
  tags: string[];
  publishedOn: Date;
  _data: Record<string, unknown>;
  save(): Promise<Doc>;
  newRevision(user: { id: string }, options?: JsonObject): Promise<Doc>;
};

type DocModel = {
  createFirstRevision(user: { id: string }, options?: JsonObject): Promise<Doc>;
  getNotStaleOrDeleted(id: string): Promise<Doc>;
  filterWhere(literal: JsonObject): {
    getAllRevisions(id: string): { run(): Promise<Doc[]> };
    getRevisionByRevId(revId: string, id: string): { first(): Promise<Doc | null> };
  };
};

let fixture: PostgresFixture;
let Docs: DocModel;
const user = getTestUserData();
const ORIGINAL_DATE = new Date('2020-01-02T03:04:05.000Z');

const createDoc = async () => {
  const doc = await Docs.createFirstRevision(user, { tags: ['create'] });
  doc.title = { en: 'Original', de: 'Original DE' };
  doc.metadata = { description: { en: 'Original description' }, sources: ['a'] };
  doc.tags = ['alpha'];
  doc.publishedOn = new Date(ORIGINAL_DATE);
  await doc.save();
  return doc;
};

const readCurrent = async (id: string) => {
  const result = await fixture.dal.query(
    `SELECT * FROM ${fixture.getTableName('docs')} WHERE id = $1`,
    [id]
  );
  return result.rows[0] as JsonObject;
};

const readArchived = async (id: string) => {
  const result = await fixture.dal.query(
    `SELECT * FROM ${fixture.getTableName('docs')} WHERE _old_rev_of = $1 ORDER BY _rev_date`,
    [id]
  );
  return result.rows as JsonObject[];
};

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_archive_snapshot',
    tableDefs: [
      {
        name: 'docs',
        create: (tableName: string) => `
          CREATE TABLE ${tableName} (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title JSONB,
            metadata JSONB,
            tags TEXT[] DEFAULT '{}',
            published_on TIMESTAMPTZ,
            _rev_user UUID NOT NULL,
            _rev_date TIMESTAMPTZ NOT NULL,
            _rev_id UUID NOT NULL,
            _old_rev_of UUID,
            _rev_deleted BOOLEAN DEFAULT FALSE,
            _rev_tags TEXT[] DEFAULT '{}'
          )
        `,
      },
    ],
    modelDefs: [
      {
        name: 'docs',
        hasRevisions: true,
        schema: {
          id: types.string().uuid(4),
          title: types.object(),
          metadata: types.object(),
          tags: types.array(types.string()),
          publishedOn: types.date(),
          ...revision.getSchema(),
        },
        camelToSnake: { publishedOn: 'published_on' },
      },
    ],
  });
  Docs = fixture.models.docs as unknown as DocModel;
});

beforeEach(async () => {
  await fixture.cleanupTables(['docs']);
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

test('in-place edits to nested JSONB after newRevision() leave the archive untouched', async () => {
  const doc = await createDoc();
  const originalRevId = doc._data._rev_id as string;

  const rev = await doc.newRevision(user, { tags: ['edit'] });
  rev.title.en = 'Edited';
  rev.metadata.description.en = 'Edited description';
  await rev.save();

  // Current row has the edits (in-place changes are detected and written)
  const current = await readCurrent(doc.id);
  assert.deepStrictEqual(current.title, { en: 'Edited', de: 'Original DE' });
  assert.deepStrictEqual(current.metadata, {
    description: { en: 'Edited description' },
    sources: ['a'],
  });

  // Archived row keeps the pre-edit values
  const [archived] = await readArchived(doc.id);
  assert.strictEqual(archived._rev_id, originalRevId);
  assert.deepStrictEqual(archived.title, { en: 'Original', de: 'Original DE' });
  assert.deepStrictEqual(archived.metadata, {
    description: { en: 'Original description' },
    sources: ['a'],
  });

  // Same through the DAL's history helpers
  const byRevId = await Docs.filterWhere({}).getRevisionByRevId(originalRevId, doc.id).first();
  assert.ok(byRevId);
  assert.strictEqual(byRevId.title.en, 'Original');
  assert.strictEqual(byRevId.metadata.description.en, 'Original description');

  const history = await Docs.filterWhere({}).getAllRevisions(doc.id).run();
  assert.deepStrictEqual(history.map(entry => entry.title.en).sort(), ['Edited', 'Original']);
});

test('in-place array and Date changes after newRevision() leave the archive untouched', async () => {
  const doc = await createDoc();

  const rev = await doc.newRevision(user, { tags: ['edit'] });
  rev.tags.push('beta');
  rev.metadata.sources.push('b');
  rev.publishedOn.setUTCFullYear(2024);
  await rev.save();

  const current = await readCurrent(doc.id);
  assert.deepStrictEqual(current.tags, ['alpha', 'beta']);
  assert.deepStrictEqual((current.metadata as Doc['metadata']).sources, ['a', 'b']);
  assert.strictEqual((current.published_on as Date).getUTCFullYear(), 2024);

  const [archived] = await readArchived(doc.id);
  assert.deepStrictEqual(archived.tags, ['alpha']);
  assert.deepStrictEqual((archived.metadata as Doc['metadata']).sources, ['a']);
  assert.ok(archived.published_on instanceof Date);
  assert.strictEqual((archived.published_on as Date).toISOString(), ORIGINAL_DATE.toISOString());
});

test('reassigning fields after newRevision() still archives the original', async () => {
  const doc = await createDoc();

  const rev = await doc.newRevision(user, { tags: ['edit'] });
  rev.title = { en: 'Replaced' };
  rev.tags = ['gamma'];
  await rev.save();

  const [archived] = await readArchived(doc.id);
  assert.deepStrictEqual(archived.title, { en: 'Original', de: 'Original DE' });
  assert.deepStrictEqual(archived.tags, ['alpha']);
  assert.deepStrictEqual((await readCurrent(doc.id)).title, { en: 'Replaced' });
});

test('a second newRevision() before save() keeps the first snapshot', async () => {
  const doc = await createDoc();

  const rev = await doc.newRevision(user, { tags: ['edit'] });
  rev.title.en = 'First edit';
  const again = await rev.newRevision(user, { tags: ['edit'] });
  again.title.en = 'Second edit';
  await again.save();

  const archived = await readArchived(doc.id);
  assert.strictEqual(archived.length, 1, 'one archived revision per save');
  assert.strictEqual((archived[0].title as Doc['title']).en, 'Original');
  assert.strictEqual(((await readCurrent(doc.id)).title as Doc['title']).en, 'Second edit');
});

test('conflict detection is unchanged: a stale in-place edit conflicts and writes nothing', async () => {
  const doc = await createDoc();
  const staleCopy = await Docs.getNotStaleOrDeleted(doc.id);

  const winner = await doc.newRevision(user, { tags: ['edit'] });
  winner.title.en = 'Winner';
  await winner.save();

  const loser = await staleCopy.newRevision(user, { tags: ['edit'] });
  loser.title.en = 'Loser';
  await assert.rejects(() => loser.save(), RevisionConflictError);

  assert.strictEqual(((await readCurrent(doc.id)).title as Doc['title']).en, 'Winner');
  const archived = await readArchived(doc.id);
  assert.strictEqual(archived.length, 1, "no archive from the loser's rolled-back save");
  assert.strictEqual((archived[0].title as Doc['title']).en, 'Original');
});
