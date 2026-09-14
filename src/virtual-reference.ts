/**
 * The one question two modules have to answer the same way: is this thing a
 * real DOM element, or a `VirtualReference` — any object exposing
 * `getBoundingClientRect`?
 *
 * It lives alone because `auto-update.ts` needs it (an observer cannot be
 * attached to an object that is not a node) and so does
 * `calculate-position.ts` (a virtual reference has no `isConnected` to check).
 * Importing it from `calculate-position` was an upward edge in a dependency
 * graph `ARCHITECTURE.md` claims is strictly downward — the claim is now true
 * and `dependency-graph.test.ts` checks it.
 */

import type { VirtualReference } from './types'

/**
 * Type guard: distinguish a `VirtualReference` (any object with a
 * `getBoundingClientRect` method that is NOT a DOM `Node`) from a real
 * `HTMLElement`. DOM nodes carry a numeric `nodeType`; virtual references do
 * not.
 */
export function isVirtualReference(
  v: HTMLElement | VirtualReference | null | undefined,
): v is VirtualReference {
  return (
    !!v &&
    typeof (v as VirtualReference).getBoundingClientRect === 'function' &&
    typeof (v as Node).nodeType !== 'number'
  )
}
