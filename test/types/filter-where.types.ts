import { createOperators } from '../../src/lib/filter-where.js';
import type { FilterWhereLiteral } from '../../src/lib/model-types.js';
import type { Equal, Expect } from './type-helpers.js';

type ExampleRecord = {
  id: string;
  status: string;
  score: number;
  createdOn: Date;
  isActive: boolean | null;
  metadata: Record<string, unknown>;
  tags: string[];
};

const ops = createOperators<ExampleRecord>();

type Filter = FilterWhereLiteral<ExampleRecord, typeof ops>;

const _okFilter: Filter = {
  status: ops.in(['draft', 'published']),
  score: ops.between(0, 10),
  createdOn: ops.gte(new Date()),
  isActive: ops.not(),
  metadata: ops.jsonContains({ foo: 'bar' }),
  tags: ops.containsAny(['tag-a', 'tag-b']),
};

const _badComparable: Filter = {
  // @ts-expect-error metadata is not comparable
  metadata: ops.gt(3),
};

const _badJson: Filter = {
  // @ts-expect-error tags do not accept jsonContains
  tags: ops.jsonContains({ foo: 'bar' }),
};

const _badBetween: Filter = {
  // @ts-expect-error createdOn does not accept string values in between
  createdOn: ops.between('yesterday', new Date()),
};

type _FilterIsObject = Expect<Equal<Filter extends object ? true : false, true>>;
