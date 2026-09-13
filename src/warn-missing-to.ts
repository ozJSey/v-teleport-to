/**
 * Deferred "missing `to`" warning.
 *
 * A template ref is `null` during the render pass that reads it — Vue assigns
 * it while the elements mount, one render too late. So `<div v-teleport-to="{
 * to: trigger }">` ALWAYS reaches the directive's first `mounted` call with
 * `to: null`, even when the consumer wrote it correctly. Warning there fires on
 * every correct usage and says nothing about the one case worth reporting.
 *
 * Wait for the flush instead. Assigning the ref re-renders the component, so by
 * the time `nextTick` resolves `updated` has run and replaced `state.options`.
 * A `to` still missing at that point is a genuine mistake.
 *
 * `nextTick` rather than `requestAnimationFrame` deliberately: a frame handle
 * would be a second pending callback for `unmounted` to track and cancel, and
 * an uncancelled one outlives the host. A microtask owns no handle. Reading
 * through `stateMap` instead of closing over `opts` is the other half of that
 * — a host unmounted before the flush has no state, so it stays silent.
 */

import { nextTick } from 'vue'
import { stateMap } from './schedule-update'

export const MISSING_TO_MESSAGE = '[v-teleport-to] "to" reference element is required.'

export function warnMissingTo(el: HTMLElement): void {
  void nextTick(() => {
    const state = stateMap.get(el)
    // Unmounted before the flush landed, or the ref resolved on the re-render
    // that the assignment triggered — neither is worth a warning.
    if (!state || state.options.to) return
    console.warn(MISSING_TO_MESSAGE)
  })
}
