import { referenceModel } from '../../src/lib/model-handle.js';
import type { ModelManifest } from '../../src/lib/model-manifest.js';
import types from '../../src/lib/type.js';
import type { Equal, Expect } from './type-helpers.js';

const manifest = {
  tableName: 'pages',
  hasRevisions: true,
  schema: {
    id: types.string().required(),
    body: types.string(),
    bodyEditCounts: types.object(),
    computed: { isVirtual: true, validate: () => 0 },
  },
} as const satisfies ModelManifest;
const Page = referenceModel(manifest);
const query = Page.filterWhere({}).select('id', '_revID');
type Row = Awaited<typeof query>[number];
type _keys = Expect<Equal<keyof Row, 'id' | '_revID'>>;
type _revision = Expect<Equal<Row['_revID'], string | undefined>>;
declare const row: Row;
// @ts-expect-error Unselected fields are unavailable
row.body;
// @ts-expect-error Projected rows cannot be saved
row.save();
// @ts-expect-error Projected properties are read-only
row.id = 'changed';
// @ts-expect-error Unknown fields are rejected
Page.filterWhere({}).select('unknown');
// @ts-expect-error Virtual fields are rejected
Page.filterWhere({}).select('computed');
// @ts-expect-error At least one field is required
Page.filterWhere({}).select();
// @ts-expect-error Projection is terminal
query.getJoin(true);
const Plain = referenceModel({ ...manifest, hasRevisions: false } as const);
// @ts-expect-error Revision metadata is only available on revisioned models
Plain.filterWhere({}).select('_revID');
