/**
 * Placement resolution — which side of the reference the host is put on.
 *
 * Split out of `calculate-position.ts` because it is the one decision in this
 * library with real semantics (everything else is arithmetic on rects), and
 * because it is worth reading and testing on its own: four numbers, a
 * preference, and one measurement in, a side and a verdict out. No DOM
 * mutation, no rect reads — `measureHostExtent` is the only function here that
 * touches an element, and the caller decides whether it is allowed to run.
 *
 * ## Fit-based, not comparative
 *
 * `flip: true` holds the side you asked for for as long as it works, and moves
 * only when it stops working. It is NOT "re-elect the roomier side every
 * tick": that made `placement: 'bottom'` + `flip` produce byte-identical
 * output to plain `placement: 'auto'` at every scroll offset (measured at
 * 1440×810: an 83px popover flipped to `top` with 438px of unused room below,
 * because the other side won by 2px), which made `flip` a synonym rather than
 * an option.
 *
 * When neither side fits there is no right answer, so the comparative rule is
 * kept as the fallback — the host still lands somewhere defined, and the
 * caller reports `fit: 'neither'` so the dead end is observable instead of
 * silently rendering a host clamped to nothing.
 *
 * ## The fit test runs on the DEFAULT, including `placement: 'auto'`
 *
 * It did not, and that was this library's worst bug. `'auto'` returned the
 * comparatively roomier side before the fit test could run, `flip` defaulted
 * to `false`, and so a bare `v-teleport-to="{ to: ref }"` — the binding nine
 * of twelve demo cards and almost every consumer actually ships — never once
 * asked whether the popover fitted where it was put. It was clamped to
 * whatever the chosen side had (down to `max-height: 0px`, a 366px menu
 * rendered as a 10px empty box) and `data-teleport-fit` was permanently
 * `'unmeasured'`, so the one diagnostic that names the dead end could never
 * fire on the configuration that needed it.
 *
 * `'auto'` now means "prefer the roomier side, then apply the fit ladder";
 * `flip` defaults to `true`. `flip: false` is the total opt-out — it pins the
 * requested side (or, for `'auto'`, the comparative one) and takes no
 * measurement at all.
 *
 * ## Two space records, because the edge buffer is a preference, not a wall
 *
 * `constants.ts` reserves `BUFFER_BOTTOM`/`BUFFER_TOP` px against the
 * boundary's edges so a popover does not slam into them. Those are ABSOLUTE
 * constants applied to whatever `boundary` is passed, so a 200px scroll pane
 * lost 150 of its 200px to a reserve sized for a viewport — and because the
 * same buffered number also clamped `max-height`, a host with 300px of real
 * room below was cut at 150px with no side to flip to that was any better.
 * That is what "when the teleported item is cut we don't flip it" looks like
 * from the inside: nothing to flip to, the room was taken by a constant.
 *
 * So the two questions get two records:
 *   - `spaces` (buffered) answers "which side would we RATHER use" — the
 *     comparative preference, and nothing else.
 *   - `rawSpaces` (unbuffered, boundary-clipped only) answers "does the host
 *     FIT", and is what the caller clamps `max-height` to. The reserve is
 *     given up rather than truncate content, on the same reasoning the
 *     horizontal axis has always used: no buffers, sit flush if you must.
 *
 * The fit test deliberately does not depend on how much of the buffer is
 * spent, because `measureHostExtent` returns a different number depending on
 * whether our own clamp is binding — an extent-dependent clamp oscillates
 * between the host's natural height and the consumer's `maxHeight` forever.
 */

import type { TeleportToFit, TeleportToSide } from './types'

/** Available space (px) on each side of the reference, boundary-clipped. */
export type SideSpaces = Record<TeleportToSide, number>

/** The other side of the same axis. */
export const OPPOSITE_SIDE: Record<TeleportToSide, TeleportToSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

export type PlacementDecision = {
  side: TeleportToSide
  fit: TeleportToFit
}

/**
 * Tolerance (px) for the "is our own `max-height` still holding the host
 * back?" comparison below. Two sources of noise sit between the number this
 * library writes and the number the browser reports back: CSSOM serializes an
 * inline length to ~6 significant digits (`87.34375px` reads back as
 * `87.3438px`), and engines quantize layout to a fraction of a pixel (1/64 in
 * Blink). A 1/16px window swallows both and is orders of magnitude below
 * anything a placement decision should turn on.
 */
const CLAMP_EPSILON = 0.0625

/**
 * The host's own extent along the axis being decided, or `null` when it cannot
 * be read — the honest answer for a host that has no laid-out box yet, is
 * `display: none`, or (for `useTeleportTo`) is simply not known to us. `null`
 * makes `resolvePlacement` fall back to the comparative rule; a `0` would be a
 * lie that says "fits anywhere", which is exactly how a popover ends up pinned
 * to a side with no room.
 *
 * ## The measurement has to be independent of the decision
 *
 * This function reads a host that this library also WRITES to, so a careless
 * source turns the fit test into a feedback loop: side → style → measurement →
 * side. Two such loops exist, and both are closed here rather than damped.
 * Each was found by driving playground demo 02 in a real browser, where the
 * loop surfaces as a Vue "Maximum recursive updates exceeded".
 *
 * **Not `scrollHeight`.** It would see through the `max-height` clamp, but its
 * scrolling area also counts absolutely-positioned descendants — and the most
 * common popover decoration there is, an arrow pinned with
 * `[data-teleport-placement="top"] ::after { bottom: -5px }`, moves from one
 * edge to the other with the decision. The host then measures ~5px taller on
 * one side than the other and the two sides take turns.
 *
 * **`getBoundingClientRect()`, not `offsetHeight`.** `offsetHeight` is rounded
 * to whole pixels, and that is not enough precision for the clamp test below:
 * a host that is naturally 39.531px tall reports `40`, indistinguishable from
 * one truncated at exactly `40px`. The two readings disagree about whether our
 * clamp is binding, so the host flips between them forever. The cost of the
 * rect is that a CSS `transform: scale()` scales it, so a host measured
 * mid-open-animation under-reports — a transient that self-corrects when the
 * animation settles, which is a far better failure than a livelock.
 *
 * **Seeing through our own `max-height`.** The clamp this library writes is
 * derived from the space on the CHOSEN side, so a host squeezed onto a cramped
 * side measures exactly as tall as that side and would report "fits" forever —
 * the silent 0px-popover failure, and it would make `fit: 'neither'` a signal
 * that survives one tick and then lies. The clamp is our own inline value, so
 * we can just ask whether the box has grown into it: if it has, the content
 * wants at least that much and possibly more, and what it can want is capped
 * by the consumer's own `maxHeight` — so `maxHeight` is the honest
 * requirement. That also keeps the answer stable, because "our clamp binds on
 * side X" is exactly "the content is taller than X can give it", which is a
 * property of the geometry rather than of where the host currently sits.
 *
 * **Horizontal (`'x'`).** Just the rect's width: the width this library writes
 * (`matchWidth` / `maxWidth` / `widthMultiplier`) does not depend on which side
 * was chosen, so there is no loop to close, and the host's box — not its
 * content — is what has to fit beside the reference.
 *
 * The one loop left open is a host whose own box size depends on the placement
 * it is given (content keyed on `data-teleport-placement` that changes the
 * host's height, rather than an absolutely-positioned decoration). That is the
 * consumer's to avoid, and it is called out in the README.
 *
 * `rect` is the caller's already-taken measurement. `calculate-position.ts`
 * reads the host's box exactly once per tick and hands the same rect to the
 * fit test and to the cross-axis/arrow math, so those two can never disagree
 * about how wide the host is — the disagreement that put the arrow on a
 * right-anchored host's corner. Omitting it takes the read here instead, which
 * is what the unit tests do.
 */
export function measureHostExtent(
  hostEl: HTMLElement | null | undefined,
  axis: 'x' | 'y',
  maxHeight: number,
  rect: DOMRect | null = hostEl ? hostEl.getBoundingClientRect() : null,
): number | null {
  if (!hostEl || !rect) return null
  if (axis === 'x') return rect.width > 0 ? rect.width : null
  // The `max-height` this library wrote on the previous tick (absent on the
  // first one). A box that has grown into it is a truncated box, and what the
  // content wants is then bounded only by the consumer's own ceiling.
  const applied = Number.parseFloat(hostEl.style.maxHeight)
  if (Number.isFinite(applied) && rect.height >= applied - CLAMP_EPSILON) return maxHeight
  return rect.height > 0 ? Math.min(rect.height, maxHeight) : null
}

/**
 * Pick the side.
 *
 * @param placement  the consumer's preference. `'auto'` names no side, so the
 *                   comparative rule supplies one and the fit ladder runs on
 *                   it exactly as it does on an explicit side.
 * @param spaces     BUFFERED space on each of the four sides — the reserved
 *                   edge buffers already subtracted. Preference only: this is
 *                   the record the comparative rule reads, and values may be
 *                   negative once the buffers are eaten.
 * @param rawSpaces  UNBUFFERED, boundary-clipped space on each side. This is
 *                   the room the host can actually occupy, so it is what the
 *                   fit test asks and what the caller clamps `max-height` to.
 * @param flip       whether flipping is enabled. Default `true` at the caller;
 *                   `false` pins the preferred side and skips the fit test.
 * @param hostExtent the host's extent along the preferred axis, or `null` when
 *                   it could not be measured (→ comparative fallback).
 */
export function resolvePlacement(
  placement: 'auto' | TeleportToSide,
  spaces: SideSpaces,
  rawSpaces: SideSpaces,
  flip: boolean,
  hostExtent: number | null,
): PlacementDecision {
  // The side we would rather use. An explicit `placement` names it; `'auto'`
  // derives it comparatively (vertical-only, ties going to `'bottom'`). From
  // here down the two are treated identically — that equality IS the fix.
  const preferred: TeleportToSide =
    placement === 'auto' ? (spaces.bottom >= spaces.top ? 'bottom' : 'top') : placement

  // `flip: false` is the total opt-out: the consumer wants this side held even
  // when the host is cut, so no measurement is consulted and none is needed.
  if (!flip) return { side: preferred, fit: 'unmeasured' }

  const opposite = OPPOSITE_SIDE[preferred]

  // No measurement → no fit answer, so keep the preferred side. It used to
  // degrade to the comparative rule, which was defensible while `flip` was
  // opt-in — you had asked for movement — but is not now that it is the
  // default: `placement: 'bottom'` on a host with no laid-out box (the first
  // tick, `display: none`, or `useTeleportTo` without a host) would silently
  // become `'top'` on the strength of no evidence at all. `'auto'` is
  // unaffected, its preferred side IS the comparative one. A `0` extent would
  // be a lie that says "fits anywhere", which is how a popover ends up pinned
  // to a side with no room, so it is reported as `null`, not as zero.
  if (hostExtent === null) return { side: preferred, fit: 'unmeasured' }

  // 1. The preferred side works. Stay, however much room the other side has.
  if (rawSpaces[preferred] >= hostExtent) return { side: preferred, fit: 'fits' }
  // 2. It does not, and the opposite side does. This is the flip.
  if (rawSpaces[opposite] >= hostExtent) return { side: opposite, fit: 'flipped' }
  // 3. Neither side can hold the host. Fall back to the comparative rule so
  //    the host still lands somewhere defined, and let the caller surface the
  //    verdict. Ties keep the preferred side.
  //
  //    Compared on RAW space, unlike the `'auto'` preference above. The two
  //    comparisons answer different questions: `'auto'` asks "which side would
  //    we rather open on", where reserving clearance against the boundary edge
  //    is a real preference; this asks "we are about to truncate the host —
  //    where does the consumer get to see the most of it", where spending room
  //    on blank clearance is indefensible. Comparing buffered here would pick
  //    the side with LESS visible content whenever the two buffers disagree.
  return {
    side: rawSpaces[preferred] >= rawSpaces[opposite] ? preferred : opposite,
    fit: 'neither',
  }
}
