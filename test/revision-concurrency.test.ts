import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, beforeEach } from 'node:test';
import type { PoolClient } from 'pg';

import DataAccessLayer from '../src/lib/data-access-layer.js';
import { DocumentNotFound, RevisionConflictError } from '../src/lib/errors.js';
import type { JsonObject } from '../src/lib/model-types.js';
import types from '../src/lib/type.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';
import {
  countAllRevisions,
  getTestModelDefinitions,
  getTestTableDefinitions,
  getTestUserData,
  type RevisionInstance,
  type RevisionModel,
} from './helpers/revision-helpers.js';

/**
 * Regression tests for atomic revision writes and optimistic concurrency:
 * - `newRevision()` + `save()` archive and update in one transaction
 * - saving over a revision someone else saved throws `RevisionConflictError`
 * - `deleteAllRevisions()` and `saveAll()` are all-or-nothing
 * - DAL connection/transaction plumbing doesn't leak or mask errors
 */

type PendingState = {
  _pendingRevision: { archive: Record<string, unknown>; expectedRevId: string | null } | null;
};

type RecordInstance = JsonObject & {
  id?: string;
  name?: string;
  labels?: string[];
  _isNew: boolean;
  saveAll(joinOptions?: JsonObject): Promise<RecordInstance>;
};

type RecordModel = new (data?: JsonObject) => RecordInstance;

let fixture: PostgresFixture;
let Revisions: RevisionModel;
let Records: RecordModel;
const testUser = getTestUserData();

const revisionsTable = () => fixture.getTableName('revisions');

const createDocument = async (title: string) => {
  const doc = await Revisions.createFirstRevision(testUser, { tags: ['create'] });
  doc.title = title;
  await doc.save();
  return doc;
};

const readCurrentRow = async (id: string) => {
  const result = await fixture.dal.query(`SELECT * FROM ${revisionsTable()} WHERE id = $1`, [id]);
  return result.rows[0] as JsonObject & { title: string; _rev_id: string; _rev_deleted: boolean };
};

const countRows = async (table: string) => {
  const result = await fixture.dal.query(
    `SELECT COUNT(*) AS count FROM ${fixture.getTableName(table)}`
  );
  return Number.parseInt(String(result.rows[0].count), 10);
};

const insertLabel = async () => {
  const result = await fixture.dal.query(
    `INSERT INTO ${fixture.getTableName('labels')} DEFAULT VALUES RETURNING id`
  );
  return String(result.rows[0].id);
};

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_concurrency',
    tableDefs: [
      ...getTestTableDefinitions(),
      {
        name: 'labels',
        create: (tableName: string) =>
          `CREATE TABLE ${tableName} (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`,
      },
      {
        name: 'records',
        create: (tableName: string) => `
          CREATE TABLE ${tableName} (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT
          )
        `,
      },
      {
        // Column names deliberately don't follow the <table>_id convention
        name: 'record_label_links',
        create: (tableName: string, schemaName: string) => `
          CREATE TABLE ${tableName} (
            record_ref UUID NOT NULL REFERENCES ${schemaName}.records(id) ON DELETE CASCADE,
            label_ref UUID NOT NULL REFERENCES ${schemaName}.labels(id),
            PRIMARY KEY (record_ref, label_ref)
          )
        `,
      },
    ],
    modelDefs: [
      ...getTestModelDefinitions(),
      {
        name: 'records',
        hasRevisions: false,
        schema: { id: types.string().uuid(4), name: types.string() },
        options: {
          relations: [
            {
              name: 'labels',
              targetTable: 'labels',
              cardinality: 'many',
              through: {
                table: 'record_label_links',
                sourceForeignKey: 'record_ref',
                targetForeignKey: 'label_ref',
              },
            },
          ],
        },
      },
    ],
  });
  Revisions = fixture.models.revisions as RevisionModel;
  Records = fixture.models.records as unknown as RecordModel;
});

beforeEach(async () => {
  await fixture.cleanupTables(['record_label_links', 'records', 'labels', 'revisions', 'users']);
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

test('newRevision() writes nothing until save()', async () => {
  const doc = await createDocument('Original');

  await doc.newRevision(testUser, { tags: ['edit'] });
  assert.strictEqual(await countAllRevisions(fixture.dal, revisionsTable(), doc.id), 1);

  doc.title = 'Edited';
  await doc.save();
  assert.strictEqual(await countAllRevisions(fixture.dal, revisionsTable(), doc.id), 2);
  assert.strictEqual((await readCurrentRow(doc.id)).title, 'Edited');
});

test('saving a revision over a newer one throws RevisionConflictError and writes nothing', async () => {
  const doc = await createDocument('Original');
  const loadedRevId = doc._data._rev_id;
  const staleCopy = (await Revisions.getNotStaleOrDeleted(doc.id)) as RevisionInstance;

  const winner = await doc.newRevision(testUser, { tags: ['edit'] });
  winner.title = 'Winner';
  await winner.save();

  const loser = await staleCopy.newRevision(testUser, { tags: ['edit'] });
  loser.title = 'Loser';
  await assert.rejects(
    () => loser.save(),
    (error: unknown) => {
      assert.ok(error instanceof RevisionConflictError);
      assert.strictEqual(error.code, 'REVISION_CONFLICT');
      assert.strictEqual(error.documentId, doc.id);
      assert.strictEqual(error.expectedRevId, loadedRevId);
      assert.strictEqual(error.currentRevId, winner._data._rev_id);
      return true;
    }
  );

  const current = await readCurrentRow(doc.id);
  assert.strictEqual(current.title, 'Winner');
  assert.strictEqual(current._rev_id, winner._data._rev_id);
  // Original + the winner's archive only; the loser's archive was rolled back
  assert.strictEqual(await countAllRevisions(fixture.dal, revisionsTable(), doc.id), 2);
});

test('concurrent revision saves: exactly one wins, the other conflicts', async () => {
  const doc = await createDocument('Original');
  const copies = [
    (await Revisions.getNotStaleOrDeleted(doc.id)) as RevisionInstance,
    (await Revisions.getNotStaleOrDeleted(doc.id)) as RevisionInstance,
  ];

  const outcomes = await Promise.allSettled(
    copies.map(async (copy, index) => {
      const rev = await copy.newRevision(testUser, { tags: ['edit'] });
      rev.title = `Edit ${index}`;
      return rev.save();
    })
  );

  const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  );
  assert.strictEqual(fulfilled.length, 1, 'exactly one save succeeds');
  assert.strictEqual(rejected.length, 1, 'exactly one save fails');
  assert.ok(rejected[0].reason instanceof RevisionConflictError);

  const winnerIndex = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
  assert.strictEqual((await readCurrentRow(doc.id)).title, `Edit ${winnerIndex}`);
  assert.strictEqual(await countAllRevisions(fixture.dal, revisionsTable(), doc.id), 2);
});

test('a failed archive insert rolls back the update and keeps the revision pending', async () => {
  const doc = await createDocument('Original');
  const rev = await doc.newRevision(testUser, { tags: ['edit'] });
  rev.title = 'Edited';

  // Force the archive insert (the second statement) to fail
  const state = rev as unknown as PendingState;
  assert.ok(state._pendingRevision);
  state._pendingRevision.archive.no_such_column = 1;

  await assert.rejects(() => rev.save());
  assert.strictEqual((await readCurrentRow(doc.id)).title, 'Original');
  assert.strictEqual(await countAllRevisions(fixture.dal, revisionsTable(), doc.id), 1);

  // Once the problem is gone, the same instance can still be saved
  delete state._pendingRevision?.archive.no_such_column;
  await rev.save();
  assert.strictEqual((await readCurrentRow(doc.id)).title, 'Edited');
  assert.strictEqual(await countAllRevisions(fixture.dal, revisionsTable(), doc.id), 2);
});

test('deleteAllRevisions on a stale copy conflicts and deletes nothing', async () => {
  const doc = await createDocument('Original');
  const staleCopy = (await Revisions.getNotStaleOrDeleted(doc.id)) as RevisionInstance;

  const edit = await doc.newRevision(testUser, { tags: ['edit'] });
  edit.title = 'Edited';
  await edit.save();

  await assert.rejects(
    () => staleCopy.deleteAllRevisions(testUser, { tags: ['cleanup'] }),
    RevisionConflictError
  );

  const rows = await fixture.dal.query(
    `SELECT _rev_deleted FROM ${revisionsTable()} WHERE id = $1 OR _old_rev_of = $1`,
    [doc.id]
  );
  assert.strictEqual(rows.rows.length, 2);
  assert.ok(rows.rows.every(row => row._rev_deleted === false));
  assert.strictEqual((await Revisions.getNotStaleOrDeleted(doc.id)).title, 'Edited');
});

test('saving a revision of a document removed from the table throws DocumentNotFound', async () => {
  const doc = await createDocument('Original');
  await fixture.dal.query(`DELETE FROM ${revisionsTable()} WHERE id = $1`, [doc.id]);

  const rev = await doc.newRevision(testUser, { tags: ['edit'] });
  rev.title = 'Edited';
  await assert.rejects(() => rev.save(), DocumentNotFound);
});

test('saveAll syncs many-to-many links using the configured join columns', async () => {
  const labelA = await insertLabel();
  const labelB = await insertLabel();

  const record = new Records({ name: 'Record' });
  record.labels = [labelA, labelB];
  await record.saveAll();

  const links = await fixture.dal.query(
    `SELECT label_ref FROM ${fixture.getTableName('record_label_links')} WHERE record_ref = $1`,
    [record.id]
  );
  assert.deepStrictEqual(links.rows.map(row => row.label_ref).sort(), [labelA, labelB].sort());
});

test('saveAll rolls back the record when syncing a relation fails', async () => {
  const record = new Records({ name: 'Record' });
  // No such label: the join-table foreign key rejects the link
  record.labels = [randomUUID()];

  await assert.rejects(() => record.saveAll(), /Failed to save labels relation/);
  assert.strictEqual(await countRows('records'), 0, 'record insert was rolled back');
  assert.strictEqual(record._isNew, true, 'instance is not marked as saved');

  // The same instance can be saved once the relation is valid
  record.labels = [await insertLabel()];
  await record.saveAll();
  assert.strictEqual(await countRows('records'), 1);
  assert.strictEqual(await countRows('record_label_links'), 1);
});

test('DAL.transaction reports the original error when ROLLBACK also fails', async () => {
  const released: unknown[] = [];
  const fakeClient = {
    async query(sql: string) {
      if (sql === 'ROLLBACK') {
        throw new Error('connection lost during rollback');
      }
      return { rows: [] };
    },
    release(error?: unknown) {
      released.push(error);
    },
  };

  const dal = new DataAccessLayer({});
  dal.getConnection = async () => fakeClient as unknown as PoolClient;

  await assert.rejects(
    () =>
      dal.transaction(async () => {
        throw new Error('original failure');
      }),
    /original failure/
  );
  assert.strictEqual(released.length, 1);
  assert.ok(released[0] instanceof Error, 'broken client is discarded, not reused');
});

test('DAL.connect failure leaves no pool behind', async () => {
  const dal = new DataAccessLayer({
    host: '127.0.0.1',
    port: 1,
    connectionTimeoutMillis: 1000,
  });

  await assert.rejects(() => dal.connect());
  assert.strictEqual(dal.pool, null);
  assert.strictEqual(dal.isConnected(), false);
});
