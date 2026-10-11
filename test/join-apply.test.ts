import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import type { JsonObject } from '../src/lib/model-types.js';
import types from '../src/lib/type.js';
import type { PostgresFixture } from './helpers/postgres-fixture.js';
import { createPostgresFixture } from './helpers/postgres-fixture.js';

/**
 * Regression tests for batch-loaded joins and their `_apply` callbacks: the
 * callback is run (so variables work), every call is honored, `limit()` is
 * per parent, and sensitive fields stay out of batch-loaded rows.
 */

type Row = JsonObject & { id: string; _data: Record<string, unknown> };
type Author = Row & { posts?: Row[]; groups?: Row[] };
type Post = Row & { author?: Row | null };
type Query<T> = { getJoin(spec: JsonObject): Query<T>; run(): Promise<T[]> };
type Model<T> = {
  filterWhere(literal: JsonObject): Query<T>;
  loadManyRelated(relation: string, ids: string[]): Promise<Map<string, Row[]>>;
};

let fixture: PostgresFixture;
let Authors: Model<Author>;
let Posts: Model<Post>;
const authorIds = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
const groupIds = { G1: randomUUID(), G2: randomUUID(), G3: randomUUID() };

const titles = (rows: Row[] | undefined) => (rows ?? []).map(row => row._data.title);
const loadAuthor = async (key: keyof typeof authorIds, apply: unknown, relation = 'posts') => {
  const [author] = await Authors.filterWhere({ id: authorIds[key] })
    .getJoin({ [relation]: { _apply: apply } })
    .run();
  return author;
};

before(async () => {
  fixture = await createPostgresFixture({
    schemaPrefix: 'rev_dal_join_apply',
    tableDefs: [
      {
        name: 'authors',
        create: (t: string) =>
          `CREATE TABLE ${t} (id UUID PRIMARY KEY, name TEXT, email TEXT, password TEXT)`,
      },
      {
        name: 'posts',
        create: (t: string) => `
          CREATE TABLE ${t} (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            author_id UUID,
            title TEXT,
            is_published BOOLEAN,
            created_on TIMESTAMPTZ,
            score INT
          )
        `,
      },
      {
        name: 'groups',
        create: (t: string) => `CREATE TABLE ${t} (id UUID PRIMARY KEY, name TEXT, secret TEXT)`,
      },
      {
        name: 'author_groups',
        create: (t: string) =>
          `CREATE TABLE ${t} (author_id UUID, group_id UUID, PRIMARY KEY (author_id, group_id))`,
      },
    ],
    modelDefs: [
      {
        name: 'authors',
        hasRevisions: false,
        schema: {
          id: types.string().uuid(4),
          name: types.string(),
          email: types.string().sensitive(),
          password: types.string().sensitive(),
        },
        options: {
          relations: [
            {
              name: 'posts',
              targetTable: 'posts',
              sourceColumn: 'id',
              targetColumn: 'author_id',
              cardinality: 'many',
            },
            {
              name: 'groups',
              targetTable: 'groups',
              cardinality: 'many',
              through: {
                table: 'author_groups',
                sourceForeignKey: 'author_id',
                targetForeignKey: 'group_id',
              },
            },
          ],
        },
      },
      {
        name: 'posts',
        hasRevisions: false,
        schema: {
          id: types.string().uuid(4),
          authorID: types.string(),
          title: types.string(),
          isPublished: types.boolean(),
          createdOn: types.date(),
          score: types.number(),
        },
        camelToSnake: {
          authorID: 'author_id',
          isPublished: 'is_published',
          createdOn: 'created_on',
        },
        options: {
          relations: [
            {
              name: 'author',
              targetTable: 'authors',
              sourceColumn: 'author_id',
              targetColumn: 'id',
              cardinality: 'one',
            },
          ],
        },
      },
      {
        name: 'groups',
        hasRevisions: false,
        schema: {
          id: types.string().uuid(4),
          name: types.string(),
          secret: types.string().sensitive(),
        },
      },
    ],
  });
  Authors = fixture.models.authors as unknown as Model<Author>;
  Posts = fixture.models.posts as unknown as Model<Post>;

  const table = (name: string) => fixture.getTableName(name);
  for (const [key, id] of Object.entries(authorIds)) {
    await fixture.dal.query(`INSERT INTO ${table('authors')} VALUES ($1, $2, $3, 'hash-secret')`, [
      id,
      `Author ${key}`,
      `${key.toLowerCase()}@example.com`,
    ]);
    // Three posts per author: n=1..3, newer with n; even n is unpublished
    for (let n = 1; n <= 3; n++) {
      await fixture.dal.query(
        `INSERT INTO ${table('posts')} (author_id, title, is_published, created_on, score)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, `${key}${n}`, n % 2 === 1, new Date(Date.UTC(2024, 0, n)), n]
      );
    }
  }
  for (const [name, id] of Object.entries(groupIds)) {
    await fixture.dal.query(`INSERT INTO ${table('groups')} VALUES ($1, $2, 'group-secret')`, [
      id,
      name,
    ]);
  }
  // A is in G1-G3, B in G2-G3, C in G3
  const memberships: Array<[keyof typeof authorIds, keyof typeof groupIds]> = [
    ['A', 'G1'],
    ['A', 'G2'],
    ['A', 'G3'],
    ['B', 'G2'],
    ['B', 'G3'],
    ['C', 'G3'],
  ];
  for (const [author, group] of memberships) {
    await fixture.dal.query(`INSERT INTO ${table('author_groups')} VALUES ($1, $2)`, [
      authorIds[author],
      groupIds[group],
    ]);
  }
});

after(async () => {
  if (fixture) {
    await fixture.cleanup();
  }
});

test('_apply filters use the values of variables the callback closes over', async () => {
  const wanted = 'A2';
  const author = await loadAuthor('A', (qb: any) => qb.filterWhere({ title: wanted }));
  assert.deepStrictEqual(titles(author.posts), ['A2']);
});

test('_apply honors every filter call, mapped field names, null and arrays', async () => {
  const published = await loadAuthor('A', (qb: any) =>
    qb.filterWhere({ isPublished: true }).filterWhere({ score: 3 })
  );
  assert.deepStrictEqual(titles(published.posts), ['A3']);

  const either = await loadAuthor('A', (qb: any) =>
    qb.filterWhere({ title: ['A1', 'A3'] }).orderBy('score')
  );
  assert.deepStrictEqual(titles(either.posts), ['A1', 'A3']);

  const none = await loadAuthor('A', (qb: any) => qb.filterWhere({ title: null }));
  assert.deepStrictEqual(titles(none.posts), []);
});

test('_apply ordering honors the direction', async () => {
  const newest = await loadAuthor('B', (qb: any) => qb.orderBy('createdOn', 'DESC'));
  assert.deepStrictEqual(titles(newest.posts), ['B3', 'B2', 'B1']);

  const byScore = await loadAuthor('B', (qb: any) => qb.desc('score'));
  assert.deepStrictEqual(titles(byScore.posts), ['B3', 'B2', 'B1']);

  const ascending = await loadAuthor('B', (qb: any) => qb.asc('score'));
  assert.deepStrictEqual(titles(ascending.posts), ['B1', 'B2', 'B3']);
});

test('_apply limit() applies per parent row', async () => {
  const authors = await Authors.filterWhere({})
    .getJoin({ posts: { _apply: (qb: any) => qb.orderBy('createdOn', 'DESC').limit(2) } })
    .run();

  const byName = Object.fromEntries(
    authors.map(author => [author._data.name, titles(author.posts)])
  );
  assert.deepStrictEqual(byName, {
    'Author A': ['A3', 'A2'],
    'Author B': ['B3', 'B2'],
    'Author C': ['C3', 'C2'],
  });
});

test('_apply limit() applies per parent row through a join table', async () => {
  const authors = await Authors.filterWhere({})
    .getJoin({ groups: { _apply: (qb: any) => qb.asc('name').limit(1) } })
    .run();

  const byName = Object.fromEntries(
    authors.map(author => [author._data.name, (author.groups ?? []).map(g => g._data.name)])
  );
  assert.deepStrictEqual(byName, {
    'Author A': ['G1'],
    'Author B': ['G2'],
    'Author C': ['G3'],
  });
});

test('_apply without() leaves the column out of the query', async () => {
  const author = await loadAuthor('C', (qb: any) => qb.without('title').asc('score'));
  const [first] = author.posts ?? [];
  assert.ok(first);
  assert.ok(!('title' in first._data), 'title is not loaded');
  assert.strictEqual(first._data.score, 1);
});

test('batch-loaded relations exclude sensitive fields', async () => {
  // An object spec forces the batch loader for this to-one relation
  const [post] = await Posts.filterWhere({ title: 'A1' }).getJoin({ author: {} }).run();
  assert.strictEqual(post.author?._data.name, 'Author A');
  assert.ok(!('email' in (post.author?._data ?? {})), 'email is not loaded');
  assert.ok(!('password' in (post.author?._data ?? {})), 'password is not loaded');

  const author = await loadAuthor('A', (qb: any) => qb.asc('name'), 'groups');
  assert.deepStrictEqual(
    (author.groups ?? []).map(group => group._data.name),
    ['G1', 'G2', 'G3']
  );
  assert.ok(
    (author.groups ?? []).every(group => !('secret' in group._data)),
    'secret is not loaded'
  );
});

test('loadManyRelated excludes sensitive fields', async () => {
  const groupsByAuthor = await Authors.loadManyRelated('groups', [authorIds.B]);
  const groups = groupsByAuthor.get(authorIds.B) ?? [];
  assert.deepStrictEqual(groups.map(group => group._data.name).sort(), ['G2', 'G3']);
  assert.ok(
    groups.every(group => !('secret' in group._data)),
    'secret is not loaded'
  );
});

test('_apply rejects what it cannot express instead of ignoring it', async () => {
  // run() reports these wrapped in a QueryError that keeps the message
  await assert.rejects(
    () => loadAuthor('A', (qb: any) => qb.filterWhere({ score: { gt: 1 } })),
    /unsupported value/
  );
  await assert.rejects(
    () => loadAuthor('A', (qb: any) => qb.orderBy('score', 'sideways')),
    /sort direction must be 'ASC' or 'DESC'/
  );
  await assert.rejects(
    () => loadAuthor('A', (qb: any) => qb.where({ score: 1 })),
    /qb\.where is not a function/,
    'unknown builder methods are not silently ignored'
  );
  await assert.rejects(
    () => loadAuthor('A', (qb: any) => qb.limit(-1)),
    /LIMIT must be a non-negative integer/
  );
});
