import type { Pool, PoolClient } from 'pg';
import type { DataAccessLayer } from './model-types.js';

export type QueryExecutor = Pool | PoolClient;

/**
 * Run `callback` inside a transaction.
 *
 * When the caller already supplies a client (their own transaction), the work
 * joins it and the caller stays responsible for COMMIT/ROLLBACK. Otherwise a
 * new transaction is opened on the DAL and committed or rolled back here.
 *
 * @param dal DAL used to open a transaction when none is supplied
 * @param executor Caller-supplied client, if any
 * @param callback Work to run with the transaction client
 */
export async function runInTransaction<T>(
  dal: DataAccessLayer,
  executor: QueryExecutor | null | undefined,
  callback: (client: QueryExecutor) => Promise<T>
): Promise<T> {
  if (executor) {
    return callback(executor);
  }

  if (typeof dal.transaction !== 'function') {
    throw new Error('This DAL does not support transactions.');
  }

  return dal.transaction(client => callback(client));
}
