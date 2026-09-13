/**
 * Resolves the set of `scroll` event targets from `opts.scrollContainer`.
 *
 * Returns an array so a single resolution path covers all three input shapes:
 *   - omitted / `'window'` → `[window]`
 *   - single `HTMLElement` (connected) → `[element]`
 *   - single `HTMLElement` (detached) → `[window]` (back-compat fallback)
 *   - `HTMLElement[]` → connected entries only; detached entries are silently
 *     skipped and there is NO fallback to `window` — the consumer
 *     enumerated the targets, so an empty resolution is the consumer's
 *     choice (host will rely on `resize` / observers / manual `update()`).
 *
 * …and then `window` is unioned in unless the consumer opted out of hiding.
 * See `WINDOW_FLOOR` below.
 *
 * Both the directive and the composable share this helper to keep the
 * resolution semantics identical.
 */

import type { TeleportToOptions } from './types'

/**
 * ## The window-listener floor
 *
 * Naming a `scrollContainer` *replaces* the window listener, which was a fair
 * trade while hiding was opt-in. It stops being one once
 * `hideWhenReferenceHidden` defaults to `true`: narrow the container, scroll
 * the PAGE, and the reference leaves the viewport with no listener left to
 * notice — the host stays painted with nothing to anchor to. A default-on
 * behaviour that silently fails on a documented configuration is worse than
 * no default at all, so `window` becomes a floor rather than an alternative.
 *
 * Precedent: `resize` is already unconditionally on `window` and exempt from
 * `scrollContainer` for the same reason.
 *
 * The opt-out is total. `hideWhenReferenceHidden: false` attaches exactly the
 * targets the consumer named and nothing else — including the empty-array
 * case, which stays empty.
 *
 * Note the listener is capture-phase (see `SCROLL_LISTENER_OPTIONS`), so the
 * window listener already sees scrolls on nested containers; the floor is
 * additive in cost only when the consumer had narrowed away from it.
 */
export function resolveScrollTargets(opts: TeleportToOptions): EventTarget[] {
  const sc = opts.scrollContainer
  const targets: EventTarget[] = []

  if (Array.isArray(sc)) {
    // Connected entries only; no fallback to window — consumer is explicit.
    for (const entry of sc) {
      if (entry && typeof entry !== 'string' && entry.isConnected) {
        targets.push(entry)
      }
    }
  } else if (sc && sc !== 'window' && typeof sc !== 'string' && sc.isConnected) {
    targets.push(sc)
  } else {
    targets.push(window)
  }

  // The floor. `includes` rather than an unconditional push so the common
  // case (no `scrollContainer`) still attaches exactly one listener.
  if (opts.hideWhenReferenceHidden !== false && !targets.includes(window)) {
    targets.push(window)
  }

  return targets
}

/**
 * Diffs a previous set of attached scroll targets against a next set so the
 * caller can attach to additions and detach from removals without disturbing
 * targets that are present in both. Operates on identity (same object).
 */
export function diffScrollTargets(
  prev: EventTarget[],
  next: EventTarget[],
): { toAdd: EventTarget[]; toRemove: EventTarget[] } {
  const toAdd: EventTarget[] = []
  const toRemove: EventTarget[] = []
  for (const t of next) {
    if (!prev.includes(t)) toAdd.push(t)
  }
  for (const t of prev) {
    if (!next.includes(t)) toRemove.push(t)
  }
  return { toAdd, toRemove }
}

/** Capture phase + passive — same options used at attach and detach sites. */
export const SCROLL_LISTENER_OPTIONS: AddEventListenerOptions = {
  capture: true,
  passive: true,
}

/** Matching options object for `removeEventListener` (capture flag is what matters). */
export const SCROLL_REMOVE_OPTIONS: EventListenerOptions = { capture: true }
