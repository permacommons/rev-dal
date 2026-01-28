import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import DataAccessLayer from '../src/lib/data-access-layer.js';
import { resolveTestConfig } from './helpers/postgres-fixture.js';

test('rollback reverts last migration using down script', async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const schemaName = `rev_dal_migrations_${suffix}`;
  const migrationsRoot = path.join(process.cwd(), 'test/fixtures/sql');
  const migrationName = '000-init.sql';

  const baseConfig = resolveTestConfig();
  const bootstrapDal = new DataAccessLayer(baseConfig);
  await bootstrapDal.connect();
  await bootstrapDal.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await bootstrapDal.disconnect();

  const dal = new DataAccessLayer({
    ...baseConfig,
    options: `-c search_path=${schemaName}`,
  });
  await dal.connect();

  try {
    await dal.migrate(migrationsRoot);

    const migrationsBefore = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations ORDER BY executed_at DESC, id DESC'
    );
    assert.ok(migrationsBefore.rowCount && migrationsBefore.rowCount >= 1);
    const latestMigration = migrationsBefore.rows[0].filename;
    assert.strictEqual(latestMigration, migrationName);

    const tableExists = await dal.query<{ reg: string | null }>('SELECT to_regclass($1) as reg', [
      `${schemaName}.revisions`,
    ]);
    assert.ok(tableExists.rows[0].reg);

    await dal.rollback(migrationsRoot);

    const rolledBack = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations WHERE filename = $1',
      [migrationName]
    );
    assert.strictEqual(rolledBack.rowCount, 0);

    const tableAfter = await dal.query<{ reg: string | null }>('SELECT to_regclass($1) as reg', [
      `${schemaName}.revisions`,
    ]);
    assert.strictEqual(tableAfter.rows[0].reg, null);
  } finally {
    await dal.disconnect();
    const cleanupDal = new DataAccessLayer(baseConfig);
    await cleanupDal.connect();
    await cleanupDal.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await cleanupDal.disconnect();
  }
});
