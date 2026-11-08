import type { ModelRuntime } from './model.js';
import type {
  InferData,
  InferInstance,
  ManifestVirtualFields,
  ModelManifest,
} from './model-manifest.js';
import type {
  ChronologicalFeedOptions,
  ChronologicalFeedPage,
  DateKeys,
  DeleteOptions,
  FilterWhereJoinSpec,
  FilterWhereLiteral,
  FilterWhereOperators,
  FilterWhereQueryBuilder,
  JsonObject,
  ModelConstructor,
  ModelInstance,
  NumericKeys,
  RevisionDataRecord,
} from './model-types.js';
import QueryBuilder, { normalizeSortDirection } from './query-builder.js';

/**
 * Shared implementation for the typed {@link ModelConstructor.filterWhere} surface.
 *
 * Every manifest-driven model mixes in the helpers defined here so calling
 * `Model.filterWhere({ ... })` yields a typed builder with revision-aware
 * defaults and a small bag of operator helpers (`Model.ops`).
 *
 * ⚠️ Helpers must be invoked inline where the target field is known:
 * destructuring `const { neq } = Thing.ops` is fine, but avoid caching helper
 * *results* (for example `const isBlocked = neq(id)`). Once detached from the
 * literal, TypeScript can no longer narrow the operator to a specific field,
 * so it will compile even if you later attach it to the wrong column.
 */

const FILTER_OPERATOR_TOKEN = Symbol('lib.reviews.filterWhere.operator');

type Predicate = QueryBuilder['_where'][number];

type OperatorBuilderContext = {
  builder: QueryBuilder;
  field: string | number | symbol;
  mutate: boolean;
};

interface InternalFilterOperator<K extends PropertyKey, TValue> {
  readonly [FILTER_OPERATOR_TOKEN]: true;
  readonly __allowedKeys: K;
  readonly value: TValue;
  build(context: OperatorBuilderContext): Predicate | null;
}

type ExtractArray<T> = Extract<T, readonly unknown[] | unknown[]>;

type ArrayElement<T> =
  ExtractArray<T> extends readonly (infer U)[]
    ? U
    : ExtractArray<T> extends (infer U)[]
      ? U
      : never;

type StringArrayKeys<T> = {
  [K in keyof T]-?: ExtractArray<T[K]> extends never
    ? never
    : ArrayElement<T[K]> extends string
      ? K
      : never;
}[keyof T];

type ComparablePrimitive = string | number | bigint | Date;

type ComparableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends ComparablePrimitive ? K : never;
}[keyof T];

type EqualityComparablePrimitive = string | number | bigint | boolean | Date;

type EqualityComparableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends EqualityComparablePrimitive ? K : never;
}[keyof T];

type BooleanKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends boolean ? K : never;
}[keyof T];

type JsonObjectKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends JsonObject ? K : never;
}[keyof T];

type StringKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends string ? K : never;
}[keyof T];

type RevisionLiteral = FilterWhereLiteral<
  RevisionDataRecord,
  FilterWhereOperators<RevisionDataRecord>
>;

function isOperatorToken(value: unknown): value is InternalFilterOperator<PropertyKey, unknown> {
  return Boolean(value && typeof value === 'object' && FILTER_OPERATOR_TOKEN in (value as object));
}

/**
 * Normalizes string-or-array helper inputs so the SQL builder always receives a
 * mutable `string[]`. Accepts readonly arrays because call sites often share
 * literals (for example, `Thing.ops.containsAll(thing.urls)`).
 *
 * @param value Single string or readonly array supplied to an operator helper.
 */
function normalizeArrayValue(value: string | readonly string[]): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return [...value];
}

function normalizeNonEmptyArrayValue<T>(value: readonly [T, ...T[]] | [T, ...T[]]): T[] {
  const normalized = Array.from(value) as T[];
  if (normalized.length === 0) {
    throw new TypeError('FilterWhere ops.in requires at least one value.');
  }
  return normalized;
}

function createGroupedPredicate(
  builder: QueryBuilder,
  field: string | number | symbol,
  mutate: boolean,
  left: { operator: string; value: unknown; options?: Record<string, unknown> },
  right: { operator: string; value: unknown; options?: Record<string, unknown> },
  conjunction: 'AND' | 'OR'
): Predicate {
  const leftPredicate = builder._createPredicate(field, left.operator, left.value, left.options);
  const rightPredicate = builder._createPredicate(
    field,
    right.operator,
    right.value,
    right.options
  );
  const groupPredicate = {
    type: 'group',
    conjunction,
    predicates: [leftPredicate, rightPredicate],
  } as Predicate;

  if (mutate) {
    builder._where.push(groupPredicate);
  }

  return groupPredicate;
}

type PredicateOptions = Parameters<QueryBuilder['_createPredicate']>[3];

type RangeBounds = { leftBound: 'open' | 'closed'; rightBound: 'open' | 'closed' };

type RangeValue<T> = { lower: T; upper: T; options: RangeBounds };

/**
 * Create an operator token: `value` is what the caller passed (normalized),
 * and `build` turns it into a predicate for the field it ends up attached to.
 */
function makeOperator<K extends PropertyKey, TValue>(
  value: TValue,
  build: (context: OperatorBuilderContext) => Predicate | null
): InternalFilterOperator<K, TValue> {
  return {
    [FILTER_OPERATOR_TOKEN]: true,
    __allowedKeys: null as unknown as K,
    value,
    build,
  };
}

/**
 * Apply a predicate: `and()` adds it to the builder (mutate), while `or()`
 * only creates it so it can be grouped.
 */
function applyPredicate(
  { builder, field, mutate }: OperatorBuilderContext,
  operator: string,
  value: unknown,
  options?: PredicateOptions
): Predicate {
  return mutate
    ? builder._addWhereCondition(field, operator, value, options)
    : builder._createPredicate(field, operator, value, options);
}

/** Operator comparing the field with one value (`!=`, `<`, `LIKE`, …). */
function comparison<K extends PropertyKey, TValue>(
  operator: string,
  value: TValue,
  options?: PredicateOptions
): InternalFilterOperator<K, TValue> {
  return makeOperator<K, TValue>(value, context =>
    applyPredicate(context, operator, value, options)
  );
}

/**
 * Operator comparing a text-array column with a list of strings
 * (`@>` contains all, `&&` overlaps). An empty list matches everything for
 * `@>` and nothing for `&&`, so `emptyMatches` decides.
 */
function arrayComparison<K extends PropertyKey, TValue>(
  operator: '@>' | '&&',
  value: string | readonly string[],
  emptyMatches: 'all' | 'none'
): InternalFilterOperator<K, TValue> {
  const normalized = normalizeArrayValue(value);
  return makeOperator<K, TValue>(normalized as unknown as TValue, context => {
    if (normalized.length === 0) {
      if (emptyMatches === 'all') {
        return null;
      }
      // Overlap with an empty set is always false: match no rows rather
      // than silently dropping the filter.
      const predicate = context.builder._createMatchNothingPredicate();
      if (context.mutate) {
        context.builder._where.push(predicate);
      }
      return predicate;
    }
    return applyPredicate(context, operator, normalized, { cast: 'text[]' });
  });
}

/** Operator testing membership in a non-empty list (`= ANY`, `!= ALL`). */
function membership<K extends PropertyKey, TValue>(
  operator: '= ANY' | '!= ALL',
  values: readonly [TValue, ...TValue[]] | [TValue, ...TValue[]],
  cast: string | undefined
): InternalFilterOperator<K, TValue[]> {
  const normalized = normalizeNonEmptyArrayValue(values);
  return makeOperator<K, TValue[]>(normalized, context =>
    applyPredicate(context, operator, normalized, {
      valueTransform: (placeholder: string) => `(${placeholder}${cast ? `::${cast}` : ''})`,
    })
  );
}

/**
 * Operator testing whether the field lies within (or outside) a range.
 * Bounds default to closed; `outside` negates the range.
 */
function range<K extends PropertyKey, T>(
  lower: T,
  upper: T,
  options: { leftBound?: 'open' | 'closed'; rightBound?: 'open' | 'closed' },
  outside: boolean
): InternalFilterOperator<K, RangeValue<T>> {
  const bounds = {
    leftBound: options.leftBound ?? 'closed',
    rightBound: options.rightBound ?? 'closed',
  } as const;
  const leftOpen = bounds.leftBound === 'open';
  const rightOpen = bounds.rightBound === 'open';
  return makeOperator<K, RangeValue<T>>(
    { lower, upper, options: bounds },
    ({ builder, field, mutate }) =>
      createGroupedPredicate(
        builder,
        field,
        mutate,
        { operator: outside ? (leftOpen ? '<=' : '<') : leftOpen ? '>' : '>=', value: lower },
        { operator: outside ? (rightOpen ? '>=' : '>') : rightOpen ? '<' : '<=', value: upper },
        outside ? 'OR' : 'AND'
      )
  );
}

/**
 * Generates the operator helper bag exposed via `Model.ops`. The helpers are
 * intentionally minimal for now: `neq` works on any field, `containsAll`
 * targets string-array-backed columns for “must include every element”, and
 * `containsAny` uses the overlap operator until we add richer casts.
 */
function createOperators<TRecord extends JsonObject>(): FilterWhereOperators<TRecord> {
  return {
    neq<K extends keyof TRecord>(value: TRecord[K] | null) {
      return comparison<K, TRecord[K] | null>('!=', value);
    },
    lt<K extends ComparableKeys<TRecord>>(value: NonNullable<TRecord[K]>) {
      return comparison<K, NonNullable<TRecord[K]>>('<', value);
    },
    lte<K extends ComparableKeys<TRecord>>(value: NonNullable<TRecord[K]>) {
      return comparison<K, NonNullable<TRecord[K]>>('<=', value);
    },
    gt<K extends ComparableKeys<TRecord>>(value: NonNullable<TRecord[K]>) {
      return comparison<K, NonNullable<TRecord[K]>>('>', value);
    },
    gte<K extends ComparableKeys<TRecord>>(value: NonNullable<TRecord[K]>) {
      return comparison<K, NonNullable<TRecord[K]>>('>=', value);
    },
    containsAll<K extends StringArrayKeys<TRecord>>(
      value: string | readonly string[] | string[]
    ): InternalFilterOperator<K, TRecord[K]> {
      return arrayComparison<K, TRecord[K]>('@>', value, 'all');
    },
    containsAny<K extends StringArrayKeys<TRecord>>(
      value: string | readonly string[] | string[]
    ): InternalFilterOperator<K, TRecord[K]> {
      return arrayComparison<K, TRecord[K]>('&&', value, 'none');
    },
    in<K extends EqualityComparableKeys<TRecord>, TValue extends TRecord[K]>(
      values: readonly [TValue, ...TValue[]] | [TValue, ...TValue[]],
      options: { cast?: string } = {}
    ): InternalFilterOperator<K, TValue[]> {
      return membership<K, TValue>('= ANY', values, options.cast);
    },
    notIn<K extends EqualityComparableKeys<TRecord>, TValue extends TRecord[K]>(
      values: readonly [TValue, ...TValue[]] | [TValue, ...TValue[]],
      options: { cast?: string } = {}
    ): InternalFilterOperator<K, TValue[]> {
      return membership<K, TValue>('!= ALL', values, options.cast);
    },
    not<K extends BooleanKeys<TRecord>>(): InternalFilterOperator<K, true> {
      return comparison<K, true>('IS NOT', true);
    },
    between<K extends ComparableKeys<TRecord>>(
      lower: NonNullable<TRecord[K]>,
      upper: NonNullable<TRecord[K]>,
      options: { leftBound?: 'open' | 'closed'; rightBound?: 'open' | 'closed' } = {}
    ): InternalFilterOperator<K, RangeValue<NonNullable<TRecord[K]>>> {
      return range<K, NonNullable<TRecord[K]>>(lower, upper, options, false);
    },
    notBetween<K extends ComparableKeys<TRecord>>(
      lower: NonNullable<TRecord[K]>,
      upper: NonNullable<TRecord[K]>,
      options: { leftBound?: 'open' | 'closed'; rightBound?: 'open' | 'closed' } = {}
    ): InternalFilterOperator<K, RangeValue<NonNullable<TRecord[K]>>> {
      return range<K, NonNullable<TRecord[K]>>(lower, upper, options, true);
    },
    jsonContains<K extends JsonObjectKeys<TRecord>>(
      value: JsonObject
    ): InternalFilterOperator<K, JsonObject> {
      return comparison<K, JsonObject>('@>', value, {
        cast: 'jsonb',
        serializeValue: JSON.stringify,
      });
    },
    ilike<K extends StringKeys<TRecord>>(pattern: string): InternalFilterOperator<K, string> {
      return comparison<K, string>('ILIKE', pattern);
    },
    like<K extends StringKeys<TRecord>>(pattern: string): InternalFilterOperator<K, string> {
      return comparison<K, string>('LIKE', pattern);
    },
    notLike<K extends StringKeys<TRecord>>(pattern: string): InternalFilterOperator<K, string> {
      return comparison<K, string>('NOT LIKE', pattern);
    },
    notIlike<K extends StringKeys<TRecord>>(pattern: string): InternalFilterOperator<K, string> {
      return comparison<K, string>('NOT ILIKE', pattern);
    },
  } satisfies FilterWhereOperators<TRecord>;
}

/**
 * Typed facade around the legacy `QueryBuilder`. It injects default
 * revision-aware predicates, exposes the fluent DAL surface, and keeps the
 * `PromiseLike` contract so `await Model.filterWhere(...)` call sites work
 * without forcing `.run()`.
 */
class FilterWhereBuilder<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
  TRelations extends string,
> implements FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>
{
  private readonly _builder: QueryBuilder<TData, TVirtual, TInstance, TRelations>;
  private readonly _hasRevisions: boolean;
  private _includeDeleted = false;
  private _includeStale = false;
  private _revisionFiltersApplied = false;

  constructor(
    builder: QueryBuilder<TData, TVirtual, TInstance, TRelations>,
    hasRevisions: boolean
  ) {
    this._builder = builder;
    this._hasRevisions = hasRevisions;
  }

  private _ensureRevisionFilters(): void {
    if (this._revisionFiltersApplied) {
      return;
    }

    this._revisionFiltersApplied = true;

    if (!this._hasRevisions) {
      return;
    }

    if (!this._includeStale) {
      this._builder._addWhereCondition('_old_rev_of', 'IS', null);
    }

    if (!this._includeDeleted) {
      this._builder._addWhereCondition('_rev_deleted', '=', false);
    }
  }

  private _createFieldPredicate<K extends keyof TData>(
    field: K,
    value: FilterWhereLiteral<TData, FilterWhereOperators<TData>>[K],
    mutate: boolean
  ): Predicate | null {
    if (value === undefined) {
      return null;
    }

    const dbField = this._builder._resolveFieldName(field as string | symbol);
    this._builder._assertResolvedField(dbField);

    if (isOperatorToken(value)) {
      return value.build({ builder: this._builder, field: dbField, mutate });
    }

    return mutate
      ? this._builder._addWhereCondition(dbField, '=', value)
      : this._builder._createPredicate(dbField, '=', value);
  }

  private _applyLiteral(
    literal: FilterWhereLiteral<TData, FilterWhereOperators<TData>> | undefined,
    mutate: boolean,
    conjunction: 'AND' | 'OR' = 'AND'
  ): this {
    if (!literal) {
      return this;
    }

    if (conjunction === 'OR') {
      const predicates: Predicate[] = [];
      for (const [key, rawValue] of Object.entries(literal) as [keyof TData, unknown][]) {
        const predicate = this._createFieldPredicate(key, rawValue as never, false);
        if (predicate) {
          predicates.push(predicate);
        }
      }

      if (predicates.length > 0) {
        this._builder._where.push({
          type: 'group',
          conjunction: 'OR',
          predicates,
        });
      }

      return this;
    }

    for (const [key, rawValue] of Object.entries(literal) as [keyof TData, unknown][]) {
      this._createFieldPredicate(key, rawValue as never, mutate);
    }

    return this;
  }

  private _createRevisionFieldPredicate(
    field: keyof RevisionDataRecord,
    value: RevisionLiteral[keyof RevisionDataRecord],
    mutate: boolean
  ): Predicate | null {
    if (value === undefined) {
      return null;
    }

    const dbField = this._builder._resolveFieldName(field as string | symbol);
    this._builder._assertResolvedField(dbField);

    if (isOperatorToken(value)) {
      return value.build({ builder: this._builder, field: dbField, mutate });
    }

    return mutate
      ? this._builder._addWhereCondition(dbField, '=', value)
      : this._builder._createPredicate(dbField, '=', value);
  }

  and(literal: FilterWhereLiteral<TData, FilterWhereOperators<TData>>): this {
    return this._applyLiteral(literal, true, 'AND');
  }

  or(literal: FilterWhereLiteral<TData, FilterWhereOperators<TData>>): this {
    return this._applyLiteral(literal, false, 'OR');
  }

  includeDeleted(): this {
    this._includeDeleted = true;
    return this;
  }

  includeStale(): this {
    this._includeStale = true;
    return this;
  }

  includeSensitive(fields: string | string[]): this {
    this._builder.includeSensitive(fields);
    return this;
  }

  /**
   * Get all revisions of a document (current + archived) ordered by revision date.
   *
   * This bypasses standard revision filtering to include stale and deleted revisions.
   *
   * @param documentId The document ID to retrieve revisions for
   */
  getAllRevisions(documentId: string): this {
    this._includeStale = true;
    this._includeDeleted = true;
    this._builder.getAllRevisions(documentId);
    return this;
  }

  /**
   * Find a specific revision by its revision ID within a document's history.
   *
   * @param revId The revision ID to find
   * @param documentId The document ID the revision belongs to
   */
  getRevisionByRevId(revId: string, documentId: string): this {
    this._includeStale = true;
    this._includeDeleted = true;
    this._builder._addWhereCondition('_rev_id', '=', revId);
    this._builder.getAllRevisions(documentId);
    this._builder.limit(1);
    return this;
  }

  revisionData(literal: RevisionLiteral): this {
    if (!literal) {
      return this;
    }

    for (const [key, rawValue] of Object.entries(literal) as [
      keyof RevisionDataRecord,
      unknown,
    ][]) {
      this._createRevisionFieldPredicate(key, rawValue as never, true);
    }

    return this;
  }

  /**
   * Order results by a model column.
   *
   * @param field Field to sort by (camelCase or qualified string)
   * @param direction Sort direction
   */
  orderBy(field: Extract<keyof TData, string> | string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    const dbField = this._builder._resolveFieldName(field);
    this._builder._assertResolvedField(dbField);
    if (typeof dbField !== 'string') {
      throw new TypeError('FilterWhereBuilder.orderBy requires a string column reference.');
    }
    this._builder.orderBy(dbField, direction);
    return this;
  }

  /**
   * Order results using a column on a joined relation (through metadata).
   *
   * @param relation Relation key from the manifest
   * @param field Column on the related table (camelCase)
   * @param direction Sort direction
   */
  orderByRelation(relation: TRelations, field: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    (this._builder as QueryBuilder).orderByRelation(relation as string, field, direction);
    return this;
  }

  limit(count: number): this {
    this._builder.limit(count);
    return this;
  }

  async sample(count = 1): Promise<TInstance[]> {
    this._ensureRevisionFilters();
    const results = await this._builder.sample(count);
    return results;
  }

  offset(count: number): this {
    this._builder.offset(count);
    return this;
  }

  /**
   * Run a chronological feed query against a date-backed field using limit+1 cursor pagination.
   *
   * @param options Cursor pagination options.
   */
  async chronologicalFeed<K extends Extract<DateKeys<TData>, string>>(
    options: ChronologicalFeedOptions<TData, K>
  ): Promise<ChronologicalFeedPage<NonNullable<TData[K]>, TInstance>> {
    const { cursorField, cursor, direction: rawDirection = 'DESC', limit = 10 } = options ?? {};
    const direction = normalizeSortDirection(rawDirection);
    const normalizedLimit = Math.max(0, Math.floor(limit));

    this._ensureRevisionFilters();

    if (normalizedLimit === 0) {
      return {
        rows: [],
        hasMore: false,
        nextCursor: undefined,
      };
    }

    const dbField = this._builder._resolveFieldName(cursorField as string | symbol);
    this._builder._assertResolvedField(dbField);
    if (typeof dbField !== 'string') {
      throw new TypeError(
        'FilterWhereBuilder.chronologicalFeed requires a string column reference.'
      );
    }

    if (cursor !== undefined && cursor !== null) {
      const operator = direction === 'ASC' ? '>' : '<';
      this._builder._addWhereCondition(dbField, operator, cursor);
    }

    this._builder.orderBy(dbField, direction);
    this._builder.limit(normalizedLimit + 1);

    const results = await this._builder.run();
    const hasMore = results.length > normalizedLimit;
    const rows = hasMore ? results.slice(0, normalizedLimit) : results;

    let nextCursor: NonNullable<TData[K]> | undefined;
    if (hasMore && rows.length > 0) {
      const cursorValue = rows[rows.length - 1]?.[cursorField];
      if (cursorValue !== undefined && cursorValue !== null) {
        nextCursor = cursorValue as unknown as NonNullable<TData[K]>;
      }
    }

    return {
      rows,
      hasMore,
      nextCursor,
    };
  }

  getJoin(joinSpec: FilterWhereJoinSpec<TRelations>): this {
    this._builder.getJoin(joinSpec);
    return this;
  }

  whereIn(
    field: Extract<keyof TData, string>,
    values: unknown[],
    options: { cast?: string } = {}
  ): this {
    const dbField = this._builder._resolveFieldName(field);
    this._builder._assertResolvedField(dbField);
    if (typeof dbField !== 'string') {
      throw new TypeError('FilterWhereBuilder.whereIn requires a string column reference.');
    }
    this._builder.whereIn(dbField, values, options);
    return this;
  }

  whereRelated(relation: TRelations, field: string, value: unknown, operator = '='): this {
    (this._builder as QueryBuilder).whereRelated(relation as string, field, operator, value);
    return this;
  }

  async run(): Promise<TInstance[]> {
    this._ensureRevisionFilters();
    const results = await this._builder.run();
    return results;
  }

  async first(): Promise<TInstance | null> {
    this._ensureRevisionFilters();
    const result = await this._builder.first();
    return result ?? null;
  }

  async count(): Promise<number> {
    this._ensureRevisionFilters();
    return this._builder.count();
  }

  async average(field: Extract<keyof TData, string>): Promise<number | null> {
    this._ensureRevisionFilters();
    const dbField = this._builder._resolveFieldName(field);
    this._builder._assertResolvedField(dbField);
    if (typeof dbField !== 'string') {
      throw new TypeError('FilterWhereBuilder.average requires a string column reference.');
    }
    return this._builder.average(dbField);
  }

  groupBy(fields: string | string[]): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    const resolvedFields = fieldArray.map(field => {
      const dbField = this._builder._resolveFieldName(field);
      this._builder._assertResolvedField(dbField);
      if (typeof dbField !== 'string') {
        throw new TypeError('FilterWhereBuilder.groupBy requires string column references.');
      }
      return dbField;
    });
    this._builder.groupBy(resolvedFields);
    return this;
  }

  async aggregateGrouped(
    func: 'COUNT' | 'AVG' | 'SUM' | 'MIN' | 'MAX',
    options: { aggregateField?: string } = {}
  ): Promise<Map<string, number>> {
    this._ensureRevisionFilters();
    const resolvedOptions = { ...options };
    if (options.aggregateField) {
      const dbField = this._builder._resolveFieldName(options.aggregateField);
      this._builder._assertResolvedField(dbField);
      if (typeof dbField !== 'string') {
        throw new TypeError(
          'FilterWhereBuilder.aggregateGrouped requires a string column reference.'
        );
      }
      resolvedOptions.aggregateField = dbField;
    }
    return this._builder.aggregateGrouped(func, resolvedOptions);
  }

  /**
   * Atomically increment a numeric column scoped by the current predicates.
   *
   * @param field Numeric model field to increment
   * @param options Configure the increment step and returned columns
   */
  async increment<
    K extends Extract<NumericKeys<TData>, string>,
    R extends Extract<keyof TData, string> = K,
  >(
    field: K,
    options: { by?: number; returning?: R[] } = {}
  ): Promise<{ rowCount: number; rows: Array<Pick<TData, R>> }> {
    this._ensureRevisionFilters();
    const result = await (this._builder as QueryBuilder).increment(
      field as string,
      options.by ?? 1,
      { returning: options.returning as string[] | undefined }
    );

    return result as { rowCount: number; rows: Array<Pick<TData, R>> };
  }

  /**
   * Atomically decrement a numeric column scoped by the current predicates.
   *
   * @param field Numeric model field to decrement
   * @param options Configure the decrement step and returned columns
   */
  async decrement<
    K extends Extract<NumericKeys<TData>, string>,
    R extends Extract<keyof TData, string> = K,
  >(
    field: K,
    options: { by?: number; returning?: R[] } = {}
  ): Promise<{
    rowCount: number;
    rows: Array<Pick<TData, R>>;
  }> {
    const amount = options.by ?? 1;
    return this.increment(field, { ...options, by: -Math.abs(amount) });
  }

  /**
   * Delete rows matching the current predicates. Models with revision tracking
   * require `{ purge: true }`, which also removes the matched documents'
   * archived revisions; use `deleteAllRevisions(user)` to soft-delete instead.
   *
   * @param options Delete options
   */
  async delete(options: DeleteOptions = {}): Promise<number> {
    this._ensureRevisionFilters();
    return this._builder.delete(options);
  }

  /**
   * Delete the row with the given ID, provided it also matches the current
   * predicates. Same revision rules as {@link FilterWhereBuilder.delete}.
   *
   * @param id Record ID
   * @param options Delete options
   */
  async deleteById(id: string, options: DeleteOptions = {}): Promise<number> {
    this._builder._addWhereCondition('id', '=', id);
    return this.delete(options);
  }

  then<TResult1 = TInstance[], TResult2 = never>(
    onFulfilled?: ((value: TInstance[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected);
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<TInstance[] | TResult> {
    return this.run().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<TInstance[]> {
    return this.run().finally(onFinally ?? undefined);
  }
}

/**
 * Produces the concrete `filterWhere` static bound to a manifest-derived
 * constructor. This stays lightweight so every model gets the same behaviour
 * without bespoke wiring inside the manifest definition itself.
 *
 * @param hasRevisions - Whether the model uses revision tracking
 * @returns A filterWhere method bound to the model type
 */
function createFilterWhereMethod<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
  TRelations extends string,
>(hasRevisions: boolean) {
  /**
   * Typed entry point for building a `filterWhere` query.
   *
   * @param this Model constructor the query should operate on.
   * @param literal Initial predicate literal applied to the builder.
   */
  function filterWhere(
    this: ModelConstructor<TData, TVirtual, TInstance, TRelations> & ModelRuntime<TData, TVirtual>,
    literal: FilterWhereLiteral<TData, FilterWhereOperators<TData>>
  ) {
    const builder = new QueryBuilder<TData, TVirtual, TInstance, TRelations>(this, this.dal);
    return new FilterWhereBuilder<TData, TVirtual, TInstance, TRelations>(
      builder,
      hasRevisions
    ).and(literal);
  }

  return filterWhere;
}

type RelationNames<Manifest extends ModelManifest> =
  Manifest['relations'] extends readonly (infer Relations)[]
    ? Relations extends { name: infer Name }
      ? Name extends string
        ? Name
        : never
      : never
    : never;

/**
 * Helper consumed by `createModel` so all manifest-based models expose the new
 * statics even before the DAL bootstrap finishes initializing the underlying
 * constructors.
 *
 * @param _manifest - Manifest describing the model being registered
 * @returns Static methods object with filterWhere and ops
 */
function createFilterWhereStatics<Manifest extends ModelManifest>(_manifest: Manifest) {
  type Data = InferData<Manifest['schema']>;
  type Virtual = ManifestVirtualFields<Manifest>;
  type Instance = InferInstance<Manifest>;
  type Relations = RelationNames<Manifest>;

  return {
    ops: createOperators<Data>(),
    filterWhere: createFilterWhereMethod<Data, Virtual, Instance, Relations>(
      Boolean(_manifest.hasRevisions)
    ),
  } as const;
}

export {
  FILTER_OPERATOR_TOKEN,
  FilterWhereBuilder,
  createFilterWhereStatics,
  createOperators,
  createFilterWhereMethod,
};
export type { InternalFilterOperator };
