/**
 * Vue 3 directive lifecycle hooks for v-teleport-to.
 *
 * `mounted` — registers listeners and runs first calculation. It registers
 *   state unconditionally, even without a `to`: a template ref resolves one
 *   render AFTER the directive first sees it, and an element that skipped
 *   registration could never be revived by `updated`.
 * `updated` — picks up new option values and re-positions.
 * `unmounted` — tears down listeners and pending RAF.
 */

import { type Directive } from 'vue'
import { syncObservers } from './auto-update'
import { calculatePosition, releaseHide } from './calculate-position'
import { invokePlacementChange } from './placement-change'
import { scheduleUpdate, stateMap } from './schedule-update'
import {
  diffScrollTargets,
  resolveScrollTargets,
  SCROLL_LISTENER_OPTIONS,
  SCROLL_REMOVE_OPTIONS,
} from './scroll-target'
import type { DirectiveState, TeleportToOptions } from './types'
import { warnMissingTo } from './warn-missing-to'

export const vTeleportTo: Directive<HTMLElement, TeleportToOptions> = {
  mounted(el, binding) {
    const opts = binding.value

    const resizeHandler = () => scheduleUpdate(el)
    const scrollHandler = () => scheduleUpdate(el)

    // A host with no reference has nothing to track, so it subscribes to
    // nothing: `scroll` fires on every frame of every scroll and the handler
    // could only ever no-op. The first `updated` carrying a real `to` resolves
    // the real target set and the diff below attaches it — no special case
    // needed there, an empty starting set makes every target an addition.
    const scrollTargets = opts.to ? resolveScrollTargets(opts) : []

    const state: DirectiveState = {
      resizeHandler,
      scrollHandler,
      rafId: null,
      options: opts,
      prevPlacement: null,
      resizeObserver: null,
      intersectionObserver: null,
      mutationObserver: null,
      observedToEl: null,
      observedSubtree: false,
      scrollTargets,
    }
    stateMap.set(el, state)

    window.addEventListener('resize', resizeHandler, { passive: true })
    // Capture-phase to catch scroll on nested scroll containers.
    for (const target of scrollTargets) {
      target.addEventListener('scroll', scrollHandler, SCROLL_LISTENER_OPTIONS)
    }

    if (opts.to && opts.enabled !== false) {
      const detail = calculatePosition(el, opts)
      if (detail) {
        invokePlacementChange(opts, state.prevPlacement, detail.placement)
        state.prevPlacement = detail.placement
      }
    } else {
      // Mounted dormant — either disabled, or `to` has not resolved yet (the
      // normal template-ref case). No calc fires, but the listeners above are
      // already attached and `state` is registered, so the `updated` that
      // follows the ref assignment positions the host for real.
      el.dataset.teleportState = 'closed'
      // Only report a `to` that never arrives — see `warn-missing-to`.
      if (!opts.to) warnMissingTo(el)
    }

    // Attach `autoUpdate` observers AFTER the first calculation so the
    // initial position is set before any observer-driven recalc fires.
    syncObservers(state, opts, () => scheduleUpdate(el))
  },

  updated(el, binding) {
    const opts = binding.value
    const state = stateMap.get(el)
    if (!state) return

    state.options = opts

    // If the consumer changed `scrollContainer` between renders, diff the
    // attached set against the next resolved set so retained targets are not
    // disturbed (no spurious detach+attach cycle on still-active listeners).
    // The resize listener is unaffected (always lives on `window`).
    const nextScrollTargets = resolveScrollTargets(opts)
    const { toAdd, toRemove } = diffScrollTargets(state.scrollTargets, nextScrollTargets)
    for (const t of toRemove) {
      t.removeEventListener('scroll', state.scrollHandler, SCROLL_REMOVE_OPTIONS)
    }
    for (const t of toAdd) {
      t.addEventListener('scroll', state.scrollHandler, SCROLL_LISTENER_OPTIONS)
    }
    state.scrollTargets = nextScrollTargets

    if (!opts.to || opts.enabled === false) {
      // Clear the placement signal so consumer CSS does not keep reacting to
      // a stale value while the directive is dormant. Same for the arrow
      // CSS variables — leaving them set would leak stale geometry.
      delete el.dataset.teleportPlacement
      delete el.dataset.teleportFit
      el.style.removeProperty('--teleport-arrow-x')
      el.style.removeProperty('--teleport-arrow-y')
      // Release a hide this directive applied. Going dormant never runs a
      // calculation, so without this the host stays hidden forever — there is
      // no later tick to un-hide it.
      releaseHide(el)
      // Surface dormant state for consumer CSS open/close animations.
      el.dataset.teleportState = 'closed'
      // Reset the previous-placement cache so the next successful tick fires
      // `onPlacementChange` with `prev: null` again — re-enabling is treated
      // as a fresh placement transition.
      state.prevPlacement = null
      // Drop any auto-update observers — disabled directive should not keep
      // observers alive on an element it no longer tracks.
      syncObservers(state, opts, () => scheduleUpdate(el))
      return
    }
    const detail = calculatePosition(el, opts)
    if (detail) {
      invokePlacementChange(opts, state.prevPlacement, detail.placement)
      state.prevPlacement = detail.placement
    } else {
      // `to` resolved to a detached/null element mid-life; reset cache.
      state.prevPlacement = null
    }
    // Re-sync observers — picks up `autoUpdate` toggles and `to` changes.
    // No-op when the resolved element is the same as the currently observed
    // one, so steady-state updates stay cheap.
    syncObservers(state, opts, () => scheduleUpdate(el))
  },

  unmounted(el) {
    const state = stateMap.get(el)
    if (!state) return

    window.removeEventListener('resize', state.resizeHandler)
    for (const t of state.scrollTargets) {
      t.removeEventListener('scroll', state.scrollHandler, SCROLL_REMOVE_OPTIONS)
    }
    state.scrollTargets = []

    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId)
    }

    // Disconnect auto-update observers if any were attached.
    if (state.resizeObserver) {
      state.resizeObserver.disconnect()
      state.resizeObserver = null
    }
    if (state.intersectionObserver) {
      state.intersectionObserver.disconnect()
      state.intersectionObserver = null
    }
    if (state.mutationObserver) {
      state.mutationObserver.disconnect()
      state.mutationObserver = null
    }
    state.observedToEl = null
    state.observedSubtree = false

    stateMap.delete(el)
  },
}
