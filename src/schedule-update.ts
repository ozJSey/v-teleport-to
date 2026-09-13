/**
 * RAF-batched update scheduler.
 *
 * Multiple scroll/resize events within a frame collapse into a single
 * `calculatePosition` call to avoid layout thrashing.
 */

import { calculatePosition } from './calculate-position'
import { invokePlacementChange } from './placement-change'
import type { DirectiveState } from './types'

/** WeakMap so that GC of host elements also cleans up state automatically. */
export const stateMap = new WeakMap<HTMLElement, DirectiveState>()

export function scheduleUpdate(el: HTMLElement): void {
  const state = stateMap.get(el)
  if (!state) return
  if (state.rafId !== null) return // already scheduled this frame

  state.rafId = requestAnimationFrame(() => {
    state.rafId = null
    const current = stateMap.get(el)
    if (!current) return
    if (current.options.enabled === false) return
    const detail = calculatePosition(el, current.options)
    if (detail) {
      invokePlacementChange(current.options, current.prevPlacement, detail.placement)
      current.prevPlacement = detail.placement
    } else {
      // `to` resolved to a detached/null element this tick — reset cache so
      // the next successful tick fires `onPlacementChange` with `prev: null`.
      current.prevPlacement = null
    }
  })
}
