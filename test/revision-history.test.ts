import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { cloneRowValue } from '../src/lib/clone.js';
import { RevisionConflictError } from '../src/lib/errors.js';
import type { JsonObject } from '../src/lib/model-types.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';
import {
  assertArchivedRevisionMatches,
  countAllRevisions,
  createTestDocumentWithRevisions,
  getTestModelDefinitions,
  getTestTableDefinitions,
  getTestUserData,
  type RevisionInstance,
  type RevisionMetadataField,
  type RevisionModel,
  readStoredRow,
} from './helpers/revision-helpers.js';

/**
 * History invariant: an archived revision equals the stored row as it was
 * before the edit, however the new revision was edited and whichever write
 * path saved it. Current rows must reflect every edit, including in-place ones.
 */

type Editable = {
  title?: string | null;
  content?: string | null;
  labels?: Record<string, string> | null;
  metadata?: RevisionMetadataField | null;
  keywords?: string[] | null;
  publishedOn?: Date | null;
};

type HistoryModel = RevisionModel & {
  filterWhere(literal: JsonObject): {
    getAllRevisions(id: string): { run(): Promise<RevisionInstance[]> };
    getRevisionByRevId(revId: string, id: string): { first(): Promise<RevisionInstance | null> };
  };
};

let fixture: PostgresFixture;
let Revisions: HistoryModel;
const user = getTestUserData();

const table = () => fixture.getTableName('revisions');

/** Load a fresh copy from the database, as apps do before editing. */
const createAndLoad = async () => {
  const created = await createTestDocumentWithRevisions(Revisions, user, 1);
  return Revisions.getNotStaleOrDeleted(created.id);
};

/** The editable fields of a stored row, keyed like the model. */
const toEditable = (row: JsonObject): Editable =>
  cloneRowValue({
    title: row.title as string,
    content: row.content as string,
    labels: row.labels as Editable['labels'],
    metadata: row.metadata as Editable['metadata'],
    keywords: row.keywords as string[],
    publishedOn: row.published_on as Date,
  });

/** Assert the current row matches the expected editable fields. */
const assertCurrentRow = (row: JsonObject, expected: Editable) => {
  assert.deepStrictEqual(toEditable(row), expected);
};

const editStyles: Array<{ name: string; edit: (doc: Editable) => void }> = [
  {
    name: 'reassign a scalar field',
    edit: doc => {
      doc.title = 'Reassigned title';
    },
  },
  {
    name: 'reassign a JSONB object',
    edit: doc => {
      doc.labels = { en: 'Reassigned label' };
    },
  },
  {
    name: 'set a nested key in place',
    edit: doc => {
      (doc.labels as Record<string, string>).en = 'Edited label';
    },
  },
  {
    name: 'add a nested key in place',
    edit: doc => {
      (doc.labels as Record<string, string>).fr = 'Nouvelle étiquette';
    },
  },
  {
    name: 'delete a nested key in place',
    edit: doc => {
      delete (doc.labels as Record<string, string>).de;
    },
  },
  {
    name: 'edit a deeply nested value in place',
    edit: doc => {
      (doc.metadata as RevisionMetadataField).description.en = 'Edited description';
    },
  },
  {
    name: 'push onto a nested array',
    edit: doc => {
      (doc.metadata as RevisionMetadataField).sources.push('source-new');
    },
  },
  {
    name: 'push onto a top-level array',
    edit: doc => {
      (doc.keywords as string[]).push('keyword-new');
    },
  },
  {
    name: 'splice and sort an array in place',
    edit: doc => {
      const keywords = doc.keywords as string[];
      keywords.push('zeta', 'alpha');
      keywords.splice(0, 1);
      keywords.sort();
    },
  },
  {
    name: 'mutate a Date in place',
    edit: doc => {
      (doc.publishedOn as Date).setUTCFullYear(2030);
    },
  },
  {
    name: 'set a JSONB field to null',
    edit: doc => {
      doc.metadata = null;
    },
  },
  {
    name: 'combine reassignment and in-place edits',
    edit: doc => {
      doc.content = 'Reassigned content';
      (doc.labels as Record<string, string>).en = 'Edited label';
      (doc.metadata as RevisionMetadataField).sources.splice(0, 1, 'replaced-source');
      (doc.keywords as string[]).reverse();
      (doc.publishedOn as Date).setUTCHours(23);
    },
  },
];

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_history',
    tableDefs: getTestTableDefinitions(),
    modelDefs: getTestModelDefinitions(),
  });
  Revisions = fixture.models.revisions as HistoryModel;
});

beforeEach(async () => {
  await fixture.cleanupTables(['revisions', 'users']);
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

for (const { name, edit } of editStyles) {
  test(`newRevision() + save(): ${name}`, async () => {
    const doc = await createAndLoad();
    const stored = await readStoredRow(fixture.dal, table(), doc.id);
    const expected = toEditable(stored);
    edit(expected);

    const rev = await doc.newRevision(user, { tags: ['edit'] });
    edit(rev as Editable);
    await rev.save();

    await assertArchivedRevisionMatches(fixture.dal, table(), stored);
    assertCurrentRow(await readStoredRow(fixture.dal, table(), doc.id), expected);
  });
}

test('saveAll(): in-place edits keep the archive intact', async () => {
  const doc = await createAndLoad();
  const stored = await readStoredRow(fixture.dal, table(), doc.id);

  const rev = await doc.newRevision(user, { tags: ['edit'] });
  (rev.labels as Record<string, string>).en = 'Edited via saveAll';
  (rev.keywords as string[]).push('saveAll');
  await rev.saveAll();

  await assertArchivedRevisionMatches(fixture.dal, table(), stored);
  const current = await readStoredRow(fixture.dal, table(), doc.id);
  assert.strictEqual((current.labels as Record<string, string>).en, 'Edited via saveAll');
  assert.deepStrictEqual(current.keywords, ['original', 'saveAll']);
});

test('save({ transaction }): archive written on commit, nothing on rollback', async () => {
  const doc = await createAndLoad();
  const stored = await readStoredRow(fixture.dal, table(), doc.id);

  // Rolled back by the caller: no archive, current row unchanged
  const rolledBack = await Revisions.getNotStaleOrDeleted(doc.id);
  await assert.rejects(
    fixture.dal.transaction(async client => {
      const rev = await rolledBack.newRevision(user, { tags: ['edit'] });
      (rev.labels as Record<string, string>).en = 'Rolled back';
      await rev.save({ transaction: client });
      throw new Error('caller aborts');
    }),
    /caller aborts/
  );
  assert.deepStrictEqual(await readStoredRow(fixture.dal, table(), doc.id), stored);
  assert.strictEqual(await countAllRevisions(fixture.dal, table(), doc.id), 1);

  // Committed by the caller: invariant holds
  await fixture.dal.transaction(async client => {
    const rev = await doc.newRevision(user, { tags: ['edit'] });
    (rev.labels as Record<string, string>).en = 'Committed';
    await rev.save({ transaction: client });
  });
  await assertArchivedRevisionMatches(fixture.dal, table(), stored);
});

test('deleteAllRevisions(): the archive holds the pre-delete row', async () => {
  const doc = await createAndLoad();
  const stored = await readStoredRow(fixture.dal, table(), doc.id);

  await doc.deleteAllRevisions(user, { tags: ['cleanup'] });

  // deleteAllRevisions() flags every archived row as deleted; all else must match
  const archived = await assertArchivedRevisionMatches(fixture.dal, table(), stored, {
    ignore: ['_rev_deleted'],
  });
  assert.strictEqual(archived._rev_deleted, true);
  const current = await readStoredRow(fixture.dal, table(), doc.id);
  assert.strictEqual(current._rev_deleted, true);
  assert.deepStrictEqual(toEditable(current), toEditable(stored), 'content is unchanged');
});

test('a chain of revisions keeps every version, readable through the model', async () => {
  let doc = await createAndLoad();
  const snapshots: JsonObject[] = [];

  for (const { edit } of editStyles.slice(2, 7)) {
    const stored = await readStoredRow(fixture.dal, table(), doc.id);
    snapshots.push(stored);
    const rev = await doc.newRevision(user, { tags: ['edit'] });
    edit(rev as Editable);
    await rev.save();
    await assertArchivedRevisionMatches(fixture.dal, table(), stored);
    doc = await Revisions.getNotStaleOrDeleted(doc.id);
  }

  // Each archived version reads back through the model with its original values
  for (const stored of snapshots) {
    const archived = await Revisions.filterWhere({})
      .getRevisionByRevId(stored._rev_id as string, doc.id)
      .first();
    assert.ok(archived, `revision ${String(stored._rev_id)} is readable`);
    assert.deepStrictEqual(
      toEditable({ ...archived._data, published_on: archived.publishedOn }),
      toEditable(stored)
    );
  }

  const history = await Revisions.filterWhere({}).getAllRevisions(doc.id).run();
  assert.strictEqual(history.length, snapshots.length + 1);
  const historyRevIds = history.map(entry => entry._data._rev_id).sort();
  const expectedRevIds = [...snapshots.map(s => s._rev_id), doc._data._rev_id].sort();
  assert.deepStrictEqual(historyRevIds, expectedRevIds);
});

test('a second newRevision() before save() keeps the first snapshot', async () => {
  const doc = await createAndLoad();
  const stored = await readStoredRow(fixture.dal, table(), doc.id);

  const rev = await doc.newRevision(user, { tags: ['edit'] });
  (rev.labels as Record<string, string>).en = 'First edit';
  const again = await rev.newRevision(user, { tags: ['edit'] });
  (again.labels as Record<string, string>).en = 'Second edit';
  (again.keywords as string[]).push('second');
  await again.save();

  await assertArchivedRevisionMatches(fixture.dal, table(), stored);
  assert.strictEqual(await countAllRevisions(fixture.dal, table(), doc.id), 2);
  const current = await readStoredRow(fixture.dal, table(), doc.id);
  assert.strictEqual((current.labels as Record<string, string>).en, 'Second edit');
});

test('a stale in-place edit conflicts and leaves history intact', async () => {
  const doc = await createAndLoad();
  const staleCopy = await Revisions.getNotStaleOrDeleted(doc.id);
  const stored = await readStoredRow(fixture.dal, table(), doc.id);

  const winner = await doc.newRevision(user, { tags: ['edit'] });
  (winner.labels as Record<string, string>).en = 'Winner';
  await winner.save();
  const afterWinner = await readStoredRow(fixture.dal, table(), doc.id);

  const loser = await staleCopy.newRevision(user, { tags: ['edit'] });
  (loser.labels as Record<string, string>).en = 'Loser';
  (loser.keywords as string[]).push('loser');
  await assert.rejects(() => loser.save(), RevisionConflictError);

  await assertArchivedRevisionMatches(fixture.dal, table(), stored);
  assert.deepStrictEqual(await readStoredRow(fixture.dal, table(), doc.id), afterWinner);
  assert.strictEqual(await countAllRevisions(fixture.dal, table(), doc.id), 2);
});
