/**
 * Pure positioning math + style application for the teleport-to directive.
 *
 * `computePositionStyles` is a pure function: given options, it returns the
 * style record + event detail describing what would be applied. It performs
 * no DOM mutation and dispatches no events — so it is reusable from the
 * `useTeleportTo` composable, which feeds the styles into a Vue reactive ref.
 *
 * `calculatePosition` is the side-effectful directive entry point: it calls
 * `computePositionStyles`, writes the styles onto `el.style`, and dispatches
 * the `teleport-positioned` CustomEvent.
 */

import { toValue } from 'vue'
import {
  BUFFER_BOTTOM,
  BUFFER_TOP,
  DEFAULT_MAX_HEIGHT,
  DEFAULT_WIDTH_MULTIPLIER,
  DEFAULT_Z,
  MOBILE_BREAKPOINT,
  WIDTH_THRESHOLD,
} from './constants'
import {
  measureHostExtent,
  OPPOSITE_SIDE,
  resolvePlacement,
  type SideSpaces,
} from './resolve-placement'
import type { TeleportToEventDetail, TeleportToOptions, VirtualReference } from './types'

/**
 * Type guard: distinguish a `VirtualReference` (any object with a
 * `getBoundingClientRect` method that is NOT a DOM `Node`) from a real
 * `HTMLElement`. DOM nodes carry a `nodeType`; virtual references do not.
 *
 * Centralized so the auto-update module + the directive's `mounted` warn-gate
 * agree on the same detection rule.
 */
export function isVirtualReference(
  v: HTMLElement | VirtualReference | null | undefined,
): v is VirtualReference {
  return (
    !!v &&
    typeof (v as VirtualReference).getBoundingClientRect === 'function' &&
    typeof (v as Node).nodeType !== 'number'
  )
}

/** Style record produced by `computePositionStyles`. Keys map 1:1 to inline
 *  CSS properties; values are stringified CSS values. Empty strings explicitly
 *  clear the corresponding side (`top`/`bottom`/`left`/`right`) so consumers
 *  that re-apply across renders do not leak stale values. */
export type TeleportToStyles = {
  position?: 'fixed' | 'absolute'
  zIndex?: string
  minWidth?: string
  maxWidth?: string
  maxHeight?: string
  transformOrigin?: 'top' | 'bottom' | 'left' | 'right' | ''
  width?: string
  top?: string
  bottom?: string
  left?: string
  right?: string
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

export type ComputedPositionResult = {
  styles: TeleportToStyles
  detail: TeleportToEventDetail
}

/**
 * Pure: compute the inline-style record and event detail for the given options.
 * Returns `null` when the reference element is missing or detached — callers
 * should treat this as "do nothing" (no styles applied, no event dispatched).
 *
 * `hostEl` is consulted only when `opts.strategy === 'absolute'`: its
 * `offsetParent` defines the coordinate origin. When omitted or unresolvable,
 * the function falls back to viewport-relative coordinates (still tagged as
 * `position: 'absolute'` if requested) so consumers without a known host
 * (e.g. the composable) can still opt into absolute strategy.
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
    boundaryOpt && boundaryOpt !== 'viewport' && boundaryOpt.isConnected
      ? boundaryOpt
      : null
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

  // The host's own box, read ONCE per tick and shared by everything below that
  // needs it: the fit test, the cross-axis anchor and the arrow variables. One
  // read because two reads could disagree, and the arrow landing 127px outside
  // a right-anchored popover was exactly that disagreement — a projected width
  // (`parentWidth × widthMultiplier`) used where the rendered width belonged.
  // No layout is written before this point in the tick, so it costs nothing
  // beyond the reflow the reference's own rect already forced.
  const hostRect = hostEl ? hostEl.getBoundingClientRect() : null

  // Decide placement. See `resolve-placement.ts` for the rule. `flip` defaults
  // to ON: an explicit side is a preference honoured while it works, not a
  // sticky instruction that lets the host be cut, and `'auto'` gets the same
  // fit ladder rather than returning before it. `flip: false` is the total
  // opt-out and takes no measurement. `hostEl` is absent on the composable
  // path unless the consumer passes it, which `measureHostExtent` reports as
  // "unmeasurable" (→ comparative fallback).
  const flip = opts.flip !== false
  const hostExtent = flip
    ? measureHostExtent(
        hostEl,
        placement === 'left' || placement === 'right' ? 'x' : 'y',
        maxHeightOpt,
        hostRect,
      )
    : null
  const { side: chosen, fit } = resolvePlacement(placement, spaces, rawSpaces, flip, hostExtent)

  const isHorizontal = chosen === 'left' || chosen === 'right'
  const placeBelow = chosen === 'bottom'
  const placeRight = chosen === 'right'

  // Reported raw, matching what `maxHeight` is derived from. A consumer given
  // the buffered number alongside a `maxHeight` computed from the raw one
  // cannot reconcile them, and the buffers are an internal preference weight,
  // not space the host is forbidden from using.
  const availableSpace = rawSpaces[chosen]
  const oppositeSpace = rawSpaces[OPPOSITE_SIDE[chosen]]

  // For vertical placement, maxHeight is clamped by the chosen vertical space.
  // For horizontal placement, the popover sits beside the reference (top-aligned
  // by default), so the relevant vertical extent is from `parentTop` down to
  // `boundaryRect.bottom`. Use that for the clamp instead of the (horizontal)
  // availableSpace, which is irrelevant to vertical sizing.
  //
  // The clamp reads `rawSpaces`, never `spaces`, and deliberately does not
  // depend on `hostExtent`: `measureHostExtent` answers with the host's
  // natural height or with the consumer's `maxHeight` depending on whether our
  // own clamp is currently binding, so any extent-dependent allowance
  // oscillates between the two forever.
  const verticalRoomForHorizontalHost = boundaryRect.bottom - parentTop
  const heightSource = isHorizontal ? verticalRoomForHorizontalHost : availableSpace
  const maxHeightStyle = Math.min(Math.max(heightSource, 0), maxHeightOpt)
  // The state that used to be invisible: there is no room on the chosen side
  // at all, so the host is being painted at nothing but its own padding, at
  // full opacity, with no attribute distinguishing it from a popover whose
  // content is simply short. Reported on the detail and mirrored to
  // `data-teleport-collapsed` — the fit verdict cannot carry this on its own,
  // because a host whose extent could not be measured is `'unmeasured'` and
  // collapsed at the same time.
  const collapsed = maxHeightStyle <= 0

  // Width. Mobile full-bleed (`100vw`) only kicks in for vertical placement —
  // an explicit horizontal placement keeps the multiplier-derived width on every
  // viewport size, so the host stays beside the reference instead of becoming a
  // full-width banner that swallows the layout. Explicit `maxWidth` (number or
  // CSS string) overrides BOTH the default multiplier and the mobile branch;
  // `matchWidth` still wins over `maxWidth` (consumer-explicit pinning beats
  // consumer-explicit clamping).
  const isMobileView = windowWidth < MOBILE_BREAKPOINT
  const isHorizontalPlacement = placement === 'left' || placement === 'right'
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
  const isFullBleed =
    isMobileView && !matchWidth && !hasExplicitMaxWidth && !isHorizontalPlacement
  const widthStyle = matchWidth
    ? `${parentWidth}px`
    : explicitMaxWidthStyle !== null
      ? explicitMaxWidthStyle
      : isFullBleed
        ? '100vw'
        : `${parentWidth * widthMultiplier}px`

  // Numeric host width used by overflow + cross-axis math. Mirrors the
  // numeric form of `widthStyle`. When `maxWidth` is a number it tracks the
  // explicit value; CSS-string `maxWidth` (e.g. `min(80vw, 400px)`) can't be
  // resolved without rendering, so the math falls back to the multiplier-derived
  // width — consumers using CSS-string forms accept this trade-off.
  const hostWidthNum = matchWidth
    ? parentWidth
    : isFullBleed
      ? windowWidth
      : hasExplicitMaxWidth && typeof maxWidthOpt === 'number'
        ? maxWidthOpt
        : parentWidth * widthMultiplier

  // The host's REAL width when we have a laid-out host, the projection above
  // when we do not (first tick, `display: none`, or the composable without a
  // host). Everything that derives the host's left edge from its width uses
  // this: `max-width` is a cap, not a width, so a right-anchored host — which
  // the `anchorRight` heuristic selects automatically past 71% of the viewport,
  // with no option set — is almost never as wide as its projection, and the
  // difference lands directly in `--teleport-arrow-x`.
  //
  // Safe against the feedback loop that governs the height axis: nothing here
  // makes the host's width depend on the side chosen or on its own left edge.
  const hostWidthActual = hostRect && hostRect.width > 0 ? hostRect.width : hostWidthNum

  // Horizontal anchor. Threshold check stays in viewport units — it asks
  // "is the reference near the right edge of what the user can see?" — and
  // the user's view is the viewport regardless of strategy.
  const anchorRight = parentRight >= windowWidth * WIDTH_THRESHOLD

  // Cross-axis alignment. When omitted, legacy behavior is preserved
  // (vertical: `anchorRight` heuristic decides between left/right; horizontal:
  // top-align). Any explicit value opts out of the heuristic.
  const crossAxisAlign = opts.crossAxisAlign

  // Coordinate values are subtracted from the offsetParent rect. When the
  // origin is the viewport (fixed strategy or absolute fallback),
  // `offsetParentRect.{top,left}` are 0 and `{right,bottom}` are
  // viewport size, so the formulas collapse to the prior viewport-only math.
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
  if (reduceMotion) {
    transformOrigin = ''
  } else if (chosen === 'bottom') transformOrigin = 'top'
  else if (chosen === 'top') transformOrigin = 'bottom'
  else if (chosen === 'right') transformOrigin = 'left'
  else transformOrigin = 'right'

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

  const styles: TeleportToStyles = {
    position: strategy,
    zIndex: String(zIndex),
    minWidth: minWidthStyle,
    maxWidth: widthStyle,
    maxHeight: `${maxHeightStyle}px`,
    transformOrigin,
    // Always written, never merely set. `matchWidth: true → false` left the
    // pinned `width` welded on forever, because nothing cleared it — the same
    // omission `top`/`bottom`/`left`/`right` are each explicitly guarded
    // against with `''`. Full-bleed writes a real width too: it used to write
    // only `max-width: 100vw`, a cap that leaves a narrow menu at its natural
    // width while `left: 0` drags it to the screen edge.
    width: matchWidth ? `${parentWidth}px` : isFullBleed ? '100vw' : '',
  }

  // Host's viewport-coord top edge for horizontal placement. Captured here
  // (rather than only inside the horizontal branch) so the arrow branch below
  // can reuse it without re-running the cross-axis math.
  let hostTopViewport: number | null = null

  if (isHorizontal) {
    // Horizontal placement: anchor the chosen edge of the host to the
    // corresponding edge of the reference (modulated by offsetX), and align on
    // the cross axis (vertical) per `crossAxisAlign` (default `'start'` —
    // top-align with the reference, modulated by offsetY). Mobile full-bleed
    // and viewport-edge `anchorRight` branches are intentionally bypassed —
    // the consumer explicitly chose horizontal, so we honor that placement on
    // every viewport size.
    if (crossAxisAlign === 'center') {
      // Vertical center — uses `maxHeightStyle` as the host-height proxy.
      hostTopViewport = parentTop + parentHeight / 2 - maxHeightStyle / 2 + offsetY
    } else if (crossAxisAlign === 'end') {
      // Bottom-align — host's bottom edge sits at the reference's bottom edge.
      hostTopViewport = parentBottom - maxHeightStyle + offsetY
    } else {
      // 'start' (default) — top-align.
      hostTopViewport = parentTop + offsetY
    }
    styles.top = `${hostTopViewport - offsetParentRect.top}px`
    styles.bottom = ''

    if (placeRight) {
      // Host's left edge sits at parentRight + offsetX.
      styles.left = `${parentRight - offsetParentRect.left + offsetX}px`
      styles.right = ''
    } else {
      // 'left': host's right edge sits at parentLeft - offsetX.
      // CSS right = (offsetParent.right - parentLeft) + offsetX.
      styles.right = `${offsetParentRect.right - parentLeft + offsetX}px`
      styles.left = ''
    }
  } else {
    // Vertical placement (existing behavior).
    if (placeBelow) {
      styles.top = `${topValue}px`
      styles.bottom = ''
    } else {
      styles.top = ''
      styles.bottom = `${bottomValue}px`
    }

    // Horizontal anchor (cross-axis) for vertical placement.
    //   1. Mobile full-bleed wins unconditionally: align the host's left edge
    //      with the viewport's left edge (for absolute mode that means a
    //      negative offset back out of any non-zero offsetParent.left).
    //   2. Explicit `crossAxisAlign` overrides the legacy `anchorRight`
    //      heuristic: 'start' = left-anchor, 'center' = horizontal center,
    //      'end' = right-anchor.
    //   3. When `crossAxisAlign` is omitted, the legacy `anchorRight`
    //      heuristic decides (right-anchor when ref past WIDTH_THRESHOLD).
    if (isFullBleed) {
      styles.left = `${0 - offsetParentRect.left}px`
      styles.right = ''
    } else if (crossAxisAlign === 'center') {
      const center = parentLeft + parentWidth / 2
      styles.left = `${center - hostWidthActual / 2 - offsetParentRect.left + offsetX}px`
      styles.right = ''
    } else if (crossAxisAlign === 'end') {
      styles.left = ''
      styles.right = `${rightValue}px`
    } else if (crossAxisAlign === 'start') {
      styles.left = `${leftValue}px`
      styles.right = ''
    } else if (anchorRight) {
      styles.left = ''
      styles.right = `${rightValue}px`
    } else {
      styles.left = `${leftValue}px`
      styles.right = ''
    }
  }

  // Overflow handling — applies along the chosen placement axis.
  //
  // For VERTICAL placement (`'top'` / `'bottom'` / `'auto'`), the placement axis
  // is vertical but the overflow axis is HORIZONTAL: a vertically-placed popover
  // overflows the viewport's left/right edges. The host's projected left/right
  // edges are derived from the chosen anchor:
  //   left-anchored  → hostLeft = parentLeft + offsetX
  //   right-anchored → hostRight = parentRight + offsetX, hostLeft = hostRight − hostWidth
  // Mobile full-bleed mode (`<768px` AND `!matchWidth`) already pins the host to
  // `left:0` with `100vw` width, so overflow is a no-op there.
  //
  // For HORIZONTAL placement (`'left'` / `'right'`), the placement axis IS the
  // overflow axis: the host extends beside the reference along the same axis it
  // could overflow on. Mobile full-bleed is already bypassed for horizontal, so
  // overflow is unconditionally eligible. The shift clamp also enforces a
  // no-overlap-with-reference invariant — shift never pushes the host onto the
  // reference. When that conflicts with fitting in the viewport, the no-overlap
  // constraint wins and the host is allowed to overflow (consumers wanting hard
  // visibility should pair with `flip: true`, which runs BEFORE the overflow
  // gate and resolves overflow by switching sides).
  //
  // Strategy-independent: viewport extents are the same whether `position`
  // resolves against the viewport (fixed) or the offsetParent (absolute), since
  // we map the offsetParent back to viewport coords via `offsetParentRect`.
  const overflow = opts.overflow ?? 'none'

  // Track the host's effective viewport-coord left edge for arrow math + the
  // overflow-shift clamp. For vertical placement this mirrors the cross-axis
  // branch above (mobile-fullbleed → 0; 'center' → parentLeft + parentWidth/2
  // − hostWidth/2 + offsetX; 'end' or anchorRight → parentRight − hostWidth +
  // offsetX; 'start' / default left-anchor → parentLeft + offsetX). For
  // horizontal placement, left-edge is irrelevant (the arrow uses the
  // top-edge instead) so the slot stays null.
  let hostLeftViewport: number | null = null
  if (!isHorizontal) {
    if (isFullBleed) {
      hostLeftViewport = 0
    } else if (crossAxisAlign === 'center') {
      hostLeftViewport = parentLeft + parentWidth / 2 - hostWidthActual / 2 + offsetX
    } else if (crossAxisAlign === 'end') {
      hostLeftViewport = parentRight + offsetX - hostWidthActual
    } else if (crossAxisAlign === 'start') {
      hostLeftViewport = parentLeft + offsetX
    } else if (anchorRight) {
      hostLeftViewport = parentRight + offsetX - hostWidthActual
    } else {
      hostLeftViewport = parentLeft + offsetX
    }
  }

  if (overflow !== 'none') {
    if (isHorizontal) {
      // Horizontal-placement overflow. Compute the host's viewport-coord
      // extents along the placement axis.
      let hostLeft: number
      let hostRight: number
      if (placeRight) {
        // Default: host's left edge anchored to parentRight; +offsetX displaces outward.
        hostLeft = parentRight + offsetX
        hostRight = hostLeft + hostWidthActual
      } else {
        // 'left': host's right edge anchored to parentLeft; +offsetX displaces outward (leftward).
        hostRight = parentLeft - offsetX
        hostLeft = hostRight - hostWidthActual
      }

      const overflowsLeft = hostLeft < 0
      const overflowsRight = hostRight > windowWidth

      if (overflow === 'hide') {
        if (overflowsLeft || overflowsRight) styles.visibility = 'hidden'
      } else if (overflow === 'shift' && (overflowsLeft || overflowsRight)) {
        if (placeRight) {
          // Clamp hostLeft into [parentRight, windowWidth − hostWidth]. When the
          // host can't fit without overlapping the reference (maxLeft < minLeft),
          // pin at parentRight (no overlap; accept overflow).
          const minLeft = parentRight
          const maxLeft = windowWidth - hostWidthActual
          const shiftedHostLeft =
            maxLeft < minLeft ? minLeft : Math.max(minLeft, Math.min(hostLeft, maxLeft))
          styles.left = `${shiftedHostLeft - offsetParentRect.left}px`
          styles.right = ''
        } else {
          // Clamp hostRight into [hostWidth, parentLeft]. When the host can't
          // fit without overlapping the reference (minRight > maxRight), pin at
          // parentLeft (no overlap; accept overflow on the left edge).
          const minRight = hostWidthActual
          const maxRight = parentLeft
          const shiftedHostRight =
            minRight > maxRight ? maxRight : Math.max(minRight, Math.min(hostRight, maxRight))
          styles.right = `${offsetParentRect.right - shiftedHostRight}px`
          styles.left = ''
        }
      }
    } else if (!isFullBleed) {
      // Vertical-placement overflow (existing behavior). Derive the host's
      // viewport-coord left edge from `hostLeftViewport`, which already
      // reflects `crossAxisAlign` ('center' / 'end' / 'start') and the legacy
      // `anchorRight` heuristic.
      const hostLeft = hostLeftViewport ?? parentLeft + offsetX
      const hostRight = hostLeft + hostWidthActual

      const overflowsLeft = hostLeft < 0
      const overflowsRight = hostRight > windowWidth

      if (overflow === 'hide') {
        // Omit the key when the host fits: the directive releases a prior hide
        // from the absence (see `releaseHide`), and the composable's consumer
        // sees the key disappear from the bound style record.
        if (overflowsLeft || overflowsRight) styles.visibility = 'hidden'
      } else if (overflow === 'shift' && (overflowsLeft || overflowsRight)) {
        // Shift mode: clamp hostLeft into [0, viewportWidth - hostWidth].
        // When the host is wider than the viewport, prefer left-edge alignment
        // (max(0, …) wins). Switch to a left-anchored CSS coordinate so the
        // clamp is expressed unambiguously regardless of original anchor.
        const maxLeft = Math.max(0, windowWidth - hostWidthActual)
        const shiftedHostLeft = Math.max(0, Math.min(hostLeft, maxLeft))
        styles.left = `${shiftedHostLeft - offsetParentRect.left}px`
        styles.right = ''
        // Arrow math should follow the shifted host position.
        hostLeftViewport = shiftedHostLeft
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
  // the consumer has not opted out.
  if (referenceHidden && opts.hideWhenReferenceHidden !== false) {
    // Overrides any prior decision (including `overflow: 'hide'` "fits").
    styles.visibility = 'hidden'
  }
  // No `else`: a visible reference simply does not assert a hide, and leaving
  // the key absent preserves an active `overflow: 'hide'` decision (host
  // overflows the viewport even though the reference is on screen) without a
  // second write.

  // Arrow position. Emitted only when `opts.arrow` resolves to a connected
  // element — both as the option-presence gate (consumer didn't ask for vars
  // unless they passed an arrow) and so a detached arrow mid-lifecycle clears
  // the vars on the next tick instead of leaking stale values.
  const arrowEl = toValue(opts.arrow)
  if (arrowEl && arrowEl.isConnected) {
    if (isHorizontal && hostTopViewport !== null) {
      // Arrow Y = reference vertical center − host top edge. `hostTopViewport`
      // already reflects `crossAxisAlign` ('start' / 'center' / 'end').
      const refCenterY = parentTop + parentHeight / 2
      styles['--teleport-arrow-x'] = '0px'
      styles['--teleport-arrow-y'] = `${refCenterY - hostTopViewport}px`
    } else if (hostLeftViewport !== null) {
      const refCenterX = parentLeft + parentWidth / 2
      styles['--teleport-arrow-x'] = `${refCenterX - hostLeftViewport}px`
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
  // Pass the host so `strategy: 'absolute'` can resolve `el.offsetParent`.
  const result = computePositionStyles(opts, el)
  if (!result) {
    // Reference is missing/detached — clear any stale placement signal so
    // consumer CSS (e.g. arrow rotation hooks) does not lock onto a value
    // that no longer reflects the layout. Same for the arrow CSS variables.
    delete el.dataset.teleportPlacement
    delete el.dataset.teleportFit
    delete el.dataset.teleportCollapsed
    el.style.removeProperty('--teleport-arrow-x')
    el.style.removeProperty('--teleport-arrow-y')
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

  if (styles.position !== undefined) s.position = styles.position
  if (styles.zIndex !== undefined) s.zIndex = styles.zIndex
  if (styles.minWidth !== undefined) s.minWidth = styles.minWidth
  if (styles.maxWidth !== undefined) s.maxWidth = styles.maxWidth
  if (styles.maxHeight !== undefined) s.maxHeight = styles.maxHeight
  if (styles.transformOrigin !== undefined) s.transformOrigin = styles.transformOrigin
  if (styles.width !== undefined) s.width = styles.width
  if (styles.top !== undefined) s.top = styles.top
  if (styles.bottom !== undefined) s.bottom = styles.bottom
  if (styles.left !== undefined) s.left = styles.left
  if (styles.right !== undefined) s.right = styles.right
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
  if (styles['--teleport-arrow-x'] !== undefined) {
    s.setProperty('--teleport-arrow-x', styles['--teleport-arrow-x'])
  } else {
    s.removeProperty('--teleport-arrow-x')
  }
  if (styles['--teleport-arrow-y'] !== undefined) {
    s.setProperty('--teleport-arrow-y', styles['--teleport-arrow-y'])
  } else {
    s.removeProperty('--teleport-arrow-y')
  }

  // Surface placement to consumer CSS without requiring the event subscription.
  // Consumers can target `[data-teleport-placement="top"]` for arrow rotation,
  // transition origin, etc.
  el.dataset.teleportPlacement = detail.placement
  // Surface the fit verdict for the same reason, and for one more: it is the
  // only signal that says "neither side of this axis can hold the host". That
  // state otherwise renders as a host clamped to a few px — or to none —
  // with nothing to distinguish it from a host that simply has short content.
  // `[data-teleport-fit="neither"]` gives CSS (and a test driving the real
  // DOM) something to read.
  el.dataset.teleportFit = detail.fit
  // And the one state `fit` cannot carry: the chosen side has no room at all,
  // so `max-height` is `0px` and the host paints as its own padding at full
  // opacity. `fit` reads `'unmeasured'` here whenever the host had no
  // measurable box — which is precisely when a consumer most needs to be told
  // that what they are looking at is not a short popover but an impossible
  // one. Present/absent rather than `"true"`/`"false"`, matching
  // `data-teleport-hidden`.
  if (detail.collapsed) el.dataset.teleportCollapsed = ''
  else delete el.dataset.teleportCollapsed
  // Surface lifecycle state so consumer CSS can hook open/close animations
  // via `[data-teleport-state="open"]` paired with a `transition: …` on
  // transform/opacity. Mirrors `placement` (set on every successful tick).
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
