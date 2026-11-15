import type { Pool, PoolClient } from 'pg';
import type {
  RevisionMetadata,
  SaveOptions,
  TransactionOptions,
} from '../../src/lib/model-types.js';
import type { QueryExecutor } from '../../src/lib/transaction.js';
import type { Expect, IsAssignable, Not } from './type-helpers.js';

type _clientAccepted = Expect<IsAssignable<PoolClient, TransactionOptions['transaction']>>;
type _poolRejected = Expect<Not<IsAssignable<Pool, TransactionOptions['transaction']>>>;
type _savePoolRejected = Expect<Not<IsAssignable<Pool, SaveOptions['transaction']>>>;
type _revisionPoolRejected = Expect<Not<IsAssignable<Pool, RevisionMetadata['transaction']>>>;
type _executorPoolRejected = Expect<Not<IsAssignable<Pool, QueryExecutor>>>;
