import { referenceModel } from '../../src/lib/model-handle.js';
import type { InferInstance, ModelManifest } from '../../src/lib/model-manifest.js';
import types from '../../src/lib/type.js';
import type { Equal, Expect } from './type-helpers.js';

const manifest = {
  tableName: 'upsert_types',
  hasRevisions: false,
  schema: {
    id: types.string(),
    userKey: types.string().required(),
    status: types.boolean(),
    computed: { isVirtual: true, validate: (_value: unknown) => 0 },
  },
} as const satisfies ModelManifest;
const Model = referenceModel(manifest);
const result = Model.upsert(
  { userKey: 'a', status: true },
  { conflictFields: ['userKey'], updateFields: ['status'] }
);
type _result = Expect<Equal<Awaited<typeof result>, InferInstance<typeof manifest>>>;
// @ts-expect-error Unknown conflict fields are rejected
Model.upsert({}, { conflictFields: ['missing'], updateFields: ['status'] });
// @ts-expect-error Virtual fields cannot be updated
Model.upsert({}, { conflictFields: ['id'], updateFields: ['computed'] });
// @ts-expect-error Values follow the manifest schema
Model.upsert({ status: 'yes' }, { conflictFields: ['id'], updateFields: ['status'] });
