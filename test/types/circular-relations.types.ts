import { referenceModel } from '../../src/lib/model-handle.js';
import type { InferInstance, ModelManifest } from '../../src/lib/model-manifest.js';
import types from '../../src/lib/type.js';
import type { Equal, Expect, IsAssignable } from './type-helpers.js';

const thingManifest = {
  tableName: 'things',
  hasRevisions: true as const,
  schema: {
    id: types.string().required(),
    name: types.string().required(),
  },
  relations: [
    {
      name: 'reviews',
      target: referenceReview,
      sourceKey: 'id',
      targetKey: 'thing_id',
      cardinality: 'many' as const,
    },
  ],
} as const satisfies ModelManifest;

type ThingInstanceBase = InferInstance<typeof thingManifest>;

export type ThingInstance = ThingInstanceBase & {
  reviews: ReviewInstance[];
};

export function referenceThing() {
  return referenceModel(thingManifest);
}

const reviewManifest = {
  tableName: 'reviews',
  hasRevisions: true as const,
  schema: {
    id: types.string().required(),
    thing_id: types.string().required(),
  },
  relations: [
    {
      name: 'thing',
      target: referenceThing,
      sourceKey: 'thing_id',
      cardinality: 'one' as const,
    },
  ],
} as const satisfies ModelManifest;

type ReviewInstanceBase = InferInstance<typeof reviewManifest>;

export type ReviewInstance = ReviewInstanceBase & {
  thing: ThingInstance | undefined;
};

export function referenceReview() {
  return referenceModel(reviewManifest);
}

type _thingReviews = Expect<Equal<ThingInstance['reviews'], ReviewInstance[]>>;

type _reviewThing = Expect<Equal<ReviewInstance['thing'], ThingInstance | undefined>>;

export type _ThingHasId = Expect<Equal<IsAssignable<string, ThingInstance['id']>, true>>;

export type _ReviewHasId = Expect<Equal<IsAssignable<string, ReviewInstance['id']>, true>>;

export type _ReviewHasThingId = Expect<
  Equal<IsAssignable<string, ReviewInstance['thing_id']>, true>
>;
