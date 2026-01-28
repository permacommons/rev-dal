import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import isUUID from 'is-uuid';

import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';
import {
  countAllRevisions,
  countCurrentRevisions,
  createTestDocumentWithRevisions,
  getTestModelDefinitions,
  getTestTableDefinitions,
  getTestUserData,
  type RevisionModel,
  verifyTestIsolation,
} from './helpers/revision-helpers.js';

let fixture: PostgresFixture;
let RevisionRecords: RevisionModel;
const testUser = getTestUserData();

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_revision',
    tableDefs: getTestTableDefinitions(),
    modelDefs: getTestModelDefinitions(),
  });
  RevisionRecords = fixture.models.revisions as RevisionModel;
});

beforeEach(async () => {
  await fixture.cleanupTables(['revisions', 'users']);
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

test('DAL revision system: can create first revision with PostgreSQL partial indexes', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const firstRev = await RevisionRecords.createFirstRevision(testUser, {
    tags: ['create', 'test'],
  });

  firstRev.title = 'Test Document';
  firstRev.content = 'This is test content';
  await firstRev.save();

  assert.ok(isUUID.v4(firstRev.id), 'Document has valid UUID');
  assert.ok(isUUID.v4(firstRev._data._rev_id), 'Revision has valid UUID');
  assert.strictEqual(firstRev._data._rev_user, testUser.id, 'Revision user is correct');
  assert.ok(firstRev._data._rev_date instanceof Date, 'Revision date is set');
  assert.deepStrictEqual(firstRev._data._rev_tags, ['create', 'test'], 'Revision tags are correct');
  assert.strictEqual(
    firstRev._data._old_rev_of,
    null,
    'First revision has no old_rev_of (PostgreSQL returns null)'
  );
  assert.strictEqual(firstRev._data._rev_deleted, false, 'First revision is not deleted');
});

test('DAL revision system: new revision preserves existing revision mechanics', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const firstRev = await RevisionRecords.createFirstRevision(testUser, { tags: ['create'] });
  firstRev.title = 'Original Title';
  firstRev.content = 'Original content';
  await firstRev.save();

  const originalId = firstRev.id;
  const originalRevId = firstRev._data._rev_id;

  const newRev = await firstRev.newRevision(testUser, { tags: ['edit', 'update'] });
  newRev.title = 'Updated Title';
  newRev.content = 'Updated content';
  await newRev.save();

  assert.strictEqual(newRev.id, originalId, 'Document ID remains the same');
  assert.notStrictEqual(newRev._data._rev_id, originalRevId, 'Revision ID is different');
  assert.strictEqual(newRev._data._rev_user, testUser.id, 'Revision user is correct');
  assert.deepStrictEqual(newRev._data._rev_tags, ['edit', 'update'], 'Revision tags are correct');
  assert.strictEqual(newRev.title, 'Updated Title', 'Content was updated');

  const tableName = fixture.getTableName('revisions');
  const oldRevCount = await countAllRevisions(fixture.dal, tableName, originalId);
  assert.strictEqual(oldRevCount, 2, 'Old revision was created (total 2 revisions)');
});

test('DAL revision system: filterWhere defaults perform efficiently with partial indexes', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const docs = [];
  for (let i = 0; i < 15; i++) {
    const doc = await RevisionRecords.createFirstRevision(testUser, { tags: ['create'] });
    doc.title = `Document ${i}`;
    await doc.save();
    docs.push(doc);

    if (i % 2 === 0) {
      const newRev = await doc.newRevision(testUser, { tags: ['edit'] });
      newRev.title = `Document ${i} Updated`;
      await newRev.save();
    }
  }

  for (let i = 0; i < 3; i++) {
    await docs[i].deleteAllRevisions(testUser, { tags: ['delete'] });
  }

  const start = Date.now();
  const currentRevisions = await RevisionRecords.filterWhere({}).run();
  const queryTime = Date.now() - start;

  assert.ok(currentRevisions.length > 0, 'Found current revisions');
  assert.ok(
    currentRevisions.every(rev => !rev._data._old_rev_of && !rev._data._rev_deleted),
    'All results are current, non-deleted revisions'
  );

  assert.ok(queryTime < 500, 'Query completed efficiently with partial indexes');

  const expectedCurrentCount = 12;
  assert.strictEqual(
    currentRevisions.length,
    expectedCurrentCount,
    'Correct number of current revisions'
  );
});

test('DAL revision system: revision querying patterns', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const finalRev = await createTestDocumentWithRevisions(RevisionRecords, testUser, 3);
  const docId = finalRev.id;

  const current = await RevisionRecords.getNotStaleOrDeleted(docId);
  assert.strictEqual(current.title, 'Updated Title 2', 'Gets current revision');

  const currentRevs = await RevisionRecords.filterWhere({}).run();
  assert.strictEqual(currentRevs.length, 1, 'Filters to current revisions only');
  assert.strictEqual(
    currentRevs[0].title,
    'Updated Title 2',
    'Current revision has latest content'
  );
});

test('DAL revision system: deleteAllRevisions maintains same table structure', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const finalRev = await createTestDocumentWithRevisions(RevisionRecords, testUser, 2);
  const docId = finalRev.id;

  const tableName = fixture.getTableName('revisions');
  const revCountBefore = await countAllRevisions(fixture.dal, tableName, docId);
  assert.strictEqual(revCountBefore, 2, 'Should have 2 revisions before deletion');

  const deletionRev = await finalRev.deleteAllRevisions(testUser, { tags: ['cleanup'] });

  assert.strictEqual(
    deletionRev._data._rev_deleted,
    true,
    'Deletion revision is marked as deleted'
  );
  assert.deepStrictEqual(
    deletionRev._data._rev_tags,
    ['delete', 'cleanup'],
    'Deletion tags are correct'
  );

  const revCountAfter = await countAllRevisions(fixture.dal, tableName, docId);
  assert.strictEqual(
    revCountAfter,
    revCountBefore + 1,
    'Deletion creates new revision, preserves old ones'
  );

  const allRevisions = await fixture.dal.query(
    `SELECT * FROM ${tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [docId]
  );

  assert.ok(
    allRevisions.rows.every(row => row._rev_deleted),
    'All revisions marked as deleted'
  );

  const currentCount = await countCurrentRevisions(fixture.dal, tableName);
  assert.strictEqual(currentCount, 0, 'No current revisions after deletion');
});

test('DAL revision system: getNotStaleOrDeleted throws error for deleted revision', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const doc = await RevisionRecords.createFirstRevision(testUser, { tags: ['create'] });
  doc.title = 'To be deleted';
  await doc.save();
  const docId = doc.id;

  await doc.deleteAllRevisions(testUser, { tags: ['delete'] });

  await assert.rejects(
    async () => RevisionRecords.getNotStaleOrDeleted(docId),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'RevisionDeletedError' &&
      error.message === 'Revision has been deleted.'
  );
});

test('DAL revision system: getNotStaleOrDeleted throws error for stale revision', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const finalRev = await createTestDocumentWithRevisions(RevisionRecords, testUser, 2);
  const originalId = finalRev.id;

  const tableName = fixture.getTableName('revisions');
  const oldRevisions = await fixture.dal.query(
    `SELECT id FROM ${tableName} WHERE _old_rev_of = $1 LIMIT 1`,
    [originalId]
  );
  const staleRevisionId = String((oldRevisions.rows[0] as { id: string }).id);

  await assert.rejects(
    async () => RevisionRecords.getNotStaleOrDeleted(staleRevisionId),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'RevisionStaleError' &&
      error.message === 'Outdated revision.'
  );
});

test('DAL revision system: revision filtering by user works correctly', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const user1 = getTestUserData('1');
  const user2 = getTestUserData('2');

  const doc1 = await RevisionRecords.createFirstRevision(user1, { tags: ['create', 'user1'] });
  doc1.title = 'Document by User 1';
  await doc1.save();

  const doc2 = await RevisionRecords.createFirstRevision(user2, { tags: ['create', 'user2'] });
  doc2.title = 'Document by User 2';
  await doc2.save();

  const allDocs = await RevisionRecords.filterWhere({}).run();
  const user1Docs = allDocs.filter(doc => doc._data._rev_user === user1.id);
  const user2Docs = allDocs.filter(doc => doc._data._rev_user === user2.id);

  assert.strictEqual(user1Docs.length, 1, 'Found one document by user 1');
  assert.strictEqual(user1Docs[0].title, 'Document by User 1', 'Correct document returned');
  assert.strictEqual(user2Docs.length, 1, 'Found one document by user 2');
  assert.strictEqual(user2Docs[0].title, 'Document by User 2', 'Correct document returned');
});

test('DAL revision system: test isolation verification', async () => {
  const { actualCount, expectedCount } = await verifyTestIsolation(
    fixture.dal,
    fixture.getTableName('revisions'),
    0
  );
  assert.strictEqual(actualCount, expectedCount);

  const doc = await RevisionRecords.createFirstRevision(testUser, { tags: ['isolation-test'] });
  doc.title = 'Isolation Test Document';
  await doc.save();

  const tableName = fixture.getTableName('revisions');
  const afterCreate = await fixture.dal.query(`SELECT COUNT(*) as count FROM ${tableName}`);
  assert.strictEqual(Number(afterCreate.rows[0].count), 1, 'Document was created');
});

test('Security: reject malicious field names in INSERT operations', async () => {
  const TestModel = RevisionRecords as RevisionModel;

  const doc = await TestModel.createFirstRevision(testUser, {
    tags: ['security-test'],
  });
  doc.title = 'Test Document';

  (
    doc as Record<string, unknown> & { _data: Record<string, unknown>; _changed: Set<string> }
  )._data['malicious; DROP TABLE users; --'] = 'payload';
  (doc as Record<string, unknown> & { _changed: Set<string> })._changed.add(
    'malicious; DROP TABLE users; --'
  );

  await assert.rejects(
    async () => {
      await doc.save();
    },
    {
      message: /Invalid field name.*malicious.*not defined in schema/,
    }
  );
});

test('Security: reject unknown field names in updates', async () => {
  const TestModel = RevisionRecords as RevisionModel;

  const doc = await TestModel.createFirstRevision(testUser, {
    data: { title: 'Test Document' },
  });

  doc.setValue('nonexistent_field' as keyof typeof doc, 'value');

  await assert.rejects(
    async () => {
      await doc.save();
    },
    {
      message: /Invalid field name.*nonexistent_field.*not defined in schema/,
    }
  );
});
