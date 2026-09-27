import assert from 'node:assert/strict';
import type { ModelSchemaField } from '../../src/lib/model.js';
import type { DataAccessLayer, JsonObject, ModelConstructor } from '../../src/lib/model-types.js';
import revision from '../../src/lib/revision.js';
import types from '../../src/lib/type.js';

export type RevisionUser = { id: string } & Record<string, unknown>;

/**
 * Nested JSONB shape of the shared `revisions.metadata` column. Together with
 * `labels`, `keywords` and `publishedOn` it gives revision tests the value
 * kinds real models edit in place: multilingual strings, nested objects,
 * arrays and Dates.
 */
export type RevisionMetadataField = {
  description: Record<string, string>;
  sources: string[];
};

export type RevisionInstance = {
  id: string;
  title?: string;
  content?: string;
  labels?: Record<string, string> | null;
  metadata?: RevisionMetadataField | null;
  keywords?: string[] | null;
  publishedOn?: Date | null;
  save(options?: Record<string, unknown>): Promise<RevisionInstance>;
  saveAll(
    joinOptions?: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<RevisionInstance>;
  newRevision(user: RevisionUser, options?: Record<string, unknown>): Promise<RevisionInstance>;
  deleteAllRevisions(
    user: RevisionUser,
    options?: Record<string, unknown>
  ): Promise<RevisionInstance>;
  _data: {
    _rev_id: string;
    _rev_user: string;
    _rev_date: Date;
    _rev_tags: string[];
    _old_rev_of: string | null;
    _rev_deleted: boolean;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type RevisionModel = ModelConstructor<JsonObject, JsonObject, RevisionInstance> & {
  createFirstRevision(
    user: RevisionUser,
    options?: Record<string, unknown>
  ): Promise<RevisionInstance>;
  filterWhere(filter: Record<string, unknown>): { run(): Promise<RevisionInstance[]> };
  getNotStaleOrDeleted(id: string): Promise<RevisionInstance>;
};

export type ModelDefinition = {
  name: string;
  hasRevisions: boolean;
  schema: Record<string, ModelSchemaField>;
  camelToSnake?: Record<string, string>;
  options?: Record<string, unknown>;
};

export type TableDefinition = {
  name: string;
  create: (tableName: string, schemaName: string) => string;
  indexes?: Array<(tableName: string, schemaName: string) => string>;
};

export function getTestModelDefinitions(): ModelDefinition[] {
  return [
    {
      name: 'revisions',
      hasRevisions: true,
      schema: {
        id: types.string().uuid(4),
        title: types.string().max(255),
        content: types.string(),
        labels: types.object(),
        metadata: types.object(),
        keywords: types.array(types.string()),
        publishedOn: types.date(),
        ...revision.getSchema(),
      },
      camelToSnake: { publishedOn: 'published_on' },
    },
    {
      name: 'users',
      hasRevisions: false,
      schema: {
        id: types.string().uuid(4),
        display_name: types.string().max(255).required(true),
        canonical_name: types.string().max(255).required(true),
        email: types.string().email().required(true),
      },
    },
  ];
}

export function getTestTableDefinitions(): TableDefinition[] {
  return [
    {
      name: 'revisions',
      create: (tableName: string) => `
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title VARCHAR(255),
          content TEXT,
          labels JSONB,
          metadata JSONB,
          keywords TEXT[] DEFAULT '{}',
          published_on TIMESTAMPTZ,
          _rev_user UUID NOT NULL,
          _rev_date TIMESTAMP NOT NULL,
          _rev_id UUID NOT NULL,
          _old_rev_of UUID,
          _rev_deleted BOOLEAN DEFAULT FALSE,
          _rev_tags TEXT[] DEFAULT '{}'
        )
      `,
      indexes: [
        (tableName: string) => `
          CREATE INDEX IF NOT EXISTS idx_revisions_current
          ON ${tableName} (_old_rev_of, _rev_deleted)
          WHERE _old_rev_of IS NULL AND _rev_deleted = false
        `,
        (tableName: string) => `
          CREATE INDEX IF NOT EXISTS idx_revisions_old_rev_of
          ON ${tableName} (_old_rev_of)
          WHERE _old_rev_of IS NOT NULL
        `,
      ],
    },
    {
      name: 'users',
      create: (tableName: string) => `
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          display_name VARCHAR(255) NOT NULL,
          canonical_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE
        )
      `,
      indexes: [
        (tableName: string) => `
          CREATE INDEX IF NOT EXISTS idx_users_canonical_name
          ON ${tableName} (canonical_name)
        `,
        (tableName: string) => `
          CREATE INDEX IF NOT EXISTS idx_users_email
          ON ${tableName} (email)
        `,
      ],
    },
  ];
}

export function getTestUserData(suffix = '') {
  return {
    id: `550e8400-e29b-41d4-a716-44665544000${suffix || '0'}`,
    display_name: `Test User${suffix ? ' ' + suffix : ''}`,
    canonical_name: `testuser${suffix || ''}`,
    email: `test${suffix || ''}@example.com`,
  };
}

/** Date stored in `publishedOn` by {@link createTestDocumentWithRevisions}. */
export const TEST_PUBLISHED_ON = new Date('2020-01-02T03:04:05.000Z');

/**
 * Create a document and edit it `revisionCount - 1` times.
 *
 * Edits mix whole-value assignment with the in-place edits real models use
 * (`labels[lang] = …`, nested objects, `push`, Date setters), and every
 * revision is checked with {@link assertArchivedRevisionMatches}, so any test
 * built on this helper also guards revision history.
 */
export async function createTestDocumentWithRevisions(
  model: RevisionModel,
  user: RevisionUser,
  revisionCount = 3,
  titlePrefix = ''
) {
  let currentRev = await model.createFirstRevision(user, { tags: ['create', 'test'] });
  currentRev.title = `${titlePrefix}Original Title`;
  currentRev.content = 'Original content';
  currentRev.labels = { en: 'Original label', de: 'Originale Bezeichnung' };
  currentRev.metadata = { description: { en: 'Original description' }, sources: ['source-0'] };
  currentRev.keywords = ['original'];
  currentRev.publishedOn = new Date(TEST_PUBLISHED_ON);
  await currentRev.save();

  for (let i = 1; i < revisionCount; i++) {
    const before = await readStoredRow(model.dal, model.tableName, currentRev.id);
    const newRev = await currentRev.newRevision(user, {
      tags: ['edit', `revision-${i}`],
    });
    newRev.title = `${titlePrefix}Updated Title ${i}`;
    newRev.content = `Updated content ${i}`;
    (newRev.labels as Record<string, string>).en = `Updated label ${i}`;
    (newRev.metadata as RevisionMetadataField).description.en = `Updated description ${i}`;
    (newRev.metadata as RevisionMetadataField).sources.push(`source-${i}`);
    (newRev.keywords as string[]).push(`update-${i}`);
    (newRev.publishedOn as Date).setUTCDate((newRev.publishedOn as Date).getUTCDate() + 1);
    await newRev.save();
    await assertArchivedRevisionMatches(model.dal, model.tableName, before);
    currentRev = newRev;
  }

  return currentRev;
}

/**
 * Read a row straight from the table, bypassing models, so assertions don't
 * depend on the code under test.
 */
export async function readStoredRow(dal: DataAccessLayer, tableName: string, id: string) {
  const result = await dal.query(`SELECT * FROM ${tableName} WHERE id = $1`, [id]);
  assert.strictEqual(result.rows.length, 1, `expected one stored row for ${id}`);
  return result.rows[0] as JsonObject;
}

/**
 * Assert the history invariant: the archived copy of a revision equals the
 * stored row as it was before the edit, in every column except `id` (archived
 * rows get their own) and `_old_rev_of` (which points at the document).
 *
 * @param before Stored row captured with {@link readStoredRow} before editing
 * @param options.ignore Additional columns expected to differ (e.g.
 *   `_rev_deleted`, which deleteAllRevisions() sets on every archived row)
 * @returns The archived row
 */
export async function assertArchivedRevisionMatches(
  dal: DataAccessLayer,
  tableName: string,
  before: JsonObject,
  { ignore = [] }: { ignore?: string[] } = {}
) {
  const result = await dal.query(
    `SELECT * FROM ${tableName} WHERE _old_rev_of = $1 AND _rev_id = $2`,
    [before.id, before._rev_id]
  );
  assert.strictEqual(
    result.rows.length,
    1,
    `expected one archived row for revision ${String(before._rev_id)}`
  );
  const archived = result.rows[0] as JsonObject;

  const skipped = new Set(['id', '_old_rev_of', ...ignore]);
  const pick = (row: JsonObject) =>
    Object.fromEntries(Object.entries(row).filter(([column]) => !skipped.has(column)));
  assert.deepStrictEqual(
    pick(archived),
    pick(before),
    `archived revision ${String(before._rev_id)} must equal the stored row before the edit`
  );
  assert.strictEqual(archived._old_rev_of, before.id);
  return archived;
}

export async function countAllRevisions(
  dal: DataAccessLayer,
  tableName: string,
  documentId: string
) {
  const result = await dal.query(
    `SELECT COUNT(*) as count FROM ${tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [documentId]
  );
  return parseInt(result.rows[0].count as string, 10);
}

export async function countCurrentRevisions(dal: DataAccessLayer, tableName: string) {
  const result = await dal.query(
    `SELECT COUNT(*) as count FROM ${tableName}
     WHERE _old_rev_of IS NULL AND _rev_deleted = false`
  );
  return parseInt(result.rows[0].count as string, 10);
}

export async function verifyTestIsolation(
  dal: DataAccessLayer,
  tableName: string,
  expectedCount = 0
) {
  const result = await dal.query(`SELECT COUNT(*) as count FROM ${tableName}`);
  const actualCount = parseInt(result.rows[0].count as string, 10);
  return { actualCount, expectedCount };
}
