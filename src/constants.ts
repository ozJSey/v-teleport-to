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
