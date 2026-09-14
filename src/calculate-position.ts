/**
 * Positioning math + style application for the teleport-to directive.
 *
 * `computePositionStyles` decides everything: given the options and the host,
 * it returns the style record + event detail describing what should be
 * applied. It dispatches no events and leaves the host exactly as it found it
 * — its one DOM write is the measurement probe in `measure-host.ts`, which
 * restores the element's `style` attribute verbatim before returning, so the
 * function is safe to call from the `useTeleportTo` composable's reactive
 * effect as well as from the directive.
 *
 * `calculatePosition` is the side-effectful directive entry point: it calls
 * `computePositionStyles`, writes the styles onto `el.style`, mirrors the
 * verdict onto `data-teleport-*`, and dispatches the `teleport-positioned`
 * CustomEvent.
 */

import { toValue } from 'vue'
import {
  BUFFER_BOTTOM,
  BUFFER_TOP,
  DEFAULT_MAX_HEIGHT,
  DEFAULT_WIDTH_MULTIPLIER,
  DEFAULT_Z,
  MEASURE_EPSILON,
  MOBILE_BREAKPOINT,
  WIDTH_THRESHOLD,
} from './constants'
import { measureNaturalExtent, type HostWidthConstraints } from './measure-host'
import { OPPOSITE_SIDE, resolvePlacement, type SideSpaces } from './resolve-placement'
import type { TeleportToEventDetail, TeleportToOptions } from './types'
import { isVirtualReference } from './virtual-reference'

export { isVirtualReference }

/**
 * Every inline CSS property this library can write, as the PRODUCER sees it:
 * the four coordinate keys and the sizing keys are always present, `''` where
 * they do not apply.
 *
 * That is not a convention, it is the type. `width` was once merely *set*,
 * never cleared, so `matchWidth: true → false` welded a pinned width on
 * forever; the `top`/`bottom`/`left`/`right` pairs each had the same hole.
 * Making the keys required means the compiler refuses a tick that forgets one,
 * and it is what lets `calculatePosition` assign them without eleven
 * `!== undefined` guards for states the type already excludes.
 *
 * The two genuinely optional keys are optional for a reason, spelled out on
 * each.
 */
type PositionedStyles = {
  position: 'fixed' | 'absolute'
  zIndex: string
  minWidth: string
  maxWidth: string
  maxHeight: string
  transformOrigin: 'top' | 'bottom' | 'left' | 'right' | ''
  width: string
  top: string
  bottom: string
  left: string
  right: string
  /**
   * Emitted as `'hidden'` — and ONLY as `'hidden'` — while `overflow: 'hide'`
   * or `hideWhenReferenceHidden` says the host should be hidden. Every other
   * tick omits the key entirely: absence is the honest representation of "the
   * directive is not asserting visibility", so the record never stomps a
   * consumer's own `:style` visibility, and it keeps the type assignable to
   * Vue's `CSSProperties` (whose `visibility` union has no `''` member).
   *
   * `visibility` rather than `display` on purpose: `display` belongs to the
   * consumer (`v-show`, `v-if`, plain CSS), and `visibility: hidden` still
   * removes the host from paint, hit-testing and the accessibility tree while
   * keeping it in the box tree — so `[data-teleport-state]` transitions keep
   * running and no reflow is paid per show.
   */
  visibility?: 'hidden'
  /**
   * CSS custom property: arrow X position relative to the host's left edge,
   * in `px`. Only emitted when `opts.arrow` resolves to a connected element.
   * Vertical placements set this to the reference's horizontal center;
   * horizontal placements set it to `'0px'`.
   */
  '--teleport-arrow-x'?: string
  /**
   * CSS custom property: arrow Y position relative to the host's top edge,
   * in `px`. Only emitted when `opts.arrow` resolves to a connected element.
   * Horizontal placements set this to the reference's vertical center;
   * vertical placements set it to `'0px'`.
   */
  '--teleport-arrow-y'?: string
}

/**
 * Style record produced by `computePositionStyles`, as CONSUMERS bind it.
 * Keys map 1:1 to inline CSS properties; values are stringified CSS values.
 * Every key is optional here because `useTeleportTo` starts from `{}` before
 * its first successful calculation — a produced record always carries all of
 * them.
 */
export type TeleportToStyles = Partial<PositionedStyles>

export type ComputedPositionResult = {
  styles: PositionedStyles
  detail: TeleportToEventDetail
}

/**
 * Compute the inline-style record and event detail for the given options.
 * Returns `null` when the reference element is missing or detached — callers
 * should treat this as "do nothing" (no styles applied, no event dispatched).
 *
 * `hostEl` is what makes the fit test and `strategy: 'absolute'` work: it is
 * the element measured by `measure-host.ts` and the element whose
 * `offsetParent` defines the absolute coordinate origin. Without it the fit
 * test has nothing to measure (`fit: 'unmeasured'`, the requested side stands)
 * and absolute coordinates fall back to the viewport.
 */
export function computePositionStyles(
  opts: TeleportToOptions,
  hostEl?: HTMLElement | null,
): ComputedPositionResult | null {
  const {
    placement = 'auto',
    maxHeight: maxHeightOpt = DEFAULT_MAX_HEIGHT,
    widthMultiplier = DEFAULT_WIDTH_MULTIPLIER,
    offsetY = 0,
    offsetX = 0,
    zIndex = DEFAULT_Z,
    matchWidth = false,
    strategy = 'fixed',
  } = opts

  // `to` may be a plain HTMLElement, a Ref<HTMLElement | null>, a getter, or a
  // VirtualReference (anything with `getBoundingClientRect`). `toValue`
  // collapses ref/getter shapes to the underlying value (and reading a ref's
  // `.value` here is what makes the composable's watchEffect re-run when the
  // ref is later populated).
  const parentRef = toValue(opts.to)

  // Bail out when there's nothing to position relative to. For real elements,
  // also bail when the node has been detached — `getBoundingClientRect` on a
  // detached node yields a zero rect, which would silently teleport to 0,0.
  // Virtual references bypass the connection check; the consumer's
  // `getBoundingClientRect()` is the source of truth.
  if (!parentRef) return null
  const isVirtual = isVirtualReference(parentRef)
  if (!isVirtual && !(parentRef as HTMLElement).isConnected) return null

  const windowHeight = window.innerHeight
  const windowWidth = window.innerWidth

  // Resolve the coordinate origin. For `position: fixed`, coordinates are
  // viewport-relative — emulated by a synthetic rect at (0,0)–(W,H). For
  // `position: absolute`, coordinates are relative to the host element's
  // nearest positioned ancestor (`offsetParent`); when that is missing or
  // disconnected, fall back to the viewport rect so the math degrades
  // gracefully (host effectively pinned to the document).
  let offsetParentRect: { top: number; left: number; right: number; bottom: number } = {
    top: 0,
    left: 0,
    right: windowWidth,
    bottom: windowHeight,
  }
  if (strategy === 'absolute' && hostEl) {
    const op = hostEl.offsetParent as HTMLElement | null
    if (op && op.isConnected) {
      const opRect = op.getBoundingClientRect()
      offsetParentRect = {
        top: opRect.top,
        left: opRect.left,
        right: opRect.right,
        bottom: opRect.bottom,
      }
    }
  }

  // Resolve the clipping boundary. `'viewport'` (default) keeps the existing
  // viewport-based math; a connected HTMLElement clips the available-space
  // math to that element's rect. A disconnected element falls back to the
  // viewport so consumers don't have to guard against transient detachment.
  const boundaryOpt = opts.boundary
  const boundaryEl =
    boundaryOpt && boundaryOpt !== 'viewport' && boundaryOpt.isConnected ? boundaryOpt : null
  const boundaryRect = boundaryEl
    ? boundaryEl.getBoundingClientRect()
    : { top: 0, bottom: windowHeight, left: 0, right: windowWidth }

  // Virtual references may return a partial `DOMRectInit` — normalize missing
  // sides (`right = left + width`, `bottom = top + height`) so downstream math
  // can rely on all six fields. Real `HTMLElement.getBoundingClientRect()`
  // already returns a full `DOMRect`, so this normalization is a no-op there.
  const rawRect = parentRef.getBoundingClientRect() as Partial<DOMRect>
  const parentTop = rawRect.top ?? 0
  const parentLeft = rawRect.left ?? 0
  const parentWidth = rawRect.width ?? 0
  const parentHeight = rawRect.height ?? 0
  const parentRight = rawRect.right ?? parentLeft + parentWidth
  const parentBottom = rawRect.bottom ?? parentTop + parentHeight

  // Available space in each direction, clipped to the boundary. TWO records,
  // for two different questions — see `resolve-placement.ts` for why they had
  // to be separated.
  //
  // `rawSpaces` is the room the host can actually occupy. It is what the fit
  // test asks about and what `max-height` is clamped to.
  const rawSpaces: SideSpaces = {
    bottom: boundaryRect.bottom - parentBottom,
    top: parentTop - boundaryRect.top,
    right: boundaryRect.right - parentRight,
    left: parentLeft - boundaryRect.left,
  }
  // `spaces` is the same room minus the reserved edge buffers, and its ONLY
  // job is to weight the comparative preference between the two sides of an
  // axis — `BUFFER_BOTTOM` against the boundary's bottom edge, `BUFFER_TOP`
  // against its top, deliberately asymmetric because a menu opening downward
  // wants more clearance than one opening upward. These are absolute constants
  // applied to whatever `boundary` is passed, so they must never reach the
  // height clamp: a 200px scroll pane would lose 150 of its 200px, and a menu
  // with 300px of real room below would be cut at 150px with nowhere better to
  // flip to. The horizontal axis has never had buffers — popovers placed
  // beside a reference are expected to sit flush.
  const spaces: SideSpaces = {
    bottom: rawSpaces.bottom - BUFFER_BOTTOM,
    top: rawSpaces.top - BUFFER_TOP,
    right: rawSpaces.right,
    left: rawSpaces.left,
  }

  // ── The axis ───────────────────────────────────────────────────────────────
  // Taken from the REQUESTED placement, and used for everything: the fit
  // test's axis, the mobile full-bleed gate, and which coordinate pair gets
  // written below. There used to be two of these — one from the requested
  // placement, one from the chosen side — under two names, and they are
  // provably the same value: `resolvePlacement` never crosses axes, it only
  // ever answers with the preferred side or its `OPPOSITE_SIDE`. One name,
  // pinned by a test ("the chosen side is always on the requested axis").
  const isHorizontal = placement === 'left' || placement === 'right'

  // ── Width ──────────────────────────────────────────────────────────────────
  // Resolved BEFORE the placement decision, because nothing about the host's
  // width depends on which side it lands on — and because the measurement that
  // feeds the decision has to be taken at the width the host will really get.
  // Measuring wrapping text at whatever width it happened to have in normal
  // flow is how a 127px tooltip reported 36px and got clamped to a side that
  // could not hold it (TT-18).
  //
  // Mobile full-bleed (`100vw`) only kicks in for vertical placement — an
  // explicit horizontal placement keeps the multiplier-derived width on every
  // viewport size, so the host stays beside the reference instead of becoming
  // a full-width banner that swallows the layout. Explicit `maxWidth` (number
  // or CSS string) overrides BOTH the default multiplier and the mobile
  // branch; `matchWidth` still wins over `maxWidth` (consumer-explicit pinning
  // beats consumer-explicit clamping).
  const isMobileView = windowWidth < MOBILE_BREAKPOINT
  const maxWidthOpt = opts.maxWidth
  const hasExplicitMaxWidth = maxWidthOpt !== undefined && !matchWidth
  const explicitMaxWidthStyle = hasExplicitMaxWidth
    ? typeof maxWidthOpt === 'number'
      ? `${maxWidthOpt}px`
      : maxWidthOpt
    : null
  // Mobile full-bleed is ONE decision, so every consequence of it reads one
  // flag. It used to be re-derived per site with different terms, which is how
  // an explicit `maxWidth` could override the width half of the branch while
  // the `left: 0` half kept pinning the host to the screen edge — a menu
  // stranded at x=0 with its trigger at x=300.
  const isFullBleed = isMobileView && !matchWidth && !hasExplicitMaxWidth && !isHorizontal
  const widthStyle = matchWidth
    ? `${parentWidth}px`
    : explicitMaxWidthStyle !== null
      ? explicitMaxWidthStyle
      : isFullBleed
        ? '100vw'
        : `${parentWidth * widthMultiplier}px`

  // Numeric host width used as the FALLBACK when the host cannot be measured
  // (no host at all, or one with no box even unclamped). Mirrors the numeric
  // form of `widthStyle`. When `maxWidth` is a CSS string (e.g.
  // `min(80vw, 400px)`) there is no number to resolve without rendering, so
  // the projection falls back to the multiplier-derived width.
  const hostWidthNum = matchWidth
    ? parentWidth
    : isFullBleed
      ? windowWidth
      : hasExplicitMaxWidth && typeof maxWidthOpt === 'number'
        ? maxWidthOpt
        : parentWidth * widthMultiplier

  // `min-width` is "at least as wide as the reference", which is a nicety —
  // and it used to be written unconditionally, so it beat `max-width` and made
  // every narrowing knob a no-op: `widthMultiplier: 0.5` on a 220px reference
  // rendered 220px, and the README's own `maxWidth: 0` "collapses the host"
  // rendered 220px. The floor now yields to the ceiling. For a CSS-string
  // `maxWidth` there is no number to compare against, so the comparison is
  // handed to CSS itself.
  const minWidthStyle = matchWidth
    ? `${parentWidth}px`
    : hasExplicitMaxWidth && typeof maxWidthOpt === 'string'
      ? `min(${parentWidth}px, ${maxWidthOpt})`
      : `${Math.min(parentWidth, hostWidthNum)}px`

  // ── The one host measurement ───────────────────────────────────────────────
  // Taken under the width constraints resolved above and under NO side, so the
  // number cannot describe the decision it is about to feed. Everything below
  // that needs the host's size reads this and only this: the fit test, the
  // cross-axis anchor and the arrow variables. One measurement because two
  // could disagree, and the arrow landing 127px outside a right-anchored
  // popover was exactly that disagreement.
  const constraints: HostWidthConstraints = {
    position: strategy,
    minWidth: minWidthStyle,
    maxWidth: widthStyle,
    width: matchWidth ? `${parentWidth}px` : isFullBleed ? '100vw' : '',
  }
  const natural = hostEl ? measureNaturalExtent(hostEl, constraints) : null

  // The host's real width, or the projection when there is no host to measure.
  const hostWidthActual = natural && natural.width > 0 ? natural.width : hostWidthNum

  // Decide placement. `flip` defaults to ON: an explicit side is a preference
  // honoured while it works, not a sticky instruction that lets the host be
  // cut, and `'auto'` gets the same fit ladder rather than returning before
  // it. `flip: false` is the total opt-out and consults no measurement.
  //
  // What has to fit is the size the host will RENDER at, which on the vertical
  // axis is the content capped by the consumer's `maxHeight` — a consumer who
  // caps the host has told us how big it is. A `0` extent is reported as
  // `null`, never as zero: zero reads as "fits anywhere", which is how a
  // popover ends up pinned to a side with no room.
  const flip = opts.flip !== false
  let hostExtent: number | null = null
  if (flip && natural) {
    if (isHorizontal) hostExtent = natural.width > 0 ? natural.width : null
    else hostExtent = natural.height > 0 ? Math.min(natural.height, maxHeightOpt) : null
  }
  const { side: chosen, fit } = resolvePlacement(placement, spaces, rawSpaces, flip, hostExtent)

  const placeBelow = chosen === 'bottom'
  const placeRight = chosen === 'right'

  // Reported raw, matching what `maxHeight` is derived from. A consumer given
  // the buffered number alongside a `maxHeight` computed from the raw one
  // cannot reconcile them, and the buffers are an internal preference weight,
  // not space the host is forbidden from using.
  const availableSpace = rawSpaces[chosen]
  const oppositeSpace = rawSpaces[OPPOSITE_SIDE[chosen]]

  // For vertical placement, maxHeight is clamped by the chosen vertical space.
  // For horizontal placement, the popover sits beside the reference, so the
  // relevant vertical extent runs from `parentTop` down to the boundary's
  // bottom edge. The clamp reads `rawSpaces`, never `spaces`.
  const verticalRoomForHorizontalHost = boundaryRect.bottom - parentTop
  const heightSource = isHorizontal ? verticalRoomForHorizontalHost : availableSpace
  const maxHeightStyle = Math.min(Math.max(heightSource, 0), maxHeightOpt)
  // The state that used to be invisible: there is no room on the chosen side
  // at all, so the host is being painted at nothing but its own padding, at
  // full opacity, with no attribute distinguishing it from a popover whose
  // content is simply short.
  const collapsed = maxHeightStyle <= 0
  // And the state that was invisible for longer: the content is taller than
  // the `max-height` we are writing, so some of it is being cut. `fit` cannot
  // carry this — `fit: 'fits'` is the correct answer when the host, at the
  // size it will render, does fit on this side, and it is still the answer
  // when the consumer's own `maxHeight` (or ours, defaulting to 240) is what
  // made it that size. This is the signal that says the popover you are
  // looking at is not short, it is cut. Whether to scroll it, shrink it or
  // raise `maxHeight` is the consumer's call; being told is not optional.
  const truncated = natural !== null && natural.height > maxHeightStyle + MEASURE_EPSILON
  // The height the host will actually render at, for the cross-axis anchor.
  // Using `maxHeightStyle` here — a ceiling, not a height — is what put a
  // 40px host asked to centre beside its trigger 100px too high at the
  // defaults, with its arrow variable pointing below its own bottom edge.
  const hostHeightActual = natural ? Math.min(natural.height, maxHeightStyle) : maxHeightStyle

  // Horizontal anchor heuristic. The threshold check stays in viewport units —
  // it asks "is the reference near the right edge of what the user can see?" —
  // and the user's view is the viewport regardless of strategy.
  const anchorRight = parentRight >= windowWidth * WIDTH_THRESHOLD

  // Coordinate values are subtracted from the offsetParent rect. When the
  // origin is the viewport (fixed strategy or absolute fallback),
  // `offsetParentRect.{top,left}` are 0 and `{right,bottom}` are viewport
  // size, so the formulas collapse to the prior viewport-only math.
  const topValue = parentBottom - offsetParentRect.top + offsetY
  const bottomValue = offsetParentRect.bottom - parentTop + offsetY
  const leftValue = parentLeft - offsetParentRect.left + offsetX
  const rightValue = offsetParentRect.right - parentRight - offsetX

  // Honor `(prefers-reduced-motion: reduce)`. When the user has reduced motion
  // turned on, writing `transform-origin` would silently re-anchor any
  // consumer-defined CSS scale/zoom transitions to a side that wasn't part of
  // their stylesheet. Emit `''` instead to clear any prior inline value (so a
  // mid-lifecycle toggle from "no-reduce → reduce" wipes the stale anchor) and
  // let the consumer's CSS rules win.
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // transformOrigin maps the chosen anchor side to the visual origin of any
  // consumer-defined scale/zoom transition: a popover that opens to the right
  // of the reference should grow from its LEFT edge (anchor side), and so on.
  let transformOrigin: 'top' | 'bottom' | 'left' | 'right' | ''
  if (reduceMotion) transformOrigin = ''
  else if (chosen === 'bottom') transformOrigin = 'top'
  else if (chosen === 'top') transformOrigin = 'bottom'
  else if (chosen === 'right') transformOrigin = 'left'
  else transformOrigin = 'right'

  const styles: PositionedStyles = {
    position: strategy,
    zIndex: String(zIndex),
    minWidth: minWidthStyle,
    maxWidth: widthStyle,
    maxHeight: `${maxHeightStyle}px`,
    transformOrigin,
    // Always written, never merely set. `matchWidth: true → false` left the
    // pinned `width` welded on forever, because nothing cleared it. Full-bleed
    // writes a real width too: it used to write only `max-width: 100vw`, a cap
    // that leaves a narrow menu at its natural width while `left: 0` drags it
    // to the screen edge.
    width: constraints.width,
    top: '',
    bottom: '',
    left: '',
    right: '',
  }

  // The host's viewport-coordinate edges. ONE cascade produces both the CSS
  // coordinate that gets written and the viewport number the arrow and the
  // overflow clamp read. There used to be two cascades — one in offsetParent
  // coordinates for `styles.left/right`, one in viewport coordinates for the
  // arrow — kept in step by hand, and the one time they were not is the arrow
  // that landed 127px outside the popover (TT-16 T2).
  let hostLeftViewport = parentLeft + offsetX
  let hostTopViewport = parentTop + offsetY

  if (isHorizontal) {
    // Anchor the chosen edge of the host to the corresponding edge of the
    // reference (modulated by offsetX), and align on the cross axis (vertical)
    // per `crossAxisAlign` (default `'start'` — top-align, modulated by
    // offsetY). Mobile full-bleed and the viewport-edge `anchorRight`
    // heuristic are intentionally bypassed: the consumer explicitly chose
    // horizontal, so we honour that placement on every viewport size.
    if (opts.crossAxisAlign === 'center') {
      hostTopViewport = parentTop + parentHeight / 2 - hostHeightActual / 2 + offsetY
    } else if (opts.crossAxisAlign === 'end') {
      hostTopViewport = parentBottom - hostHeightActual + offsetY
    } else {
      hostTopViewport = parentTop + offsetY
    }
    styles.top = `${hostTopViewport - offsetParentRect.top}px`

    if (placeRight) {
      // Host's left edge sits at parentRight + offsetX.
      hostLeftViewport = parentRight + offsetX
      styles.left = `${hostLeftViewport - offsetParentRect.left}px`
    } else {
      // 'left': host's right edge sits at parentLeft - offsetX.
      hostLeftViewport = parentLeft - offsetX - hostWidthActual
      styles.right = `${offsetParentRect.right - parentLeft + offsetX}px`
    }
  } else {
    if (placeBelow) styles.top = `${topValue}px`
    else styles.bottom = `${bottomValue}px`

    // Cross-axis (horizontal) anchor for vertical placement, as ONE decision:
    //   1. Mobile full-bleed wins unconditionally — align the host's left edge
    //      with the viewport's left edge (for absolute mode that means a
    //      negative offset back out of any non-zero offsetParent.left).
    //   2. Explicit `crossAxisAlign` overrides the legacy `anchorRight`
    //      heuristic: 'start' = left-anchor, 'center' = centre, 'end' =
    //      right-anchor.
    //   3. When omitted, `anchorRight` decides (right-anchor once the
    //      reference passes WIDTH_THRESHOLD of the viewport).
    // 'end' and the heuristic write a CSS `right` rather than a `left` so the
    // host stays pinned to the reference's right edge if its own width changes
    // between ticks.
    const align = opts.crossAxisAlign
    if (isFullBleed) {
      hostLeftViewport = 0
      styles.left = `${0 - offsetParentRect.left}px`
    } else if (align === 'center') {
      hostLeftViewport = parentLeft + parentWidth / 2 - hostWidthActual / 2 + offsetX
      styles.left = `${hostLeftViewport - offsetParentRect.left}px`
    } else if (align === 'end' || (align === undefined && anchorRight)) {
      hostLeftViewport = parentRight + offsetX - hostWidthActual
      styles.right = `${rightValue}px`
    } else {
      hostLeftViewport = parentLeft + offsetX
      styles.left = `${leftValue}px`
    }
  }

  // Overflow handling — applies along the chosen placement axis.
  //
  // For VERTICAL placement the placement axis is vertical but the overflow
  // axis is HORIZONTAL: a vertically-placed popover overflows the viewport's
  // left/right edges. Mobile full-bleed already pins the host to `left: 0`
  // with `100vw` width, so overflow is a no-op there.
  //
  // For HORIZONTAL placement the placement axis IS the overflow axis. The
  // shift clamp also enforces a no-overlap-with-reference invariant: shift
  // never pushes the host onto the reference. When that conflicts with fitting
  // in the viewport, no-overlap wins and the host is allowed to overflow —
  // consumers wanting hard visibility should rely on `flip`, which runs BEFORE
  // the overflow gate and resolves overflow by switching sides.
  //
  // Strategy-independent: viewport extents are the same whether `position`
  // resolves against the viewport (fixed) or the offsetParent (absolute),
  // since the offsetParent is mapped back to viewport coords above.
  const overflow = opts.overflow ?? 'none'
  if (overflow !== 'none' && !(isFullBleed && !isHorizontal)) {
    const hostRightViewport = hostLeftViewport + hostWidthActual
    const overflowsLeft = hostLeftViewport < 0
    const overflowsRight = hostRightViewport > windowWidth

    if (overflow === 'hide') {
      // Omit the key when the host fits: the directive releases a prior hide
      // from the absence (see `releaseHide`), and the composable's consumer
      // sees the key disappear from the bound style record.
      if (overflowsLeft || overflowsRight) styles.visibility = 'hidden'
    } else if (overflowsLeft || overflowsRight) {
      if (isHorizontal && placeRight) {
        // Clamp hostLeft into [parentRight, windowWidth − hostWidth]. When the
        // host can't fit without overlapping the reference (maxLeft < minLeft),
        // pin at parentRight (no overlap; accept overflow).
        const minLeft = parentRight
        const maxLeft = windowWidth - hostWidthActual
        hostLeftViewport =
          maxLeft < minLeft ? minLeft : Math.max(minLeft, Math.min(hostLeftViewport, maxLeft))
        styles.left = `${hostLeftViewport - offsetParentRect.left}px`
        styles.right = ''
      } else if (isHorizontal) {
        // 'left': clamp hostRight into [hostWidth, parentLeft]. When the host
        // can't fit without overlapping the reference (minRight > maxRight),
        // pin at parentLeft (no overlap; accept overflow on the left edge).
        const minRight = hostWidthActual
        const maxRight = parentLeft
        const shiftedHostRight =
          minRight > maxRight ? maxRight : Math.max(minRight, Math.min(hostRightViewport, maxRight))
        hostLeftViewport = shiftedHostRight - hostWidthActual
        styles.right = `${offsetParentRect.right - shiftedHostRight}px`
        styles.left = ''
      } else {
        // Vertical placement: clamp hostLeft into [0, viewportWidth −
        // hostWidth]. When the host is wider than the viewport, prefer
        // left-edge alignment (max(0, …) wins). Switch to a left-anchored CSS
        // coordinate so the clamp is expressed unambiguously regardless of the
        // original anchor.
        const maxLeft = Math.max(0, windowWidth - hostWidthActual)
        hostLeftViewport = Math.max(0, Math.min(hostLeftViewport, maxLeft))
        styles.left = `${hostLeftViewport - offsetParentRect.left}px`
        styles.right = ''
      }
    }
  }

  // Reference-visibility detection (independent of `overflow`, and ON by
  // default — see `hideWhenReferenceHidden`).
  //
  // The region the reference has to be inside to count as visible is the
  // INTERSECTION of the boundary and the viewport. Two reasons, and the
  // predicate is wrong without either:
  //   - `boundary` defaults to `'viewport'`, so a boundary-only test can
  //     never fire for ordinary page scrolling — which is the whole case
  //     this exists for.
  //   - a reference can sit comfortably inside a `boundary` pane that has
  //     itself scrolled off the screen. Boundary-only says "visible"; the
  //     user sees nothing.
  //
  // Kept in its own local: `boundaryRect` feeds the placement and available-
  // space math, and clamping THAT to the viewport would silently change where
  // popovers land inside an over-hanging boundary.
  const clipRect = {
    top: Math.max(boundaryRect.top, 0),
    bottom: Math.min(boundaryRect.bottom, windowHeight),
    left: Math.max(boundaryRect.left, 0),
    right: Math.min(boundaryRect.right, windowWidth),
  }
  // Four-sided and binary. NOT axis-aware: a reference that scrolls out
  // sideways under `placement: 'bottom'` is exactly as gone as one that
  // scrolls out downwards. NOT a ratio: the owner's word was "fully", and a
  // ratio hides a dropdown whose trigger is still usefully on screen.
  //
  // `<=` / `>=` — touching counts as hidden, matching Floating UI. That also
  // means an all-zero rect (a `display: none` reference) hides, where the
  // host would otherwise silently teleport to (0, 0).
  //
  // Zero extra DOM reads: both rects were already measured above.
  const referenceHidden =
    parentBottom <= clipRect.top ||
    parentTop >= clipRect.bottom ||
    parentRight <= clipRect.left ||
    parentLeft >= clipRect.right

  // Measured unconditionally (it is reported either way), applied only when
  // the consumer has not opted out. Overrides any prior decision (including
  // `overflow: 'hide'` reporting "fits").
  //
  // No `else`: a visible reference simply does not assert a hide, and leaving
  // the key absent preserves an active `overflow: 'hide'` decision without a
  // second write.
  if (referenceHidden && opts.hideWhenReferenceHidden !== false) {
    styles.visibility = 'hidden'
  }

  // Arrow position. Emitted only when `opts.arrow` resolves to a connected
  // element — both as the option-presence gate (consumer didn't ask for vars
  // unless they passed an arrow) and so a detached arrow mid-lifecycle clears
  // the vars on the next tick instead of leaking stale values.
  const arrowEl = toValue(opts.arrow)
  if (arrowEl && arrowEl.isConnected) {
    if (isHorizontal) {
      // Arrow Y = reference vertical center − host top edge.
      styles['--teleport-arrow-x'] = '0px'
      styles['--teleport-arrow-y'] = `${parentTop + parentHeight / 2 - hostTopViewport}px`
    } else {
      // Arrow X = reference horizontal center − host left edge.
      styles['--teleport-arrow-x'] = `${parentLeft + parentWidth / 2 - hostLeftViewport}px`
      styles['--teleport-arrow-y'] = '0px'
    }
  }

  const detail: TeleportToEventDetail = {
    placement: chosen,
    availableSpace,
    oppositeSpace,
    fit,
    maxHeight: maxHeightStyle,
    collapsed,
    truncated,
    contentWidth: natural ? natural.width : null,
    contentHeight: natural ? natural.height : null,
    referenceHidden,
    // Whether the host ends this tick hidden, from EITHER signal. Read
    // alongside `referenceHidden` to tell the two apart.
    hidden: styles.visibility === 'hidden',
  }

  return { styles, detail }
}

/**
 * The consumer's inline `visibility` at the moment the directive first hid the
 * host, so the show path can restore it verbatim instead of assuming `''`.
 * Module-local and keyed by the host, so GC of the host clears the entry.
 */
const preHideVisibility = new WeakMap<HTMLElement, string>()

/**
 * Hide the host WITHOUT ever writing `display`.
 *
 * `display` belongs to the consumer — `v-show`, `v-if` and plain CSS all own
 * it. `vShow.updated` opens with `if (!value === !oldValue) return`, and Vue's
 * repair path (`patchStyle` re-applying `display: none` for a hidden element)
 * only covers styles written through a `:style` binding, so a single imperative
 * `el.style.display` write from this directive permanently defeats `v-show`.
 * `visibility: hidden` removes the host from paint, hit-testing and the
 * accessibility tree while leaving it in the box tree — consumer transitions
 * keyed on `[data-teleport-state]` keep working and no reflow is paid per show.
 *
 * `data-teleport-hidden` is the ownership record (and a free consumer CSS
 * hook): its presence means "the current hide is this directive's". Keying
 * ownership off the element's own attribute rather than `DirectiveState` keeps
 * this module free of an import from `schedule-update`, which would close a
 * dependency cycle.
 */
function hideHost(el: HTMLElement): void {
  if (el.dataset.teleportHidden === undefined) {
    preHideVisibility.set(el, el.style.visibility)
    el.dataset.teleportHidden = ''
  }
  el.style.visibility = 'hidden'
}

/**
 * Release a hide the directive applied itself, restoring the consumer's
 * pre-hide inline `visibility`. No-op when the ownership marker is absent —
 * the library only ever clears a hide it applied. Idempotent, so every dormant
 * branch (disabled, no `to`, detached `to`, unmount) can call it blindly.
 */
export function releaseHide(el: HTMLElement): void {
  if (el.dataset.teleportHidden === undefined) return
  el.style.visibility = preHideVisibility.get(el) ?? ''
  preHideVisibility.delete(el)
  delete el.dataset.teleportHidden
}

/**
 * Every `data-teleport-*` attribute the positioning path can stamp, cleared in
 * one call. The dormant paths all need exactly this set, and the one that
 * hand-listed it forgot `data-teleport-collapsed` — so a host that had once
 * been collapsed kept the attribute while the directive was disabled, and the
 * README's own `[data-teleport-collapsed] { display: none }` snippet made it
 * permanently invisible with nothing left to explain why.
 */
export function clearPositionAttributes(el: HTMLElement): void {
  delete el.dataset.teleportPlacement
  delete el.dataset.teleportFit
  delete el.dataset.teleportCollapsed
  delete el.dataset.teleportTruncated
  el.style.removeProperty('--teleport-arrow-x')
  el.style.removeProperty('--teleport-arrow-y')
}

/**
 * Side-effectful: apply computed styles to `el.style` and dispatch the
 * `teleport-positioned` event. Used by the directive lifecycle hooks.
 *
 * Returns the computed `TeleportToEventDetail` on success, or `null` when the
 * reference element is missing/detached. Callers (the directive lifecycle
 * hooks and `scheduleUpdate`) consume the return value to gate the
 * `onPlacementChange` callback against a per-element previous-placement cache.
 */
export function calculatePosition(
  el: HTMLElement,
  opts: TeleportToOptions,
): TeleportToEventDetail | null {
  // Pass the host so the fit test has something to measure and
  // `strategy: 'absolute'` can resolve `el.offsetParent`.
  const result = computePositionStyles(opts, el)
  if (!result) {
    // Reference is missing/detached — clear every stale signal so consumer CSS
    // (arrow rotation hooks, `[data-teleport-collapsed]`) does not lock onto a
    // value that no longer reflects the layout.
    clearPositionAttributes(el)
    // Release a hide this directive applied — without this there is no path
    // back from `visibility: hidden` once the reference goes away.
    releaseHide(el)
    // Surface dormant lifecycle state so consumer CSS can hook open/close
    // animations via `[data-teleport-state="closed"]`.
    el.dataset.teleportState = 'closed'
    return null
  }

  const { styles, detail } = result
  const s = el.style

  // No `!== undefined` guards: `PositionedStyles` makes every one of these
  // required, so a tick that forgot one would not compile.
  s.position = styles.position
  s.zIndex = styles.zIndex
  s.minWidth = styles.minWidth
  s.maxWidth = styles.maxWidth
  s.maxHeight = styles.maxHeight
  s.transformOrigin = styles.transformOrigin
  s.width = styles.width
  s.top = styles.top
  s.bottom = styles.bottom
  s.left = styles.left
  s.right = styles.right
  // `display` is never written — see `hideHost`. An ABSENT `visibility` means
  // "not hiding", and still has to release: the consumer may have switched off
  // `overflow: 'hide'` while the host was hidden. `releaseHide` no-ops when we
  // do not own the current hide.
  if (styles.visibility === 'hidden') hideHost(el)
  else releaseHide(el)

  // CSS custom properties must use setProperty — direct assignment via
  // `s.foo = x` is silently ignored for `--*` keys. When the arrow vars are
  // absent from the style record (option not provided, or arrow detached),
  // remove any previously-applied values so the consumer's CSS does not lock
  // onto stale data.
  const arrowX = styles['--teleport-arrow-x']
  const arrowY = styles['--teleport-arrow-y']
  if (arrowX !== undefined) s.setProperty('--teleport-arrow-x', arrowX)
  else s.removeProperty('--teleport-arrow-x')
  if (arrowY !== undefined) s.setProperty('--teleport-arrow-y', arrowY)
  else s.removeProperty('--teleport-arrow-y')

  // Surface placement to consumer CSS without requiring the event
  // subscription: `[data-teleport-placement="top"]` for arrow rotation,
  // transition origin, and so on.
  el.dataset.teleportPlacement = detail.placement
  // The fit verdict, for the same reason and for one more: it is the only
  // signal that says "neither side of this axis can hold the host".
  el.dataset.teleportFit = detail.fit
  // The chosen side has no room at all, so `max-height` is `0px` and the host
  // paints as its own padding at full opacity. Present/absent rather than
  // `"true"`/`"false"`, matching `data-teleport-hidden`.
  if (detail.collapsed) el.dataset.teleportCollapsed = ''
  else delete el.dataset.teleportCollapsed
  // The content is taller than the `max-height` being written — the popover is
  // cut, whether by the room on this side or by the `maxHeight` option. This
  // is the attribute the tooltip bug had no way to raise: every other signal
  // read healthy while the user saw five words of a sentence.
  if (detail.truncated) el.dataset.teleportTruncated = ''
  else delete el.dataset.teleportTruncated
  // Lifecycle state, so consumer CSS can hook open/close animations via
  // `[data-teleport-state="open"]`.
  el.dataset.teleportState = 'open'

  el.dispatchEvent(new CustomEvent('teleport-positioned', { detail }))

  // Optional consumer callback. Wrapped in try/catch so a thrown callback
  // cannot break the directive's RAF loop or leave the host in a partial
  // state on the next tick.
  if (opts.onPositioned) {
    try {
      opts.onPositioned(detail)
    } catch (err) {
      console.error('[v-teleport-to] onPositioned callback threw:', err)
    }
  }

  return detail
}
