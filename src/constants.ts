/**
 * Layout constants for the teleport-to directive.
 *
 * Buffer values reserve space at the top/bottom edge of the boundary so the
 * positioned element does not visually slam into the edge — they affect
 * placement decisions in `calculatePosition`.
 *
 * Each buffer is named for the boundary edge it reserves space against, which
 * is the edge the corresponding gap is measured *to*: the gap BELOW the
 * reference runs down to the boundary's bottom edge, so it pays
 * `BUFFER_BOTTOM`; the gap ABOVE runs up to the top edge, so it pays
 * `BUFFER_TOP`. The two values are deliberately asymmetric (150 vs 50): a
 * dropdown opening downward needs more clearance than one opening upward.
 */

/** Reserved space at the bottom edge of the boundary (px), subtracted when
 *  measuring the gap BELOW the reference. */
export const BUFFER_BOTTOM = 150

/** Reserved space at the top edge of the boundary (px), subtracted when
 *  measuring the gap ABOVE the reference. */
export const BUFFER_TOP = 50

/** Past this fraction of the viewport width, the element anchors to the right edge. */
export const WIDTH_THRESHOLD = 0.71

/** Below this width, the element uses the full viewport width. */
export const MOBILE_BREAKPOINT = 768

/** Default z-index — chosen to sit above typical modal masks. */
export const DEFAULT_Z = 1201

/** Default maximum height (px). */
export const DEFAULT_MAX_HEIGHT = 240

/** Default width multiplier relative to the reference element. */
export const DEFAULT_WIDTH_MULTIPLIER = 1.5

/**
 * Sub-pixel tolerance (px) for the one comparison that asks "is the content
 * taller than the `max-height` we are about to write?" — i.e. `truncated`.
 *
 * It is a REPORTING threshold and nothing else. Nothing downstream of
 * `truncated` feeds a placement decision, so there is no side → style →
 * measurement → side cycle here to guard against, and this must not be sized
 * as if there were: it arrived at `0.5`, carrying a docstring about the
 * `offsetHeight` livelock, and half a CSS pixel is 30× larger than any error
 * the two operands can actually carry. Measured in Chrome 1280×760, sweeping
 * the available space across a 120.3125px host in 1/64px steps: a host clamped
 * 0.484px below its own content reported `truncated: false`. That is a real
 * cut, silently unreported, in the one signal that exists to stop silent cuts.
 *
 * What the operands can be wrong by, and nothing more, is what belongs here:
 *
 * - Both are measured on the engine's layout grid — 1/64px in Blink and
 *   WebKit, 1/60px in Gecko — so a difference smaller than one grid unit
 *   cannot describe a real cut.
 * - `max-height` is written as a string and re-parsed onto that same grid, so
 *   the clamp the engine applies can sit up to half a unit (≤ 1/120px) away
 *   from the number compared here.
 *
 * `1/64` clears both — larger than every quantisation artefact, smaller than
 * every cut a user could see. A cut is reported from two layout units up.
 */
export const MEASURE_EPSILON = 1 / 64
