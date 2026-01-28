import { randomUUID } from 'node:crypto';
import DataAccessLayer from '../../src/lib/data-access-layer.js';
import { createFilterWhereStatics } from '../../src/lib/filter-where.js';
import { initializeModel } from '../../src/lib/model-initializer.js';
import type { ModelManifest } from '../../src/lib/model-manifest.js';
import type { ModelConstructor } from '../../src/lib/model-types.js';
import type { PostgresConfig } from '../../src/lib/postgres-config.js';
import type { ModelDefinition, TableDefinition } from './revision-helpers.js';

export type PostgresFixture = {
  dal: DataAccessLayer;
  schemaName: string;
  schemaNamespace: string;
  models: Record<string, ModelConstructor>;
  getTableName: (name: string) => string;
  cleanupTables: (names: string[]) => Promise<void>;
  cleanup: () => Promise<void>;
};

export const resolveTestConfig = (): Partial<PostgresConfig> => {
  const connectionString =
    process.env.REV_DAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? undefined;

  if (connectionString) {
    return { connectionString };
  }

  const database = process.env.REV_DAL_TEST_DATABASE ?? process.env.PGDATABASE;

  if (!database) {
    throw new Error(
      'Set REV_DAL_TEST_DATABASE or REV_DAL_TEST_DATABASE_URL (or DATABASE_URL/PGDATABASE) before running rev-dal tests.'
    );
  }

  const portValue = process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : undefined;

  return {
    database,
    host: process.env.PGHOST ?? 'localhost',
    port: Number.isFinite(portValue) ? portValue : 5432,
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
  };
};

const normalizeIdentifier = (value: string) => value.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();

export async function createPostgresFixture(options: {
  schemaPrefix?: string;
  tableDefs: TableDefinition[];
  modelDefs: ModelDefinition[];
}): Promise<PostgresFixture> {
  const { schemaPrefix = 'rev_dal_test', tableDefs, modelDefs } = options;
  const config = resolveTestConfig();
  const dal = new DataAccessLayer(config);

  await dal.connect();

  const suffix = normalizeIdentifier(randomUUID().replace(/-/g, '')).slice(0, 12);
  const schemaName = `${normalizeIdentifier(schemaPrefix)}_${suffix}`;
  const schemaNamespace = `${schemaName}.`;

  await dal.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  await dal.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

  dal.schemaNamespace = schemaNamespace;

  for (const def of tableDefs) {
    const tableName = `${schemaName}.${def.name}`;
    await dal.query(def.create(tableName, schemaName));
    for (const createIndex of def.indexes ?? []) {
      await dal.query(createIndex(tableName, schemaName));
    }
  }

  const models: Record<string, ModelConstructor> = {};
  for (const def of modelDefs) {
    const { model } = initializeModel({
      dal,
      baseTable: def.name,
      schema: def.schema,
      camelToSnake: def.camelToSnake,
      withRevision: def.hasRevisions,
      ...def.options,
    });
    const manifest = {
      tableName: def.name,
      hasRevisions: def.hasRevisions,
      schema: def.schema,
    } as ModelManifest;
    Object.assign(model as Record<string, unknown>, createFilterWhereStatics(manifest));
    models[def.name] = model as ModelConstructor;
  }

  const cleanupTables = async (names: string[]) => {
    if (names.length === 0) return;
    const tableList = names.map(name => `${schemaName}.${name}`).join(', ');
    await dal.query(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`);
  };

  const cleanup = async () => {
    try {
      await dal.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } finally {
      await dal.disconnect();
    }
  };

  return {
    dal,
    schemaName,
    schemaNamespace,
    models,
    getTableName: (name: string) => `${schemaName}.${name}`,
    cleanupTables,
    cleanup,
  };
}
