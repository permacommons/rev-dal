import type { ModelSchemaField } from '../../src/lib/model.js';
import type { DataAccessLayer, JsonObject, ModelConstructor } from '../../src/lib/model-types.js';
import revision from '../../src/lib/revision.js';
import types from '../../src/lib/type.js';

export type RevisionUser = { id: string } & Record<string, unknown>;

export type RevisionInstance = {
  id: string;
  title?: string;
  content?: string;
  save(): Promise<RevisionInstance>;
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
        ...revision.getSchema(),
      },
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

export async function createTestDocumentWithRevisions(
  model: RevisionModel,
  user: RevisionUser,
  revisionCount = 3,
  titlePrefix = ''
) {
  let currentRev = await model.createFirstRevision(user, { tags: ['create', 'test'] });
  currentRev.title = `${titlePrefix}Original Title`;
  currentRev.content = 'Original content';
  await currentRev.save();

  for (let i = 1; i < revisionCount; i++) {
    const newRev = await currentRev.newRevision(user, {
      tags: ['edit', `revision-${i}`],
    });
    newRev.title = `${titlePrefix}Updated Title ${i}`;
    newRev.content = `Updated content ${i}`;
    await newRev.save();
    currentRev = newRev;
  }

  return currentRev;
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
