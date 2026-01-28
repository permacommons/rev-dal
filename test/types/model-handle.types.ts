import { referenceModel } from '../../src/lib/model-handle.js';
import type {
  InferConstructor,
  InferInstance,
  ModelManifest,
} from '../../src/lib/model-manifest.js';
import types from '../../src/lib/type.js';
import type { Equal, Expect, IsAssignable, Not } from './type-helpers.js';

const exampleSchema = {
  id: types.string().required(),
  label: types.string(),
  relatedId: types.string(),
  computed: types.virtual().returns<number>(),
} as const;

const exampleManifest = {
  tableName: 'example_table',
  hasRevisions: false as const,
  schema: exampleSchema,
  relations: [
    {
      name: 'related',
      targetTable: 'related_items',
      sourceKey: 'relatedId',
      targetKey: 'id',
      cardinality: 'one',
    },
  ],
} as const satisfies ModelManifest;

type ExampleInstanceBase = InferInstance<typeof exampleManifest>;

interface ExampleStaticMethods {
  findByLabel(label: string): Promise<string | null>;
}

interface ExampleInstanceMethods {
  getLabel(this: ExampleInstanceBase & ExampleInstanceMethods): string | null;
}

interface RelatedInstance {
  id: string;
  name: string;
}

type ExampleInstance = ExampleInstanceBase &
  ExampleInstanceMethods & {
    related?: RelatedInstance;
  };

type _staticReturn = Expect<
  Equal<ReturnType<ExampleStaticMethods['findByLabel']>, Promise<string | null>>
>;

type _instanceReturn = Expect<Equal<ReturnType<ExampleInstanceMethods['getLabel']>, string | null>>;

type _relatedType = Expect<Equal<ExampleInstance['related'], RelatedInstance | undefined>>;

type _idType = Expect<Equal<ExampleInstance['id'], string>>;

type _labelType = Expect<Equal<ExampleInstance['label'], string | null | undefined>>;

type ExampleConstructor = InferConstructor<typeof exampleManifest>;

const exampleHandle = referenceModel(exampleManifest);

type _handleIsConstructor = Expect<IsAssignable<typeof exampleHandle, ExampleConstructor>>;

type _handleCreateFromRow = Expect<
  Equal<ReturnType<typeof exampleHandle.createFromRow>, ExampleInstanceBase>
>;

type ExampleGetResult = Awaited<ReturnType<typeof exampleHandle.get>>;

type _handleGet = Expect<Equal<ExampleGetResult, ExampleInstanceBase | null>>;

const handleWithMethods = referenceModel(exampleManifest, {
  parseNumber(value: string) {
    return Number(value);
  },
});

type _handleMethodReturn = Expect<Equal<ReturnType<typeof handleWithMethods.parseNumber>, number>>;

const handleWithProperties = referenceModel(
  exampleManifest,
  {},
  {
    category: 'demo' as const,
  }
);

type _handlePropertyPresence = Expect<
  IsAssignable<typeof handleWithProperties, { category: unknown }>
>;

type _handlePropertyType = Expect<Not<Equal<typeof handleWithProperties.category, never>>>;

type _handlePropertyLiteral = Expect<Equal<typeof handleWithProperties.category, 'demo'>>;

const handleWithAll = referenceModel(
  exampleManifest,
  {
    isPositive(value: number) {
      return value > 0;
    },
  },
  {
    description: 'typed handle' as const,
  }
);

type _handleAllMethod = Expect<Equal<ReturnType<typeof handleWithAll.isPositive>, boolean>>;

type _handleAllProperty = Expect<Equal<typeof handleWithAll.description, 'typed handle'>>;
