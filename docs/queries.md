# Queries and relations

[README](../README.md) · [Models](models.md) · [Revisions](revisions.md)

## Querying Data

Define and initialize your models as described in [Models and bootstrap](models.md).
Every manifest-based model ships a typed query entry point:

- **`Model.filterWhere(literal)`** – Typed builder defined in `rev-dal/lib/filter-where`. Features include:
  - Typed predicate literals keyed by manifest fields.
  - Operator helpers exposed via `Model.ops` (`neq`, `gt/gte/lt/lte`, `in/notIn`, `between/notBetween`, `containsAll`, `containsAny`, `jsonContains`, `not`, `like/ilike/notLike/notIlike`).
  - Automatic revision guards (`_old_rev_of IS NULL`, `_rev_deleted = false`) with opt-outs (`includeDeleted()`, `includeStale()`).
  - Revision history helpers: `getAllRevisions(documentId)` returns all revisions (current + archived), `getRevisionByRevId(revId, documentId)` finds a specific revision.
  - Fluent chaining (`and`, `or`, `revisionData`, `orderBy`, `orderByRelation`, `limit`, `offset`, `getJoin`, `whereRelated`, `whereIn`, `chronologicalFeed`, `delete`, `count`, `average`, `groupBy`, `aggregateGrouped`).
  - Promise-like behaviour so `await Model.filterWhere({ ... })` works without `.run()`.
  - Input safety: `limit`/`offset` accept only non-negative integers and sort directions only `ASC`/`DESC` (case-insensitive); anything else throws a `TypeError`. An empty `whereIn(field, [])` or `ops.containsAny([])` matches no rows rather than dropping the filter.

Example:

```ts
const { containsAll, neq } = Thing.ops;
const things = await Thing.filterWhere({ urls: containsAll(targetUrls) })
  .and({ createdBy: neq(blockedUserId) })
  .orderBy('created_on', 'DESC')
  .limit(25)
  .run();

// Aggregates reuse the same revision-safe predicates
const averageRating = await Review.filterWhere({ thingID }).average('starRating');
const reviewCount = await Review.filterWhere({ thingID }).count();

// Atomic counters for numeric schema fields (throws on non-numeric columns)
const { rows } = await User.filterWhere({ id: someUser }).increment('inviteLinkCount', {
  by: 1,
  returning: ['inviteLinkCount'],
});

// Or decrement the same field atomically
await User.filterWhere({ id: someUser }).decrement('inviteLinkCount', { by: 1 });

// Average rating per category
const avgPrices = await Product.filterWhere({})
  .groupBy('category')
  .aggregateGrouped('AVG', { aggregateField: 'price' });
// Returns: Map<string, number> { 'electronics' => 299.99, 'books' => 19.99, ... }

// String pattern matching with LIKE/ILIKE operators
const { ilike, notLike } = WikiPage.ops;
const searchResults = await WikiPage.filterWhere({ slug: ilike(`%${query}%`) }).run();
const nonMetaPages = await WikiPage.filterWhere({ slug: notLike('meta/%') }).count();

// Revision history lookups
const allRevisions = await WikiPage.filterWhere({})
  .getAllRevisions(page.id)
  .orderBy('_revDate', 'DESC')
  .run();

const specificRevision = await WikiPage.filterWhere({})
  .getRevisionByRevId(revId, page.id)
  .first();
```

### Selecting fields without loading models

Use `select(...fields)` as the final query-building step to fetch only the
persisted fields you need. It returns a promise-like query with `run()` and
`first()`. Results are plain objects with exactly the selected properties, typed
as read-only and shallowly frozen at runtime. They have no model methods such as
`save()`. Nested JSON values are not frozen.

```ts
const accounts = await Account.filterWhere({ isActive: true })
  .orderBy('id')
  .limit(25)
  .select('id', 'displayName');
// Only id and displayName are selected in SQL; other fields are unavailable.

const revisionIds = [currentRevId, ...sourceRevisionIds];
const counters = await WikiPage.filterWhere({})
  .getAllRevisions(page.id)
  .revisionData({ _revID: WikiPage.ops.in(revisionIds) })
  .select('_revID', 'bodyEditCounts');
// Fetches revision IDs and counters without transferring historical bodies.

const account = await Account.filterWhere({ id: accountId })
  .includeSensitive('email') // Required if email is marked sensitive
  .select('id', 'email')
  .first(); // Selected row or null
```

Selections use public model field names, including camelCase mappings and, on
revision-enabled models, metadata such as `_revID` and `_revDate`. Returned names
and value types follow those fields; SQL columns are aliased to the public names.
Values come from the PostgreSQL driver without model defaults, virtual-field
calculation, or hydration hooks. Unknown fields and virtual fields are rejected.
Selecting a sensitive field without an explicit `includeSensitive()` opt-in
throws; opting in does not add that field unless it is also selected.

Apply filters, revision-history helpers, sorting, pagination, and sensitive-field
opt-ins before `select()`. The projection captures the query and parameter values
at that point; later changes to the original builder do not affect it. Normal
revision guards still apply unless disabled with the existing revision helpers.
`first()` returns `null` when no row matches. It limits the query to one row and
preserves `limit(0)`. In contrast, `Model.get(id)` returns an instance or throws
`DocumentNotFound` when the record does not exist.

An empty selection is rejected. Projection cannot be combined with `getJoin()`,
`whereRelated()` (which currently creates a join), or `groupBy()`; no identity
or grouping columns are added implicitly. Use
`aggregateGrouped()` for grouped aggregates. Existing `defineView()` / `fetchView()`
views continue to project hydrated models in JavaScript and do not reduce SQL
result columns.

### Deleting records

See [Revisions](revisions.md) for soft deletion and transaction behavior.

- `delete()` requires at least one predicate; an unfiltered builder throws instead of emptying the table. `deleteById(id)` on a `filterWhere` builder also respects the builder's predicates.
- On models with revision tracking, the normal delete is the soft `deleteAllRevisions(user)`. Hard deletes (`filterWhere(...).delete()`, `deleteById()`, `Model.delete(id)`, `instance.delete()`) throw unless you pass `{ purge: true }`. A purge permanently removes the matched documents **and** their archived revisions:

```ts
await doc.deleteAllRevisions(user);                // soft delete (keeps history)
await Thing.delete(thingId, { purge: true });      // permanent, removes all revisions
```

### Grouped Aggregations

Use `groupBy()` and `aggregateGrouped()` for batched aggregations:

```ts
// Batch fetch review counts for multiple things in a single query
const { in: inOp } = Review.ops;
const counts = await Review.filterWhere({ thingID: inOp(thingIds) })
  .groupBy('thingID')
  .aggregateGrouped('COUNT');

things.forEach(thing => {
  thing.reviewCount = counts.get(thing.id) ?? 0;
});
```

Supports `COUNT`, `AVG`, `SUM`, `MIN`, `MAX`. Returns `Map<string, number>` keyed by the first `groupBy` field. For aggregates other than COUNT, specify `aggregateField` option.

## Batch Loading Relations

The DAL provides `Model.loadManyRelated()` for efficiently loading direct relations
and many-to-many associations through junction tables. This is especially useful
when hydrating lists of records with their related data (the "N+1 query" problem).

### Basic Usage

```ts
// Load teams for multiple reviews in a single query
const reviewIds = reviews.map(r => r.id);
const reviewTeamMap = await Review.loadManyRelated('teams', reviewIds);

// Populate each review with its teams
reviews.forEach(review => {
  review.teams = reviewTeamMap.get(review.id) || [];
});
```

### How It Works

`loadManyRelated()` uses the relation metadata defined in your manifest to:

1. Build a single SQL query that filters the target column directly or joins through a junction table
2. Apply revision system guards (`_old_rev_of IS NULL`, `_rev_deleted = false`) when needed
3. Group results by source ID
4. Return a `Map<sourceId, TargetInstance[]>` for easy assignment

**Before** (manual SQL):
```ts
const query = `
  SELECT rt.review_id, t.* FROM teams t
  JOIN review_teams rt ON t.id = rt.team_id
  WHERE rt.review_id IN (${placeholders})
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
`;
const result = await dal.query(query, reviewIds);
// Manual grouping logic...
```

**After** (DAL helper):
```ts
const reviewTeamMap = await Review.loadManyRelated('teams', reviewIds);
```

### Requirements

The relation must be defined in your model's manifest with a target model registered
on the DAL. For many-to-many relations, provide a `through` object specifying the
junction table and its `sourceForeignKey` and `targetForeignKey` columns. For direct
relations, `targetKey` identifies the target field matched against the supplied
source values. Set `hasRevisions` for revision-aware filtering in either case.

For example, a user's direct `posts` relation can use `sourceKey: 'id'` and
`targetKey: 'authorID'`. Calling `User.loadManyRelated('posts', userIds)` returns
posts grouped by author ID. The helper uses the values you supply; it does not
fetch source rows to resolve a different `sourceKey`.

Example manifest configuration:
```ts
const reviewManifest = {
  tableName: 'reviews',
  hasRevisions: true as const,
  schema: { /* ... */ },
  relations: [
    {
      name: 'teams',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'review_teams',
        sourceForeignKey: 'review_id',
        targetForeignKey: 'team_id',
      },
      cardinality: 'many',
    },
  ] as const,
} as const satisfies ModelManifest;
```

### Edge Cases

- **Empty input**: Returns empty `Map` when given `[]`
- **No matches**: Returns empty `Map` when no associations exist
- **Deleted records**: Automatically excludes soft-deleted related records when `hasRevisions: true`
- **Sensitive fields**: Excluded from loaded records, as with inline joins
- **Type safety**: Results are typed as `Map<string, ModelInstance<JsonObject, JsonObject>[]>`, requiring a cast to the specific target type when needed

## Writing Many-to-Many Associations

The DAL provides `Model.addManyRelated()` for batch-inserting associations into many-to-many junction tables. This complements `loadManyRelated()` by handling the write side of many-to-many relationships.

### Basic Usage

```ts
// Associate a thing with multiple files
const Thing = dalFixture.getModel('things');
await Thing.addManyRelated('files', thingId, [file1.id, file2.id]);

// Associate a review with teams
const Review = dalFixture.getModel('reviews');
await Review.addManyRelated('teams', reviewId, teamIds);
```

### How It Works

`addManyRelated()` uses the relation metadata defined in your manifest to:

1. Build a parameterized INSERT query for the junction table
2. Apply schema namespace prefixing for test isolation
3. Handle duplicate associations gracefully via `ON CONFLICT DO NOTHING` (default)
4. Validate inputs and provide helpful error messages

**Before** (manual SQL):
```ts
const runtime = this.constructor as Record<string, any>;
const dalInstance = runtime.dal as Record<string, any>;
const junctionTable = dalInstance.schemaNamespace
  ? `${dalInstance.schemaNamespace}thing_files`
  : 'thing_files';
const insertValues: Array<string | undefined> = [];
const valueClauses: string[] = [];
let paramIndex = 1;

validFiles.forEach(file => {
  valueClauses.push(`($${paramIndex}, $${paramIndex + 1})`);
  insertValues.push(this.id, file.id);
  paramIndex += 2;
});

if (valueClauses.length) {
  const insertQuery = `
    INSERT INTO ${junctionTable} (thing_id, file_id)
    VALUES ${valueClauses.join(', ')}
    ON CONFLICT DO NOTHING
  `;
  await dalInstance.query(insertQuery, insertValues);
}
```

**After** (DAL helper):
```ts
const Thing = this.constructor as ThingModel;
await Thing.addManyRelated('files', this.id!, validFiles.map(f => f.id!));
```

### Requirements

The relation must be defined in your model's manifest with:
- A `through` object specifying the junction table
- Proper `sourceForeignKey` and `targetForeignKey` columns
- `cardinality: 'many'`

Example manifest configuration:
```ts
const thingManifest = {
  hasRevisions: true as const,
  tableName: 'things',
  relations: [
    {
      name: 'files',
      targetTable: 'files',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'thing_files',
        sourceForeignKey: 'thing_id',
        targetForeignKey: 'file_id',
      },
      cardinality: 'many',
    },
  ] as const,
} as const satisfies ModelManifest;
```

### Conflict Handling

By default, duplicate associations are silently ignored:

```ts
// Associate once
await Review.addManyRelated('teams', reviewId, [teamId]);

// Associate again - no error, no duplicate row
await Review.addManyRelated('teams', reviewId, [teamId]);
```

For strict validation, use `{ onConflict: 'error' }`:

```ts
await Review.addManyRelated('teams', reviewId, [teamId], { onConflict: 'error' });
// Throws if association already exists
```

### Edge Cases

- **Empty input**: Returns immediately when given `[]` with no database query
- **Invalid relation**: Throws helpful error listing available relations
- **Non-junction relation**: Throws error if relation doesn't have a `through` table
- **Invalid source ID**: Throws error for empty or non-string source IDs
- **Schema isolation**: Automatically handles test namespace prefixing

### Instance Method Pattern

When writing instance methods that create associations, follow this pattern:

```ts
async addFilesByIDsAndSave(this: ThingInstance, fileIDs: string[]): Promise<ThingInstance> {
  // 1. Validate and fetch related records
  const { in: inOp } = File.ops;
  const validFiles = await File.filterWhere({ id: inOp(fileIDs as [string, ...string[]]) }).run();

  if (!validFiles.length) {
    return this;
  }

  // 2. Insert associations using static helper
  const Thing = this.constructor as ThingModel;
  await Thing.addManyRelated('files', this.id!, validFiles.map(f => f.id!));

  // 3. Update in-memory representation
  this.files = [...(this.files ?? []), ...validFiles];

  return this;
}
```
