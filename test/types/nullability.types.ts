import type { Pool } from 'pg';
import { referenceModel } from '../../src/lib/model-handle.js';
import type { InferData, ModelManifest } from '../../src/lib/model-manifest.js';
import type { DataAccessLayer } from '../../src/lib/model-types.js';
import types from '../../src/lib/type.js';
import type { Equal, Expect } from './type-helpers.js';

const manifest = {
  tableName: 'nullability_examples',
  hasRevisions: false,
  schema: {
    id: types.string().required(),
    label: types.string(),
    createdAt: types.date().required(),
  },
} as const satisfies ModelManifest;

type Data = InferData<typeof manifest.schema>;
type _required = Expect<Equal<Data['id'], string>>;
type _optional = Expect<Equal<Data['label'], string | null | undefined>>;
type _pool = Expect<Equal<DataAccessLayer['pool'], Pool | null | undefined>>;

const valid: Data = { id: 'example', label: null, createdAt: new Date() };
valid.label = undefined;
// @ts-expect-error Required strings reject null.
valid.id = null;
// @ts-expect-error Required dates reject undefined.
valid.createdAt = undefined;

const model = referenceModel(manifest);
type Instance = Awaited<ReturnType<typeof model.get>>;
type _first = Expect<
  Equal<Awaited<ReturnType<ReturnType<typeof model.filterWhere>['first']>>, Instance | null>
>;
// @ts-expect-error get() throws for missing records rather than returning null.
const _missing: Instance = null;
