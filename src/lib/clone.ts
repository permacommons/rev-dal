/**
 * Deep-copy a row value so the copy shares no mutable state with the
 * original, while keeping every type `pg` serializes differently:
 *
 * - primitives, `null`, `undefined` and functions are returned as-is
 * - `Date` → new `Date`; `Buffer` → new `Buffer`; other typed arrays and
 *   `DataView`s → copies of the same class
 * - arrays, `Map` and `Set` → new containers with copied contents
 * - other objects → a copy with the same prototype and copied own
 *   properties, so plain JSON objects stay plain and class instances keep
 *   methods such as `toJSON()` / `toPostgres()` that `pg` relies on
 *
 * `structuredClone` is not used because it turns a `Buffer` into a plain
 * `Uint8Array`, drops prototypes, and throws on functions.
 *
 * Cycles are preserved. Objects whose state lives in internal slots or
 * `#private` fields (other than the built-ins handled above) cannot be copied
 * faithfully by any generic routine; they don't come out of PostgreSQL rows.
 *
 * @param value Value to copy
 * @returns An independent copy of `value`
 */
export function cloneRowValue<T>(value: T): T {
  return cloneInner(value, new WeakMap()) as T;
}

function cloneInner(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    // Typed arrays and DataViews keep their concrete class
    return structuredClone(value);
  }

  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags);
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneInner(item, seen));
    }
    return copy;
  }

  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(cloneInner(key, seen), cloneInner(item, seen));
    }
    return copy;
  }

  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) {
      copy.add(cloneInner(item, seen));
    }
    return copy;
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      descriptor.value = cloneInner(descriptor.value, seen);
    }
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}
