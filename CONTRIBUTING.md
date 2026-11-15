# Contributing

See the [README](README.md) for an introduction and the [model guide](docs/models.md)
for bootstrap and runtime architecture.

## Development setup

Use Node.js 22 or later and PostgreSQL for integration tests. Install dependencies
and build the library:

```bash
npm install
npm run build
```

Before submitting changes, run:

```bash
npm run lint
npm run typecheck
npm run test:types
npm test
```

## Testing

rev-dal uses Node's built-in test runner with `tsx` to execute TypeScript tests.

```bash
npm test
```

### Test Database Setup

Integration tests require PostgreSQL with the `pgcrypto` extension available. The test harness
creates a fresh schema per run and cleans it up afterwards.

Provide a connection string via `REV_DAL_TEST_DATABASE_URL`:

```bash
export REV_DAL_TEST_DATABASE_URL="postgres://rev_dal_test_user:rev_dal_password@localhost:5432/rev_dal_test"
npm test
```

If your test user cannot create extensions, run this once as a superuser:

```bash
psql -d rev_dal_test -c 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";'
```

### Revision Tests

The shared `revisions` fixture in `test/helpers/revision-helpers.ts` includes JSONB,
array and timestamp columns, and `createTestDocumentWithRevisions()` edits them in
place the way applications do. When changing how rows are read, written or copied,
check history with `assertArchivedRevisionMatches()`, which compares an archived
revision with the stored row from before the edit.

### Type Tests

Type-level checks live under `test/types/` and are compiled with a dedicated config:

```bash
npm run test:types
```

## Directory Reference

- `src/index.ts` – Public entry point that re-exports constructors, types, and helpers.
- `src/lib/` – Core implementation (connection management, manifests, query builder, filters, revision system, schema types).
- `setup-db-grants.sql` – Grants applied to shared environments.
