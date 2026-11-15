# rev-dal

rev-dal is a TypeScript-first PostgreSQL data access layer with built-in revision support and
rich model typing (including multilingual string helpers).

It is currently internally used in the [Permacommons](https://permacommons.org/)
project family for two projects:

- https://lib.reviews/ - review anything in any language
- https://agpedia.org/ - an encyclopedia and knowledge repository managed
  via MCP (AI agents)

The need for consistent wiki-style revision metadata motivated the creation
of a custom DAL.

## Requirements

Node.js 22 or later and PostgreSQL.

## Install

```bash
npm install github:permacommons/rev-dal
```

## Quick start

Create a DAL with your application's PostgreSQL connection settings:

```ts
import createDataAccessLayer from 'rev-dal';

const dal = createDataAccessLayer({
  connectionString: process.env.DATABASE_URL,
});
await dal.connect();

try {
  const result = await dal.query('SELECT NOW() AS now');
  console.log(result.rows[0].now);
} finally {
  await dal.disconnect();
}
```

For typed model operations, follow [Models and bootstrap](docs/models.md) to
register manifests and configure model resolution. Database tables must already
exist; declaring a model does not create them.

## Documentation

- [Models and bootstrap](docs/models.md) — lifecycle, manifests, methods, typing,
  cross-model references, logging, and database grants.
- [Queries and relations](docs/queries.md) — filtering, projections, aggregates,
  joins, deletion, and loading or writing associations.
- [Revisions](docs/revisions.md) — revision history, edit conflicts, and transactions.
- [Multilingual text](docs/multilingual-text.md) — schemas, language providers,
  escaping, cleanup, and rendering responsibilities.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, test database configuration,
checks, and the source directory map.
