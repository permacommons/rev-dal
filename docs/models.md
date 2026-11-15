# Models and bootstrap

[README](../README.md) · [Queries](queries.md) · [Revisions](revisions.md)

## Bootstrap & Lifecycle

```ts
import createDataAccessLayer from 'rev-dal';
import { initializeManifestModels } from 'rev-dal/lib/create-model';
import { setBootstrapResolver } from 'rev-dal/lib/model-handle';

// Import every runtime model module so defineModel() registers its manifest.
import './models/user.js';
import './models/team.js';

const dal = createDataAccessLayer();
setBootstrapResolver(() => ({
  getModel: name => dal.modelRegistry.get(name),
}));
await dal.connect();
initializeManifestModels(dal);
```

Importing a plain manifest alone does not register it; import the module that calls
`defineModel()`. Include related models such as `user_metas` in your application's
imports as well. Configure the resolver before initializing models so lazy relation
targets can resolve through the registry. Call model methods after initialization.

The DAL is initialised once at startup. Tests and fixtures may spin up isolated instances; disconnecting a DAL clears its registry so cached constructors do not leak across runs. Model proxies and references use the globally configured bootstrap resolver; when switching DAL instances, update that resolver to point at the intended instance.

## Defining Models

Models are split across two directories to avoid circular imports:

- **`models/manifests/`** – Schema declarations, types, validation helpers, and cross-model reference functions
- **`models/`** – Runtime behavior (complex static/instance methods that depend on other models)

### Basic Structure

```ts
// models/manifests/user.ts - Schema, types, validation helpers
import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';
import type { ModelInstance } from 'rev-dal/lib/model-types';
import type { TeamInstance } from './team.js';

const { types } = dal;

// Model-specific options and helpers
const userOptions = {
  maxChars: 128,
  illegalChars: /[<>;"&?!./_]/,
  minPasswordLength: 6,
};

export function canonicalize(name: string): string {
  return name.toUpperCase();
}

function containsOnlyLegalCharacters(name: string): true {
  if (userOptions.illegalChars.test(name)) {
    throw new Error(`Username ${name} contains invalid characters.`);
  }
  return true;
}

const userManifest = {
  tableName: 'users',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    email: types.string(),
    userMetaID: types.string().uuid(4),
    displayName: types
      .string()
      .max(userOptions.maxChars)
      .validator(containsOnlyLegalCharacters)
      .required(),
    suppressedNotices: types.array(types.string()),
    urlName: types
      .virtual()
      .returns<string | undefined>()
      .default(function (this: ModelInstance) {
        const displayName = this.getValue('displayName');
        return displayName ? encodeURIComponent(String(displayName).replace(/ /g, '_')) : undefined;
      }),
  },
  camelToSnake: {
    displayName: 'display_name',
    suppressedNotices: 'suppressed_notices',
    userMetaID: 'user_meta_id',
  },
  relations: [
    {
      name: 'meta',
      targetTable: 'user_metas',
      sourceKey: 'userMetaID',
      targetKey: 'id',
      hasRevisions: true,
      cardinality: 'one',
    },
    {
      name: 'teams',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      cardinality: 'many',
      through: {
        table: 'team_members',
        sourceForeignKey: 'user_id',
        targetForeignKey: 'team_id',
      },
    },
  ] as const,
} as const satisfies ModelManifest;

export type UserInstance = ManifestInstance<typeof userManifest> & {
  teams?: TeamInstance[];
};
export type UserModel = ManifestModel<typeof userManifest>;

// For models WITH relations, use intersection pattern for strong typing:
// export type UserInstance = ManifestInstance<typeof userManifest> & {
//   meta?: UserMetaInstance;
//   teams?: TeamInstance[];
// };

// Export reference helper for other models to use
export function referenceUser(): UserModel {
  return referenceModel(userManifest) as UserModel;
}

export { userOptions };
export default userManifest;
```

### Relation Definition

Relations are defined as plain objects in the manifest's `relations` array:

```ts
interface RelationDefinition {
  name: string;                     // Field name on the instance
  targetTable?: string;             // Target table name, OR use target()
  target?: () => unknown;           // Lazy model reference (has tableName)
  sourceKey?: string;               // Column on this model (default: 'id')
  targetKey?: string;               // Column on target model (default: 'id')
  cardinality?: 'one' | 'many';     // Affects join strategy when using `true`
  hasRevisions?: boolean;           // Apply revision guards to joined records
  through?: {                       // For many-to-many via junction table
    table: string;
    sourceForeignKey?: string;
    targetForeignKey?: string;
  };
}
```

Example with a many-to-many relation:

```ts
relations: [
  {
    name: 'teams',
    targetTable: 'teams',
    sourceKey: 'id',
    targetKey: 'id',
    hasRevisions: true,
    through: {
      table: 'team_members',
      sourceForeignKey: 'user_id',
      targetForeignKey: 'team_id',
    },
    cardinality: 'many',
  },
]
```

```ts
// models/user.ts - Runtime behavior
import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import userManifest, { type UserInstance, type UserModel } from './manifests/user.ts';
import type { TeamInstance } from './manifests/team.ts';

const userStaticMethods = defineStaticMethods(userManifest, {
  async findByEmail(this: UserModel, email: string) {
    return this.filterWhere({ email }).run();
  },

  async getWithTeams(this: UserModel, id: string) {
    const user = await this.get(id);
    if (user) {
      const teamsByUser = await this.loadManyRelated('teams', [id]);
      (user as UserInstance).teams = (teamsByUser.get(id) ?? []) as TeamInstance[];
    }
    return user;
  }
});

export default defineModel(userManifest, { staticMethods: userStaticMethods });
```

### Atomic upsert

Non-revisioned models expose `upsert(data, options)` to insert or update a row
in one PostgreSQL statement:

```typescript
const override = await EditorOverride.upsert(
  { userId, status, reason, actorId, decidedAt: new Date() },
  {
    conflictFields: ['userId'],
    updateFields: ['status', 'reason', 'actorId', 'decidedAt'],
    transaction, // optional existing transaction handle
  }
);
```

`conflictFields` must match a database unique constraint/index; composite keys
are supported. Both field lists must be non-empty and contain distinct persisted
schema field names. Field mappings, defaults and validators apply. Each update
field needs an explicit, defined value in `data`; only listed fields change on
conflict. The method returns the persisted model instance, including database
defaults, and rejects unknown and virtual fields. Conflict key values must be
non-null. Concurrent calls use PostgreSQL's atomic conflict handling.

Sensitive values may be inserted as with `create()`. Updating a sensitive field
requires listing it in `updateSensitive`; sensitive fields are omitted from the
returned instance unless listed in `includeSensitive`. Revisioned models reject
upsert to preserve revision history. `save()` keeps its existing behavior.

### Type Inference

Manifests drive all type inference:

- **Low-level helpers** (internal):
  - `InferData` and `InferVirtual` extract stored and virtual fields from schema builders
  - `InferInstance` switches between `ModelInstance` and `VersionedModelInstance` based on `hasRevisions`
  - `InferConstructor` produces the typed model constructor with CRUD methods
- **Convenience helpers** (recommended for manifest files):
  - `ManifestInstance<Manifest, InstanceMethods>` - cleaner than `InferInstance<MergeManifestMethods<...>>`
  - `ManifestModel<Manifest, StaticMethods, InstanceMethods>` - cleaner than `InferConstructor<MergeManifestMethods<...>>`
- **Bundle helpers for manifests**:
  - `ManifestTypes<Manifest, StaticMethods, InstanceMethods, Relations>` packages the data, virtual, instance, and model types
    into a single object.
  - `ManifestBundle<Manifest, Relations, StaticMethods, InstanceMethods>` builds on `ManifestTypes` and additionally returns
    typed `StaticMethods`/`InstanceMethods` mappings. Use this to keep manifest exports short without circular aliases.
- **Method mapping helpers**:
  - `StaticMethodsFrom`/`InstanceMethodsFrom` map plain method signatures to manifest-aware `this` types so authors don't need
    to annotate every method with `this: ModelType` or `this: InstanceType`. The generics are ordered as manifest, method map,
    then relation fields (plus instance methods for static methods) to match the call graph.
- Static/instance methods declared via `defineStaticMethods`/`defineInstanceMethods` receive correctly typed `this` via contextual `ThisType`

Example using `ManifestBundle` to keep manifests terse:

```ts
type ThingRelations = { files?: FileInstance[] };

type ThingTypes = ManifestBundle<
  typeof thingManifest,
  ThingRelations,
  { getWithData(id: string): Promise<ThingTypes['Instance']> },
  { populateUserInfo(user: UserAccessContext | null | undefined): void }
>;

type ThingInstance = ThingTypes['Instance'];
type ThingStaticMethods = ThingTypes['StaticMethods'];
type ThingInstanceMethods = ThingTypes['InstanceMethods'];
```

Method implementations can then omit explicit `this` annotations while still receiving the fully-typed model/instance context in the body.

**Relation Field Typing**: Use the intersection pattern to add strongly-typed relation fields:

```ts
// If you have static/instance methods, define base types first
type UserInstanceBase = ManifestInstance<typeof userManifest, UserInstanceMethods>;

// Add relation types via intersection - fields are optional since they're
// only populated when explicitly loaded via getJoin() or custom queries
export type UserInstance = UserInstanceBase & {
  meta?: UserMetaInstance;
  teams?: TeamInstance[];
};
```

This pattern avoids circular type errors when two models reference each other (e.g., Thing ↔ Review).

### Cross-Model References

Use `referenceModel()` to safely import other models without circular dependencies:

```ts
// In models/thing.ts
import { referenceReview, type ReviewInstance } from './manifests/review.ts';

const Review = referenceReview();

// Can now call Review.filterWhere(...) safely
const reviews = await Review.filterWhere({ thingID: thing.id }).run();
```

The manifest exports a typed reference function that returns a lazy proxy. The actual model is resolved at runtime after bootstrap completes.

### What Goes Where?

**Manifests** (`models/manifests/`) contain:
- Schema definitions as plain objects with `as const satisfies ModelManifest`
- Type exports (`UserInstance`, `UserModel`, etc.)
- Validation functions used in schema validators
- Model-specific constants and options
- Cross-model reference functions (`referenceUser()`, etc.)
- Simple helper functions with no external model dependencies

**Runtime models** (`models/`) contain:
- Complex static methods that query other models
- Instance methods that interact with related models
- Business logic that requires calling multiple models
- Methods that need fully-initialized DAL helpers

**Rule of thumb**: If it needs to call another model's methods, put it in `models/`. If it's pure validation, types, or schema, put it in `models/manifests/`.

## Debug Logger

`setDebugLogger` wires DAL logs into your app's logging system. The logger must
expose `db` and `error` functions; any additional arguments are ignored.

## SQL Grants Script

`setup-db-grants.sql` is parameterized. Example:

```bash
psql -v app_db=libreviews -v app_user=libreviews_user \
     -v test_db=libreviews_test -v test_user=libreviews_user \
     -f setup-db-grants.sql
```

## Core Building Blocks

- **DataAccessLayer (`src/lib/data-access-layer.ts`)** – Owns the shared `pg.Pool`, manages migrations, and keeps a per-instance `ModelRegistry` so constructors are isolated between DALs (useful for fixtures/tests).
- **Model runtime (`src/lib/model.ts`)** – Implements camelCase ↔︎ snake_case mapping, validation/default handling, change tracking, and persistence primitives consumed by every manifest-driven model.
- **Manifest system (`src/lib/create-model.ts`, `src/lib/model-manifest.ts`)** – Declarative manifests define schema, relations, revision support, and custom methods. `defineModel` returns a lazy proxy constructor whose types are inferred from the manifest.
- **Query builder (`src/lib/query-builder.ts`)** – Builds SQL fragments for predicates, joins, ordering, pagination, and deletes. `filterWhere` wraps it with typed predicates for day-to-day usage.
  - Chainables include `orderBy/limit/offset`, `whereIn`, `getJoin` (auto-selects inline or batch join based on cardinality; a to-one relation whose table is already in the query, such as a second relation to the same table, is batch-loaded). A relation's `_apply: qb => …` callback can filter (`filterWhere`), sort (`orderBy`/`asc`/`desc`), drop fields (`without`) and `limit` the related records per parent row, `whereRelated` (predicate on a related table via manifest metadata), and `chronologicalFeed` for date-backed limit+1 pagination.
- **Revision helpers (`src/lib/revision.ts`)** – Adds static/instance helpers (`createFirstRevision`, `newRevision`, etc.) to models flagged with `hasRevisions: true`.
- **Type helpers (`src/lib/type.ts`)** – Fluent schema builders that feed manifest inference, including virtual field descriptors and multilingual string support via `mlString`.
