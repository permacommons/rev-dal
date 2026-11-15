import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PoolClient, PoolConfig, QueryResult } from 'pg';
import { Pool } from 'pg';
import mlString from './ml-string.js';
import type { ModelSchema } from './model.js';
import Model from './model.js';
import { getModelHandleTableName } from './model-handle.js';
import type { InferConstructor, ModelManifest } from './model-manifest.js';
import ModelRegistry, { getRegisteredModelKey } from './model-registry.js';
import type {
  DataAccessLayer as DataAccessLayerContract,
  JsonObject,
  ModelConstructor,
} from './model-types.js';
import type { PostgresConfig } from './postgres-config.js';
import revision from './revision.js';
import { debug } from './runtime.js';
import types from './type.js';

type PoolLike = Pool | PoolClient;

/**
 * Turn a `getModel()` argument into a registry lookup key. Handles are
 * checked first so their proxies' resolver-backed traps are never triggered.
 */
function resolveModelLookupName(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const handleTableName = getModelHandleTableName(value);
  if (handleTableName !== undefined) {
    return handleTableName;
  }

  const registryKey = getRegisteredModelKey(value);
  if (registryKey !== undefined) {
    return registryKey;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const { tableName } = value as { tableName?: unknown };
    if (typeof tableName === 'string' && tableName.length > 0) {
      return tableName;
    }
  }

  throw new TypeError(
    'getModel() expects a model name, a defineModel()/referenceModel() handle, a registered model constructor, or a model manifest with a non-empty tableName.'
  );
}

type DataAccessLayerConfig = (PoolConfig & JsonObject) & Partial<PostgresConfig>;

/**
 * Summarize query parameters for logs without revealing their values, which
 * can include password hashes, tokens and personal data.
 *
 * @param params Query parameters
 * @returns e.g. `3 (string, number, null)`
 */
function describeQueryParams(params: unknown[]): string {
  if (params.length === 0) {
    return '0';
  }

  const kinds = params.map(param => {
    if (param === null) return 'null';
    if (Array.isArray(param)) return 'array';
    if (param instanceof Date) return 'date';
    return typeof param;
  });
  return `${params.length} (${kinds.join(', ')})`;
}

interface MigrationRow extends JsonObject {
  filename: string;
}

/**
 * Main Data Access Layer class for PostgreSQL
 *
 * Provides connection management, transaction support, and model creation
 * functionality. This class serves as the main interface between the
 * application and the PostgreSQL database.
 */
class DataAccessLayer implements DataAccessLayerContract {
  config: DataAccessLayerConfig;
  pool: Pool | null;
  modelRegistry: ModelRegistry;
  schemaNamespace?: string;
  private _connected: boolean;
  private _connecting: Promise<void> | null = null;

  // Helper namespaces exposed for model manifests
  mlString = mlString;
  revision = revision;
  types = types;

  constructor(config: Partial<PostgresConfig> & JsonObject = {}) {
    const defaultConfig: PoolConfig = {
      host: 'localhost',
      port: 5432,
      database: 'libreviews',
      user: 'postgres',
      password: '',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };

    this.config = {
      ...defaultConfig,
      ...config,
    } as DataAccessLayerConfig;

    this.pool = null;
    this._connected = false;
    this.modelRegistry = new ModelRegistry(this);
  }

  /**
   * Initialize the connection pool and connect to PostgreSQL
   * @returns This instance for chaining
   */
  async connect(): Promise<this> {
    if (this._connected) {
      return this;
    }

    // Concurrent callers share one connection attempt (and one pool)
    if (!this._connecting) {
      this._connecting = this._openPool().finally(() => {
        this._connecting = null;
      });
    }
    await this._connecting;
    return this;
  }

  /**
   * Create the pool, expose it on `this.pool` right away, and verify it.
   * @private
   */
  private async _openPool(): Promise<void> {
    // Expose the pool before the first await: callers may read `pool` while
    // connect() is still in flight (pg pools connect lazily), as they could
    // before the connection test was added. `isConnected()` only turns true
    // once the test succeeds.
    const pool = new Pool(this.config as PoolConfig);
    this.pool = pool;

    // Attach handlers before any client exists: an 'error' event without a
    // listener would crash the process.
    pool.on('connect', () => {
      debug.db('New PostgreSQL client connected');
    });
    pool.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      debug.error(`PostgreSQL pool error: ${message}`);
      debug.error({ error: err instanceof Error ? err : new Error(message) });
    });

    try {
      // Test the connection; always hand the client back, discarding it on error
      const client = await pool.connect();
      try {
        await client.query('SELECT NOW()');
      } catch (queryError) {
        client.release(queryError instanceof Error ? queryError : true);
        throw queryError;
      }
      client.release();

      this._connected = true;
      debug.db('PostgreSQL connection pool established');
    } catch (error) {
      // Don't leave a half-initialized pool behind
      if (this.pool === pool) {
        this.pool = null;
      }
      await pool.end().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Failed to connect to PostgreSQL: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  }

  /**
   * Close all connections and clean up
   */
  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this._connected = false;
      this.modelRegistry.clear();
      debug.db('PostgreSQL connection pool closed');
    }
  }

  /**
   * Get a connection from the pool
   * @returns PostgreSQL client connection
   */
  async getConnection(): Promise<PoolClient> {
    if (!this._connected || !this.pool) {
      throw new Error('DAL not connected. Call connect() first.');
    }
    return this.pool.connect();
  }

  /**
   * Execute a query with optional parameters
   * @param text - SQL query text
   * @param params - Query parameters
   * @param client - Optional client connection (for transactions)
   * @returns Query result
   */
  async query<TRecord extends JsonObject = JsonObject>(
    text: string,
    params: unknown[] = [],
    client: PoolLike | null = null
  ): Promise<QueryResult<TRecord>> {
    const queryClient: PoolLike | null = client ?? this.pool;
    if (!queryClient) {
      throw new Error('DAL not connected. Call connect() first.');
    }

    try {
      const start = Date.now();
      const result = await queryClient.query<TRecord>(text, params);
      const duration = Date.now() - start;

      debug.db(`Query executed in ${duration}ms: ${text.substring(0, 100)}...`);
      return result;
    } catch (error) {
      // Attach the SQL text (values are bound separately) but never the
      // parameter values, since errors are often logged or reported upstream
      if (typeof error === 'object' && error) {
        (error as JsonObject).query = text;
      }
      debug.error(`Query error: ${(error as Error).message}`);
      debug.error(`Query text: ${text}`);
      debug.error(`Query params: ${describeQueryParams(params)}`);
      throw error;
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   * @param callback - Function to execute within transaction
   * @returns Result of the callback function
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getConnection();
    // Set when the client can no longer be trusted, so the pool discards it
    let releaseError: Error | undefined;

    try {
      await client.query('BEGIN');
      debug.db('Transaction started');

      const result = await callback(client);

      await client.query('COMMIT');
      debug.db('Transaction committed');

      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Report the original failure, not the rollback's
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        debug.error(`Transaction rollback failed: ${releaseError.message}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      debug.db(`Transaction rolled back due to error: ${message}`);
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  /**
   * Create a new model class
   * @param name - Model name (table name)
   * @param schema - Model schema definition
   * @param options - Model options
   * @returns Model constructor
   */
  createModel<TData extends JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string,
    schema: ModelSchema<TData, TVirtual>,
    options: JsonObject = {}
  ): ModelConstructor<TData, TVirtual> {
    const { registryKey, ...modelOptions } = options || {};
    const canonicalKey = typeof registryKey === 'string' ? registryKey : name;

    const existing =
      this.modelRegistry.get<TData, TVirtual>(name) ||
      (canonicalKey !== name ? this.modelRegistry.get<TData, TVirtual>(canonicalKey) : null);

    if (existing) {
      throw new Error(`Model '${canonicalKey}' already exists`);
    }

    const ModelClass = Model.createModel<TData, TVirtual>(name, schema, modelOptions, this);
    this.modelRegistry.register(name, ModelClass, { key: canonicalKey });

    debug.db(`Model '${name}' created`);
    return ModelClass;
  }

  /**
   * Get a model registered on this DAL instance.
   *
   * Pass a table name or registry key for an untyped lookup. Pass a
   * `defineModel()`/`referenceModel()` handle, or a constructor registered on
   * another DAL, to get this DAL's constructor for the same model typed like
   * the argument. Pass a model manifest to get it typed from the manifest.
   *
   * Handle types include `statics` passed to `defineModel()` and fallback
   * methods passed to `referenceModel()`; those exist only on the handle, not
   * on the returned constructor.
   *
   * Every form reads only this instance's registry: it never consults the
   * bootstrap resolver, queries the database or registers models. Handles and
   * manifests resolve by their manifest `tableName`; constructors by the
   * registry key they were registered under.
   *
   * The non-string forms are typing hints; they do not check that the
   * argument matches the registered model's schema.
   *
   * @param nameOrModel - Table name, registry key, model handle, constructor or manifest
   * @returns The constructor registered on this DAL
   * @throws Error when no model is registered under that name
   * @throws TypeError when the argument is not a name, handle, registered constructor or manifest
   */
  getModel<TData extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string
  ): ModelConstructor<TData, TVirtual>;
  getModel<Model extends ModelConstructor>(model: Model): Model;
  getModel<Manifest extends ModelManifest>(manifest: Manifest): InferConstructor<Manifest>;
  getModel(nameOrModel: string | ModelConstructor | ModelManifest): unknown {
    const name = resolveModelLookupName(nameOrModel);
    const model = this.modelRegistry.get(name);
    if (!model) {
      throw new Error(`Model '${name}' not found`);
    }
    return model;
  }

  /**
   * Return a map of registered models keyed by canonical name
   */
  getRegisteredModels(): Map<string, ModelConstructor<JsonObject, JsonObject>> {
    return this.modelRegistry.listByKey();
  }

  /**
   * Expose the registry instance for advanced consumers
   */
  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  /**
   * Run database migrations
   * @param migrationsPath - Path to migration files
   */
  async migrate(migrationsPath = 'migrations'): Promise<void> {
    debug.db('Running database migrations...');

    try {
      // Create migrations table if it doesn't exist
      await this.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Get list of migration files
      const migrationFiles = await fs.readdir(migrationsPath);
      const sqlFiles = migrationFiles.filter(file => file.endsWith('.sql')).sort();

      // Get already executed migrations
      const executedResult = await this.query<MigrationRow>('SELECT filename FROM migrations');
      const executedMigrations = new Set(executedResult.rows.map(row => row.filename));

      // Execute pending migrations
      for (const filename of sqlFiles) {
        if (!executedMigrations.has(filename)) {
          debug.db(`Executing migration: ${filename}`);

          const migrationPath = path.join(migrationsPath, filename);
          const migrationSQL = await fs.readFile(migrationPath, 'utf8');

          await this.transaction(async client => {
            // Execute the migration
            await client.query(migrationSQL);

            // Record the migration as executed
            await client.query('INSERT INTO migrations (filename) VALUES ($1)', [filename]);
          });

          debug.db(`Migration completed: ${filename}`);
        }
      }

      debug.db('All migrations completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Migration failed: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  }

  /**
   * Rollback the last migration (if supported)
   */
  async rollback(migrationsPath = 'migrations'): Promise<void> {
    debug.db('Rolling back last migration...');

    const downDir = path.join(migrationsPath, 'down');

    try {
      const result = await this.query<MigrationRow>(
        'SELECT filename FROM migrations ORDER BY executed_at DESC, id DESC LIMIT 1'
      );
      const lastMigration = result.rows[0]?.filename;

      if (!lastMigration) {
        debug.db('No migrations to roll back');
        return;
      }

      const downPath = path.join(downDir, lastMigration);
      let downSQL: string;
      try {
        downSQL = await fs.readFile(downPath, 'utf8');
      } catch (_error) {
        const message = `Down migration not found for ${lastMigration} at ${downPath}`;
        debug.error(message);
        throw new Error(message);
      }

      await this.transaction(async client => {
        await client.query(downSQL);
        await client.query('DELETE FROM migrations WHERE filename = $1', [lastMigration]);
      });

      debug.db(`Rolled back migration: ${lastMigration}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Rollback failed: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  }

  /**
   * Check if the DAL is connected
   */
  isConnected(): boolean {
    return Boolean(this._connected && this.pool && !this.pool.ended);
  }

  /**
   * Get pool statistics
   */
  getPoolStats(): { totalCount: number; idleCount: number; waitingCount: number } | null {
    if (!this.pool) {
      return null;
    }

    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}

export { DataAccessLayer };
export default DataAccessLayer;
