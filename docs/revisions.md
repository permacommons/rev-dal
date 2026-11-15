# Revisions

[README](../README.md) · [Models](models.md) · [Queries](queries.md)

Models with `hasRevisions: true` gain revision metadata fields and helpers:

- Static helpers (`createFirstRevision`, `getNotStaleOrDeleted`, revision-aware `filterWhere`, etc.).
- Instance helpers (`newRevision`, `deleteAllRevisions`).
- `filterWhere.revisionData()` exposes typed predicates for `_rev*` columns when querying revision metadata.

`_revSummary` is disabled by default. If you want it, add the column in your
schema and call `setRevisionSummaryEnabled(true)` at bootstrap.

## Saving revisions and edit conflicts

`newRevision()` only prepares the new revision in memory. The following `save()`
updates the current row and archives the previous revision in one transaction, so
a failure leaves no partial history. The archived copy is a deep snapshot taken
when `newRevision()` runs, so editing nested values in place afterwards
(`rev.title[lang] = …`, `rev.tags.push(…)`) only changes the new revision. Make
edits after calling `newRevision()`: changes made to the instance before it are
archived as part of the previous revision. `deleteAllRevisions()` and `saveAll()`
are likewise all-or-nothing.

Saves use optimistic concurrency: the update only applies if the stored revision
is still the one this copy was loaded from. If someone else saved a revision in
the meantime, `save()` writes nothing and throws `RevisionConflictError`
(`code: 'REVISION_CONFLICT'`), carrying `documentId`, `expectedRevId` and
`currentRevId`. The DAL never retries automatically, since re-applying a stale
edit would overwrite the other change; the application decides:

```ts
import { RevisionConflictError } from 'rev-dal/lib/errors';

const rev = await page.newRevision(user, { tags: ['edit'] });
rev.body = newBody;
try {
  await rev.save();
} catch (error) {
  if (error instanceof RevisionConflictError) {
    // e.g. show an edit-conflict view, or reload and reapply the change
  }
  throw error;
}
```

To include these writes in a larger transaction, pass the client from
`dal.transaction()`: `save({ transaction: client })`,
`saveAll(joinOptions, { transaction: client })` or
`deleteAllRevisions(user, { transaction: client })`. The caller then owns
COMMIT/ROLLBACK.

Errors raised by the DAL itself (`ValidationError`, `DocumentNotFound`,
`RevisionConflictError`, …) reach the caller with their own type; only raw
PostgreSQL errors are converted.

See [query deletion options](queries.md#deleting-records) for permanent purges and
[querying data](queries.md#querying-data) for revision-history lookups.
