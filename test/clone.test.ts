import assert from 'node:assert/strict';
import test from 'node:test';

import { cloneRowValue } from '../src/lib/clone.js';

test('cloneRowValue deep-copies plain JSON structures', () => {
  const original = { title: { en: 'A' }, list: [1, { x: 2 }], empty: null };
  const copy = cloneRowValue(original);

  assert.deepStrictEqual(copy, original);
  copy.title.en = 'B';
  (copy.list[1] as { x: number }).x = 3;
  copy.list.push(4);
  assert.deepStrictEqual(original, { title: { en: 'A' }, list: [1, { x: 2 }], empty: null });
  assert.strictEqual(Object.getPrototypeOf(copy), Object.prototype);
});

test('cloneRowValue keeps Date, Buffer and typed array types', () => {
  const date = new Date('2020-01-02T03:04:05.000Z');
  const buffer = Buffer.from('bytes');
  const typed = new Uint16Array([1, 2]);
  const copy = cloneRowValue({ date, buffer, typed });

  assert.ok(copy.date instanceof Date);
  assert.notStrictEqual(copy.date, date);
  assert.strictEqual(copy.date.getTime(), date.getTime());
  copy.date.setUTCFullYear(1999);
  assert.strictEqual(date.getUTCFullYear(), 2020);

  assert.ok(Buffer.isBuffer(copy.buffer), 'Buffer stays a Buffer');
  copy.buffer[0] = 0;
  assert.strictEqual(buffer.toString(), 'bytes');

  assert.ok(copy.typed instanceof Uint16Array);
  copy.typed[0] = 9;
  assert.strictEqual(typed[0], 1);
});

test('cloneRowValue keeps class prototypes so pg serialization is unchanged', () => {
  class Point {
    constructor(
      public x: number,
      public y: number
    ) {}
    toPostgres() {
      return `(${this.x},${this.y})`;
    }
    toJSON() {
      return { point: [this.x, this.y] };
    }
  }
  const original = { location: new Point(1, 2) };
  const copy = cloneRowValue(original);

  assert.ok(copy.location instanceof Point);
  assert.strictEqual(copy.location.toPostgres(), '(1,2)');
  assert.strictEqual(JSON.stringify(copy), JSON.stringify(original));
  copy.location.x = 5;
  assert.strictEqual(original.location.x, 1);
});

test('cloneRowValue handles Map, Set, null-prototype objects and cycles', () => {
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
  const node: Record<string, unknown> = { name: 'n' };
  node.self = node;
  const original = { map: new Map([['k', { v: 1 }]]), set: new Set([[1]]), bare, node };
  const copy = cloneRowValue(original);

  assert.notStrictEqual(copy.map.get('k'), original.map.get('k'));
  assert.deepStrictEqual(copy.map.get('k'), { v: 1 });
  assert.notStrictEqual([...copy.set][0], [...original.set][0]);
  assert.strictEqual(Object.getPrototypeOf(copy.bare), null);
  assert.strictEqual(copy.node.self, copy.node, 'cycle points at the copy');
  assert.notStrictEqual(copy.node, original.node);
});

test('cloneRowValue returns primitives and functions as-is', () => {
  const fn = () => 1;
  assert.strictEqual(cloneRowValue(fn), fn);
  assert.strictEqual(cloneRowValue('s'), 's');
  assert.strictEqual(cloneRowValue(undefined), undefined);
  assert.strictEqual(cloneRowValue(null), null);
});
