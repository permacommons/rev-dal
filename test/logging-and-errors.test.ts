import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { DALError, RevisionDeletedError, RevisionStaleError } from '../src/lib/errors.js';
import revision from '../src/lib/revision.js';
import { setDebugLogger } from '../src/lib/runtime.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';
import {
  createTestDocumentWithRevisions,
  getTestModelDefinitions,
  getTestTableDefinitions,
  getTestUserData,
  type RevisionModel,
} from './helpers/revision-helpers.js';

/**
 * Regression tests for:
 * - failed queries never log or attach parameter values
 * - revision deleted/stale errors are real DALError subclasses thrown fresh
 */

let fixture: PostgresFixture;
let Revisions: RevisionModel;
const testUser = getTestUserData();

const silentLogger = { db: () => undefined, error: () => undefined };

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_logging',
    tableDefs: getTestTableDefinitions(),
    modelDefs: getTestModelDefinitions(),
  });
  Revisions = fixture.models.revisions as RevisionModel;
});

beforeEach(async () => {
  await fixture.cleanupTables(['revisions', 'users']);
});

after(async () => {
  setDebugLogger(silentLogger);
  if (fixture) {
    await fixture.cleanup();
  }
});

test('failed queries log parameter types but never parameter values', async () => {
  const logged: string[] = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  setDebugLogger({ db: capture, error: capture });

  const secret = 'hunter2-secret-token';
  let thrown: unknown;
  try {
    await fixture.dal.query('SELECT $1::text, $2::int, $3::text FROM no_such_table', [
      secret,
      42,
      null,
    ]);
  } catch (error) {
    thrown = error;
  } finally {
    setDebugLogger(silentLogger);
  }

  assert.ok(thrown instanceof Error, 'query failed');
  const output = logged.join('\n');
  assert.ok(!output.includes(secret), 'secret value must not be logged');
  assert.match(output, /Query params: 3 \(string, number, null\)/);
  assert.match(output, /Query text: SELECT \$1::text/);

  // The thrown error carries the SQL text for debugging, but not the values
  const errorRecord = thrown as unknown as Record<string, unknown>;
  assert.strictEqual(errorRecord.parameters, undefined);
  assert.match(String(errorRecord.query), /no_such_table/);
  assert.ok(!JSON.stringify(errorRecord).includes(secret));
});

test('getNotStaleOrDeleted throws RevisionDeletedError for a deleted document', async () => {
  const doc = await createTestDocumentWithRevisions(Revisions, testUser, 1);
  await doc.deleteAllRevisions(testUser);

  const errors: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      () => Revisions.getNotStaleOrDeleted(doc.id),
      (error: unknown) => {
        errors.push(error);
        return true;
      }
    );
  }

  const [first, second] = errors;
  assert.ok(first instanceof RevisionDeletedError);
  assert.ok(first instanceof DALError);
  assert.strictEqual(first.name, 'RevisionDeletedError');
  assert.strictEqual(first.message, 'Revision has been deleted.');
  assert.strictEqual(first.code, 'REVISION_DELETED');
  assert.notStrictEqual(first, second, 'each failure throws a fresh error');
});

test('getNotStaleOrDeleted throws RevisionStaleError for an archived revision', async () => {
  const doc = await createTestDocumentWithRevisions(Revisions, testUser, 2);
  const archived = await fixture.dal.query(
    `SELECT id FROM ${fixture.getTableName('revisions')} WHERE _old_rev_of = $1 LIMIT 1`,
    [doc.id]
  );
  const archivedId = String(archived.rows[0].id);

  await assert.rejects(
    () => Revisions.getNotStaleOrDeleted(archivedId),
    (error: unknown) => {
      assert.ok(error instanceof RevisionStaleError);
      assert.ok(error instanceof DALError);
      assert.strictEqual(error.name, 'RevisionStaleError');
      assert.strictEqual(error.message, 'Outdated revision.');
      assert.strictEqual(error.code, 'REVISION_STALE');
      return true;
    }
  );
});

test('deprecated revision.deletedError/staleError return fresh typed errors', () => {
  assert.ok(revision.deletedError instanceof RevisionDeletedError);
  assert.ok(revision.staleError instanceof RevisionStaleError);
  assert.notStrictEqual(revision.deletedError, revision.deletedError);
  assert.strictEqual(revision.staleError.name, 'RevisionStaleError');
});
