import createDataAccessLayer, { DataAccessLayer } from '../../src/index.js';
import {
  defineModel,
  defineStaticMethods,
  type ManifestModel,
} from '../../src/lib/create-model.js';
import { referenceModel } from '../../src/lib/model-handle.js';
import type {
  InferConstructor,
  InferInstance,
  ModelManifest,
} from '../../src/lib/model-manifest.js';
import type {
  DataAccessLayer as DataAccessLayerContract,
  JsonObject,
  ModelConstructor,
} from '../../src/lib/model-types.js';
import types from '../../src/lib/type.js';
import type { Equal, Expect, IsAssignable, Not } from './type-helpers.js';

const userManifest = {
  tableName: 'users',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4).required(),
    displayName: types.string().required(),
    email: types.string(),
    teamId: types.string(),
    // Literal virtual marker: see projection.types.ts.
    urlName: { isVirtual: true as const, validate: () => '' },
  },
  camelToSnake: { displayName: 'display_name', teamId: 'team_id' },
  relations: [
    {
      name: 'team',
      targetTable: 'teams',
      sourceKey: 'teamId',
      targetKey: 'id',
      cardinality: 'one',
    },
  ],
  staticMethods: {
    async findByEmail(email: string): Promise<string | null> {
      return email;
    },
  },
  instanceMethods: {
    label(): string {
      return this.displayName;
    },
  },
} as const satisfies ModelManifest;

const pageManifest = {
  tableName: 'pages',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4).required(),
    title: types.string(),
  },
} as const satisfies ModelManifest;

declare const concreteDal: DataAccessLayer;
declare const structuralDal: DataAccessLayerContract;
const factoryDal = createDataAccessLayer();

// --- Manifest overload ------------------------------------------------------

const User = concreteDal.getModel(userManifest);
type _concreteUser = Expect<Equal<typeof User, InferConstructor<typeof userManifest>>>;
const FactoryUser = factoryDal.getModel(userManifest);
type _factoryUser = Expect<Equal<typeof FactoryUser, typeof User>>;
const StructuralUser = structuralDal.getModel(userManifest);
type _structuralCall = Expect<Equal<typeof StructuralUser, typeof User>>;

// Filters accept mapped public names and reject unknown fields.
User.filterWhere({ displayName: 'Ada' });
// @ts-expect-error Unknown filter fields are rejected
User.filterWhere({ display_name: 'Ada' });
User.filterWhere({}).whereIn('id', ['a']);
// @ts-expect-error Unknown whereIn fields are rejected
User.filterWhere({}).whereIn('missing', ['a']);

// Relation keys come from the manifest.
User.filterWhere({}).getJoin({ team: true });
// @ts-expect-error Unknown relations are rejected
User.filterWhere({}).getJoin({ owner: true });

// Projections are typed and exclude unselected fields.
const projected = User.filterWhere({}).select('id', 'displayName');
type ProjectedRow = Awaited<typeof projected>[number];
type _projectedKeys = Expect<Equal<keyof ProjectedRow, 'id' | 'displayName'>>;
type _projectedName = Expect<Equal<ProjectedRow['displayName'], string>>;
declare const projectedRow: ProjectedRow;
// @ts-expect-error Unselected fields are unavailable
projectedRow.email;
// @ts-expect-error Virtual fields cannot be projected
User.filterWhere({}).select('urlName');

// Strict nullability follows the schema.
type UserInstance = InferInstance<typeof userManifest>;
type _requiredId = Expect<Equal<UserInstance['id'], string>>;
type _optionalEmail = Expect<Equal<UserInstance['email'], string | null | undefined>>;

// Inline manifest methods are typed.
type _staticMethod = Expect<Equal<ReturnType<typeof User.findByEmail>, Promise<string | null>>>;
type _instanceMethod = Expect<Equal<ReturnType<UserInstance['label']>, string>>;

// Revision APIs only exist on revisioned manifests.
const Page = structuralDal.getModel(pageManifest);
type _pageConstructor = Expect<Equal<typeof Page, InferConstructor<typeof pageManifest>>>;
Page.filterWhere({}).getAllRevisions('id');
Page.filterWhere({}).select('id', '_revID');
Page.createFirstRevision({ id: 'user' });
// @ts-expect-error Revision metadata is unavailable on non-revisioned models
User.filterWhere({}).select('_revID');

// --- Handle and constructor overload ---------------------------------------

const methodFreeManifest = {
  tableName: 'teams',
  hasRevisions: false as const,
  schema: {
    id: types.string().required(),
    name: types.string(),
  },
} as const satisfies ModelManifest;

const teamStaticMethods = defineStaticMethods(methodFreeManifest, {
  async findByName(name: string): Promise<string | null> {
    return name;
  },
});

const TeamHandle = defineModel(methodFreeManifest, {
  staticMethods: teamStaticMethods,
  statics: { label: 'Team' as const },
});

// Handles and constructors return their own type.
const Team = concreteDal.getModel(TeamHandle);
type _team = Expect<Equal<typeof Team, typeof TeamHandle>>;
const StructuralTeam = structuralDal.getModel(TeamHandle);
type _structuralTeam = Expect<Equal<typeof StructuralTeam, typeof Team>>;

// Methods supplied to defineModel() options are attached to the registered
// constructor, so the handle form keeps them.
type _handleStatic = Expect<Equal<ReturnType<typeof Team.findByName>, Promise<string | null>>>;
Team.filterWhere({ name: 'core' });
// @ts-expect-error Handle lookups still reject unknown fields
Team.filterWhere({ missing: 'x' });

// Known limitation: `statics` live only on the handle proxy, but the handle's
// type includes them, so the result type does too.
type _handleOnlyStatic = Expect<Equal<typeof Team.label, 'Team'>>;

// The manifest form cannot see methods supplied separately to defineModel().
const TeamFromManifest = concreteDal.getModel(methodFreeManifest);
type _manifestLacksMethod = Expect<
  Not<IsAssignable<typeof TeamFromManifest, { findByName: unknown }>>
>;

// referenceModel() handles return their own type.
const TeamReference = referenceModel(methodFreeManifest);
const ReferencedTeam = structuralDal.getModel(TeamReference);
type _referenceType = Expect<
  Equal<typeof ReferencedTeam, InferConstructor<typeof methodFreeManifest>>
>;

// Handles cast to a ManifestModel type, including the documented cast of a
// method-free reference to a type with methods, are typed like the cast.
type TeamModel = ManifestModel<typeof methodFreeManifest, typeof teamStaticMethods>;
const castTeamReference = referenceModel(methodFreeManifest) as TeamModel;
const CastTeam = concreteDal.getModel(castTeamReference);
type _castTeam = Expect<Equal<typeof CastTeam, TeamModel>>;
const StructuralCastTeam = structuralDal.getModel(castTeamReference);
type _structuralCastTeam = Expect<Equal<typeof StructuralCastTeam, TeamModel>>;
CastTeam.findByName('core');
// @ts-expect-error Constructor lookups still reject unknown fields
CastTeam.filterWhere({ missing: 'x' });

// A constructor resolved from one DAL can be re-resolved on another.
const TeamOnOtherDal = structuralDal.getModel(Team);
type _teamOnOtherDal = Expect<Equal<typeof TeamOnOtherDal, typeof Team>>;

// --- String overload --------------------------------------------------------

interface LegacyRecord extends JsonObject {
  id: string;
}

const Untyped = concreteDal.getModel('users');
type _untyped = Expect<Equal<typeof Untyped, ModelConstructor<JsonObject, JsonObject>>>;
const Legacy = concreteDal.getModel<LegacyRecord>('users');
type _legacy = Expect<Equal<typeof Legacy, ModelConstructor<LegacyRecord, JsonObject>>>;
const StructuralLegacy = structuralDal.getModel<LegacyRecord, JsonObject, 'team'>('users');
type _structuralLegacy = Expect<
  IsAssignable<typeof StructuralLegacy, ModelConstructor<LegacyRecord, JsonObject>>
>;

// @ts-expect-error Non-model arguments are rejected
concreteDal.getModel(42);
// @ts-expect-error Objects without a manifest shape are rejected
structuralDal.getModel({ tableName: 'users' });
