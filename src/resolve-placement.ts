/**
 * Placement resolution — which side of the reference the host goes on.
 *
 * Four numbers, a preference and one measurement in; a side and a verdict out.
 * No DOM: this module does not read or write an element, and since 1.1.0 it
 * does not own the measurement either — `measure-host.ts` does, because taking
 * that measurement correctly turned out to be the hard half of the problem.
 *
 * ## Fit-based, not comparative
 *
 * `flip` (default `true`) holds the side you asked for for as long as it
 * works, and moves only when it stops working. It is NOT "re-elect the roomier
 * side every tick": that made `placement: 'bottom'` + `flip` produce
 * byte-identical output to plain `placement: 'auto'` at every scroll offset
 * (measured at 1440×810: an 83px popover flipped to `top` with 438px of unused
 * room below, because the other side won by 2px), which made `flip` a synonym
 * rather than an option.
 *
 * When neither side fits there is no right answer, so the comparative rule is
 * the fallback — the host still lands somewhere defined, and `fit: 'neither'`
 * makes the dead end observable instead of silently rendering a clamped host.
 *
 * `'auto'` names no side, so the comparative rule supplies one and the fit
 * ladder then runs on it exactly as it does on an explicit side. It did not,
 * once, and that was this library's worst bug: a bare `v-teleport-to="{ to }"`
 * never asked whether the popover fitted where it was put.
 *
 * ## Two space records, because the edge buffer is a preference, not a wall
 *
 * `constants.ts` reserves `BUFFER_BOTTOM` / `BUFFER_TOP` px against the
 * boundary's edges so a popover does not slam into them. Those are ABSOLUTE
 * constants applied to whatever `boundary` is passed, so a 200px scroll pane
 * lost 150 of its 200px to a reserve sized for a viewport — and because the
 * same buffered number also clamped `max-height`, a host with 300px of real
 * room below was cut at 150px with no better side to flip to.
 *
 * So the two questions get two records:
 *   - `spaces` (buffered) answers "which side would we RATHER use" — the
 *     comparative preference, and nothing else.
 *   - `rawSpaces` (unbuffered, boundary-clipped only) answers "does the host
 *     FIT", and is what the caller clamps `max-height` to.
 *
 * ## The measurement must not describe the decision
 *
 * `hostExtent` has to be a property of the CONTENT, not of the side the host
 * is currently on. When it was not — when it was read through our own clamp,
 * through a collapsed closed state, or through the shrink-to-fit cap that the
 * side coordinate imposes on the horizontal axis — the fit test either
 * livelocked or lied. `measure-host.ts` documents each of those in full; this
 * module simply requires that the number it is handed came from there.
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
 * Pick the side.
 *
 * @param placement  the consumer's preference. `'auto'` names no side, so the
 *                   comparative rule supplies one and the fit ladder runs on
 *                   it exactly as it does on an explicit side.
 * @param spaces     BUFFERED space on each of the four sides. Preference only;
 *                   values may be negative once the buffers are eaten.
 * @param rawSpaces  UNBUFFERED, boundary-clipped space on each side — the room
 *                   the host can actually occupy, so it is what the fit test
 *                   asks and what the caller clamps `max-height` to.
 * @param flip       whether flipping is enabled. Default `true` at the caller;
 *                   `false` pins the preferred side and skips the fit test.
 * @param hostExtent the host's own extent along the preferred axis — the size
 *                   it will render at, from `measure-host.ts` — or `null` when
 *                   it could not be measured.
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
  // when the host is cut, so no fit answer is consulted and none is needed.
  if (!flip) return { side: preferred, fit: 'unmeasured' }

  const opposite = OPPOSITE_SIDE[preferred]

  // No measurement → no fit answer, so keep the preferred side. It used to
  // degrade to the comparative rule, which was defensible while `flip` was
  // opt-in — you had asked for movement — but is not now that it is the
  // default: `placement: 'bottom'` on a host with no laid-out box would
  // silently become `'top'` on the strength of no evidence at all. `'auto'` is
  // unaffected; its preferred side IS the comparative one.
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
  //    on blank clearance is indefensible.
  return {
    side: rawSpaces[preferred] >= rawSpaces[opposite] ? preferred : opposite,
    fit: 'neither',
  }
}
