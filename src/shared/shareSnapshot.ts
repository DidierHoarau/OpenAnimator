/**
 * Structural-sharing snapshots for the undo stack. `shareSnapshot(live,
 * previous)` returns a snapshot of `live` that reuses `previous`'s subtrees
 * wherever they are deep-equal to the live ones: an edit only pays memory
 * for the objects along the changed path, while the hundred undo steps keep
 * the exact behavior of full `structuredClone` snapshots.
 *
 * Two invariants make the sharing safe:
 * - the result never aliases any object owned by `live` — every returned
 *   object is either freshly built here or owned by `previous` (a snapshot,
 *   which is never the live document because installs clone), so a later
 *   in-place mutation of the live document cannot corrupt history;
 * - deep equality is decided against the *snapshot* side, never between two
 *   stack entries, so snapshot-owned objects are only ever shared, never
 *   mutated.
 */

/** Deep equality over plain JSON-shaped data (objects, arrays, primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    const left = a as unknown[]
    const right = b as unknown[]
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (!deepEqual(left[i], right[i])) return false
    }
    return true
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!deepEqual(left[key], right[key])) return false
  }
  return true
}

/** Fresh copy of one object's own enumerable keys. `__proto__` goes through
 * `defineProperty` so a data key with that name cannot rewrite the
 * prototype of the snapshot (JSON.parse can legitimately produce it). */
function copyObject(
  live: Record<string, unknown>,
  previous: Record<string, unknown> | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(live)) {
    const value = shareValue(live[key], previous ? previous[key] : null)
    if (key === '__proto__') {
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
    } else {
      out[key] = value
    }
  }
  return out
}

function shareValue(live: unknown, previous: unknown): unknown {
  if (previous !== null && previous !== undefined && deepEqual(live, previous)) return previous
  if (Array.isArray(live)) {
    const priorArray = Array.isArray(previous) ? previous : null
    return live.map((entry, index) =>
      shareValue(entry, priorArray && index < priorArray.length ? priorArray[index] : null)
    )
  }
  if (typeof live === 'object' && live !== null) {
    const priorObject =
      previous !== null && typeof previous === 'object' && !Array.isArray(previous)
        ? (previous as Record<string, unknown>)
        : null
    return copyObject(live as Record<string, unknown>, priorObject)
  }
  return live
}

/**
 * Snapshots `live`, reusing `previous`'s deep-equal subtrees by reference.
 * `previous === null` produces a full copy (the first stack entry). The
 * result deep-equals `structuredClone(live)` — sharing is observable only
 * through reference identity, never through values.
 */
export function shareSnapshot<T>(live: T, previous: T | null): T {
  return shareValue(live, previous) as T
}
