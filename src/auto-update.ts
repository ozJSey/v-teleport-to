/**
 * Shared `autoUpdate` observer machinery.
 *
 * `ResizeObserver` + `IntersectionObserver` track layout changes that don't
 * bubble through `scroll` / `resize` — content reflow, image lazy-load,
 * sibling insertion, reference visibility flips. Both observers fan out to
 * the supplied `trigger` callback which the caller routes through the same
 * RAF-batched recalc path used by the scroll/resize listeners.
 *
 * Both the directive and the composable consume this module so the setup +
 * teardown semantics stay identical.
 */

import { toValue } from 'vue'
import { isVirtualReference } from './calculate-position'
import type { TeleportToOptions } from './types'

/** Per-instance observer bag. `null`s mean "not observing right now". */
export type AutoUpdateObservers = {
  resizeObserver: ResizeObserver | null
  intersectionObserver: IntersectionObserver | null
  mutationObserver: MutationObserver | null
  observedToEl: HTMLElement | null
  /**
   * Cached `subtree` value last passed to the `MutationObserver` for the
   * currently-observed element. Used to detect mid-life flips of
   * `autoUpdateSubtree` and re-attach the MO with the new setting (the same
   * element with a different subtree flag would otherwise short-circuit on the
   * `observedToEl === toEl` no-op branch).
   */
  observedSubtree: boolean
}

/** Construct a fresh empty bag. Caller stores it on its state object. */
export function createObservers(): AutoUpdateObservers {
  return {
    resizeObserver: null,
    intersectionObserver: null,
    mutationObserver: null,
    observedToEl: null,
    observedSubtree: false,
  }
}

/** Disconnect all observers and clear the observed-element pointer. */
export function disconnectObservers(bag: AutoUpdateObservers): void {
  if (bag.resizeObserver) {
    bag.resizeObserver.disconnect()
    bag.resizeObserver = null
  }
  if (bag.intersectionObserver) {
    bag.intersectionObserver.disconnect()
    bag.intersectionObserver = null
  }
  if (bag.mutationObserver) {
    bag.mutationObserver.disconnect()
    bag.mutationObserver = null
  }
  bag.observedToEl = null
  bag.observedSubtree = false
}

/**
 * Idempotently sync the auto-update observers with the current options.
 *
 * Behavior matrix:
 *   - `autoUpdate` is falsy → disconnect (if previously attached) and return.
 *   - `to` resolves to `null`/disconnected → disconnect and return.
 *   - Same element already observed → no-op (avoids re-observing every tick).
 *   - Different/new element resolved → disconnect prior, observe new.
 *
 * Gracefully no-ops when the host environment lacks `ResizeObserver` or
 * `IntersectionObserver` (very old browsers, SSR, certain test environments)
 * — the consumer's existing `scroll` / `resize` listeners still drive recalcs.
 *
 * @param bag       the per-instance observer bag (mutated in place)
 * @param opts      the latest options
 * @param trigger   callback invoked when either observer fires; callers route
 *                  this through their RAF-batched `scheduleUpdate` so multiple
 *                  observer callbacks within a frame collapse into one recalc
 */
export function syncObservers(
  bag: AutoUpdateObservers,
  opts: TeleportToOptions,
  trigger: () => void,
): void {
  if (!opts.autoUpdate || opts.enabled === false) {
    disconnectObservers(bag)
    return
  }

  const toRef = toValue(opts.to) ?? null
  // Virtual references (synthetic rects with no DOM node) cannot be observed —
  // ResizeObserver / IntersectionObserver / MutationObserver all require an
  // `Element`. Drop any prior subscription and bail out; the consumer drives
  // recalcs by calling `update()` or by mutating the bound options.
  if (!toRef || isVirtualReference(toRef)) {
    disconnectObservers(bag)
    return
  }
  const toEl = toRef as HTMLElement
  if (!toEl.isConnected) {
    disconnectObservers(bag)
    return
  }

  const wantSubtree = !!opts.autoUpdateSubtree

  // Already observing this exact element with the same subtree setting — no-op.
  // A subtree flip on the same element falls through and re-attaches all
  // observers (RO/IO are re-created too — cheap, and keeps the code simple).
  if (bag.observedToEl === toEl && bag.observedSubtree === wantSubtree) return

  // Different element (or first-time attach) — drop any prior subscription.
  disconnectObservers(bag)

  // Feature-detect each observer independently so partial environments
  // (e.g. older Safari with RO but no IO support) still get the half they have.
  const ROCtor = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null
  const IOCtor = typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : null
  const MOCtor = typeof MutationObserver !== 'undefined' ? MutationObserver : null

  if (ROCtor) {
    const ro = new ROCtor(() => trigger())
    ro.observe(toEl)
    bag.resizeObserver = ro
  }

  if (IOCtor) {
    const root = opts.boundary && opts.boundary !== 'viewport' && opts.boundary.isConnected
      ? opts.boundary
      : null
    const io = new IOCtor(() => trigger(), { root })
    io.observe(toEl)
    bag.intersectionObserver = io
  }

  if (MOCtor) {
    // `MutationObserver` catches layout-affecting mutations that don't bubble
    // through `scroll`/`resize` and that `ResizeObserver` may miss when the
    // bounding box stays the same but the visible content shifts (e.g. a
    // class flip that swaps a CSS variable, a child's text mutation). The
    // attribute filter is scoped to `style` + `class` to avoid trampoline
    // loops on unrelated attribute writes (e.g. `aria-*`, `data-*`).
    const mo = new MOCtor(() => trigger())
    mo.observe(toEl, {
      attributes: true,
      attributeFilter: ['style', 'class'],
      childList: true,
      characterData: true,
      subtree: wantSubtree,
    })
    bag.mutationObserver = mo
  }

  // Track only when at least one observer attached. If no constructors
  // exist we leave `observedToEl` null so a subsequent `syncObservers` call
  // (e.g. after a polyfill loads) re-attempts attachment.
  if (bag.resizeObserver || bag.intersectionObserver || bag.mutationObserver) {
    bag.observedToEl = toEl
    bag.observedSubtree = wantSubtree
  }
}
