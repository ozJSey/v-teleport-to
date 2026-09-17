/** Public and internal types for the teleport-to directive. */

// `MaybeRefOrGetter` — and the `toValue` that reads it in `calculate-position`,
// `auto-update` and `use-teleport-to` — arrived in Vue 3.3.0. Checked against
// the published packages, not the docs: 3.2.47, the last 3.2, exports neither.
// That is what sets this package's peer floor at `^3.3.0`.
import type { MaybeRefOrGetter } from 'vue'

/**
 * A "virtual reference" — anything that exposes a `getBoundingClientRect`
 * method but is NOT a real `Element`. Useful for positioning relative to a
 * synthetic origin: cursor/pointer coordinates, a `Range`-like selection rect,
 * a viewport-cursor combo, or any consumer-derived rectangle.
 *
 * Detection is structural: if the resolved `to` value has
 * `getBoundingClientRect` AND lacks `nodeType` (i.e. is not a DOM `Node`), it
 * is treated as a virtual reference. The connection check (`isConnected`) is
 * bypassed, and the auto-update observers (`ResizeObserver`,
 * `IntersectionObserver`, `MutationObserver`) are skipped — those require a
 * real `Element`. Consumers tracking a moving virtual rect should drive
 * recalcs by calling `update()` from the composable, or by triggering a
 * directive `updated` cycle (e.g. by mutating the bound options).
 *
 * The returned shape may be a full `DOMRect` or a partial `DOMRectInit` — the
 * directive normalizes missing fields (`right = left + width`, etc.).
 */
export type VirtualReference = {
  getBoundingClientRect: () => DOMRect | DOMRectInit
}

/** The four concrete sides the host can end up on. */
export type TeleportToSide = 'top' | 'bottom' | 'left' | 'right'

/**
 * Verdict of the fit test, run against the placement axis on every tick unless
 * `flip: false` opts out — including under the default `placement: 'auto'`,
 * which used to return before the test could run.
 *
 *   - `'fits'` — the preferred side could fit the host, so it was kept. This
 *     is reported even when the opposite side has MORE room: `flip` holds the
 *     side you asked for as long as it works.
 *   - `'flipped'` — the preferred side could not fit the host and the opposite
 *     side could, so the host was moved to the opposite side.
 *   - `'neither'` — neither side of the axis can fit the host. There is no
 *     right answer, so the side with more room was picked and `maxHeight` is
 *     clamped to whatever room that side has — possibly to `0`, in which case
 *     `collapsed` is also `true`. Treat this as "the boundary is too small for
 *     this host": either give the boundary more room, lower `maxHeight`, or
 *     hide the host yourself.
 *   - `'unmeasured'` — no fit test ran, and the side came from the sticky /
 *     comparative rule instead. Two causes: `flip: false` (nothing to decide),
 *     or the host's extent along the axis could not be read (see `flip`).
 */
export type TeleportToFit = 'fits' | 'flipped' | 'neither' | 'unmeasured'

export type TeleportToOptions = {
  /**
   * Reference to position relative to. Required.
   *
   * Accepts any of:
   *   - a plain `HTMLElement`
   *   - a `Ref<HTMLElement | null>` (e.g. a Vue template ref)
   *   - a `() => HTMLElement | null` getter
   *   - a `VirtualReference` — any object with a `getBoundingClientRect()`
   *     method (cursor coords, selection range, etc.)
   *
   * Resolution happens at every calculation tick (mount, update, scroll,
   * resize, manual `update()`), so a ref/getter that yields `null` initially
   * and is populated later is supported — once it resolves to a connected
   * element (or a virtual reference), the next scroll/resize tick (or
   * directive update) will position the host.
   *
   * Virtual references skip the `isConnected` check and the `autoUpdate`
   * observer attachment; consumers should call `update()` (composable) or
   * trigger a directive update to recalc on cursor/range changes.
   */
  to: MaybeRefOrGetter<HTMLElement | VirtualReference | null | undefined>
  /**
   * Placement preference — a *preference*, honoured while the host fits there.
   * Default: `'auto'`.
   *
   *   - `'auto'` — vertical-axis only: prefers `'top'` or `'bottom'` by which
   *     side has more space, then applies the same fit test an explicit side
   *     gets, so the host lands on a side it fits on when one exists. Does not
   *     pick `'left'` / `'right'` (back-compat).
   *   - `'top'` / `'bottom'` — vertical placement.
   *   - `'left'` / `'right'` — horizontal placement: the host is positioned
   *     beside the reference along the chosen side, top-aligned with the
   *     reference (modified by `offsetY`). `widthMultiplier` and `matchWidth`
   *     still control the host's width. The mobile full-bleed branch
   *     (`window.innerWidth < 768`) is bypassed when an explicit horizontal
   *     side is requested.
   *
   * Flipping along the chosen axis (top↔bottom, left↔right) is on by default;
   * pass `flip: false` to pin the side even when the host does not fit.
   */
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right'
  /** Max height of the positioned element in px. Default: 240 */
  maxHeight?: number
  /** Width multiplier relative to the reference element. Default: 1.5 */
  widthMultiplier?: number
  /**
   * Explicit upper bound for the host width. Overrides the default
   * `parentWidth × widthMultiplier` and the mobile fullbleed (`100vw`,
   * `<768px` viewport) branch — useful when the popover/dropdown must not
   * exceed a card or column width regardless of how wide the reference is.
   *
   *   - `number` → emitted as `${n}px` (e.g. `320` → `'320px'`). The numeric
   *     value is also used by the `overflow: 'shift'` clamp as the host's
   *     effective width.
   *   - `string` → passed through as-is (any valid CSS width: `'320px'`,
   *     `'80vw'`, `'min(80vw, 400px)'`, `'clamp(160px, 50vw, 320px)'`, …).
   *     For CSS-string values the `overflow: 'shift'` clamp falls back to
   *     `parentWidth × widthMultiplier` for sizing — pair with a numeric
   *     value when overflow accuracy matters.
   *
   * Coexists with `matchWidth`: when both are set, `matchWidth` wins (the
   * consumer was explicit about pinning the host to the reference width).
   * When omitted (default), prior behavior is preserved.
   *
   * `maxWidth: 0` is a valid value and emits `'0px'` (collapses the host) —
   * the option only short-circuits when `undefined`. The `min-width: <reference
   * width>` floor yields to this ceiling, so narrowing the host below the
   * reference works; before it did not, and `maxWidth: 0` rendered at the
   * reference's full width.
   */
  maxWidth?: number | string
  /** Vertical offset from the reference element in px. Default: 0 */
  offsetY?: number
  /** Horizontal offset in px. Default: 0 */
  offsetX?: number
  /** Z-index. Default: 1201 */
  zIndex?: number
  /** If true, match reference element width exactly. Default: false */
  matchWidth?: boolean
  /** Enable/disable. Default: true */
  enabled?: boolean
  /**
   * Move the host to the opposite side along the placement axis when the
   * preferred side cannot fit it. **Default: `true`.**
   *
   *   - `'top'` ↔ `'bottom'` (vertical axis)
   *   - `'left'` ↔ `'right'` (horizontal axis)
   *
   * The default used to be `false`, and `'auto'` — itself the default
   * `placement` — ignored this option entirely. So a bare
   * `v-teleport-to="{ to: ref }"` never asked whether the host fitted where it
   * was put; it was clamped into whatever room that side had, down to
   * `max-height: 0px`. `placement` is a preference now, honoured while it
   * works; `flip: false` is the opt-out for a genuinely pinned side, and it
   * skips the measurement entirely.
   *
   * **Fit-based, not comparative.** The preferred side is held for as long as
   * it works, even when the opposite side has more room — `flip` is not a
   * synonym for `'auto'`. Per tick, along the placement axis:
   *
   *   1. preferred side fits the host → stay (`fit: 'fits'`)
   *   2. it cannot, the opposite side can → flip (`fit: 'flipped'`)
   *   3. neither can → the side with more room wins, so there is still a
   *      defined answer (`fit: 'neither'`)
   *
   * "Fits" means the space between the reference and that edge of the
   * `boundary` is at least the host's own extent along the axis — its
   * `getBoundingClientRect()` height for `'top'` / `'bottom'`, its width for
   * `'left'` / `'right'`. The edge buffers this library reserves against the
   * boundary (`BUFFER_BOTTOM` / `BUFFER_TOP`) are deliberately NOT subtracted
   * here or from `maxHeight`: they are absolute constants, so charging them to
   * a 200px scroll pane made "neither fits" the permanent answer and cut a
   * host that had room. They weight the `'auto'` preference between two sides
   * and nothing else.
   *
   * The host's box is read once per tick when there is a host to read (the
   * same read feeds the cross-axis and arrow math); `flip: false` skips it.
   *
   * **Keep the host's box size independent of its placement.** The host is
   * measured, so a host that changes size in response to the side it was given
   * can chase itself between the two. An absolutely-positioned arrow that
   * swaps edges on `[data-teleport-placement]` is fine — it changes neither
   * the host's width nor its height. Content that reflows to a different
   * height depending on the placement is not.
   *
   * **When the host cannot be measured** — it has no laid-out box yet, it (or
   * an ancestor) is `display: none`, or you are using `useTeleportTo` without
   * passing it the host element — there is no honest fit answer, so the
   * placement degrades to the comparative rule (pick the side with more room,
   * ties going to the preferred side) and reports `fit: 'unmeasured'`. A zero
   * measurement is treated as "unknown", never as "fits anywhere". Pass the
   * host to `useTeleportTo(options, hostRef)` to get the fit test there too.
   *
   * Applies to `placement: 'auto'` as well: `'auto'` picks the preferred side
   * comparatively and then runs the same ladder on it.
   *
   * Use this for popovers/dropdowns that prefer one side but should not be
   * squeezed when scrolled to the edge of the boundary.
   */
  flip?: boolean
  /**
   * Clipping boundary for the available-space math. The placement decision
   * (top vs bottom in `'auto'` mode) and the resulting `maxHeight` are
   * computed against this boundary instead of the viewport.
   *
   * Accepts:
   *   - `'viewport'` (default) — use `window.innerHeight` / `innerWidth`.
   *   - an `HTMLElement` — use its `getBoundingClientRect()`. Useful when the
   *     reference element lives inside a scrollable container with limited
   *     vertical room. A detached/disconnected element transparently falls
   *     back to viewport.
   *
   * Note: only the available-space math is clipped. The emitted CSS values
   * remain viewport-relative because the host uses `position: fixed`.
   */
  boundary?: HTMLElement | 'viewport'
  /**
   * CSS positioning strategy applied to the host element.
   *
   *   - `'fixed'` (default) — coordinates are viewport-relative. Best for
   *     dropdowns/popovers that should escape clipping/overflow ancestors.
   *   - `'absolute'` — coordinates are relative to the host's nearest
   *     positioned ancestor (its `offsetParent`). Use this when the host lives
   *     inside a scrolling parent and should track that parent's content.
   *
   * In `'absolute'` mode the origin is that ancestor's PADDING box, in the
   * ancestor's own scrolled content coordinates — its border widths
   * (`clientTop` / `clientLeft`), its padding-box size (`clientWidth` /
   * `clientHeight`) and its `scrollTop` / `scrollLeft` are all terms in the
   * coordinates written. `position: relative` + `overflow: auto` on the same
   * element is therefore a supported shape, and the common one.
   *
   * In `'absolute'` mode, when no offsetParent is available (or the host is
   * not yet attached), the math falls back to viewport-relative coordinates
   * so detached/unmounted hosts do not throw.
   *
   * The `useTeleportTo` composable does not know the host element it will be
   * applied to; in the composable, `'absolute'` always uses the viewport
   * fallback. Consumers who need true offsetParent-relative coordinates
   * should reach for the directive form.
   */
  strategy?: 'fixed' | 'absolute'
  /**
   * How to handle the case where the host (after the offset / anchor / width
   * math) would extend past the viewport edge along the placement axis.
   *
   * Applies to BOTH vertical and horizontal placement. For vertical placement
   * (`'auto'` / `'top'` / `'bottom'`), the overflow axis is HORIZONTAL — the
   * host overflows the left or right viewport edge. For horizontal placement
   * (`'left'` / `'right'`), the overflow axis IS the placement axis — the host
   * overflows the right edge for `placement: 'right'`, or the left edge for
   * `placement: 'left'`.
   *
   *   - `'none'` (default) — preserve existing behavior; the host may overflow.
   *   - `'shift'` — clamp the host's position so it stays inside the viewport.
   *     The directive switches to a left- or right-anchored coordinate as
   *     appropriate and emits the clamped value. For horizontal placement,
   *     the shift also enforces a no-overlap-with-reference invariant: when
   *     the host can't fit without overlapping the reference, the no-overlap
   *     constraint wins and the host overflows (use `flip: true` for hard
   *     visibility).
   *   - `'hide'` — hide the host with `visibility: 'hidden'` when the
   *     HOST's own box overflows, and restore the consumer's own inline
   *     `visibility` when it fits again. This is not "hide when the reference
   *     scrolls away" — that is `hideWhenReferenceHidden`, which is on by
   *     default and watches the reference. `display` is never written, so `v-show`
   *     / `v-if` / cascade `display` rules keep working; the hide is marked
   *     with `data-teleport-hidden` on the host (both an ownership record and
   *     a CSS hook), and the directive only ever clears a hide it applied.
   *
   * Mobile full-bleed mode (`window.innerWidth < 768`, `matchWidth: false`,
   * vertical placement) already pins the host to `left: 0` with width `100vw`;
   * in that mode the `overflow` option is a no-op for vertical placements.
   * Horizontal placement bypasses mobile full-bleed, so overflow is always
   * eligible there.
   */
  overflow?: 'shift' | 'hide' | 'none'
  /**
   * Side-effect callback invoked once per successful position calculation,
   * immediately after the inline styles are applied and the
   * `teleport-positioned` event is dispatched. Receives the same detail
   * payload as the event.
   *
   * Useful for composable consumers and for cases where the host element
   * lives inside a nested template where attaching a `teleport-positioned`
   * event listener is awkward.
   *
   * The callback is *not* invoked when the reference element is missing or
   * detached, nor when the directive is disabled (`enabled: false`).
   *
   * If the callback throws, the error is caught and logged via
   * `console.error` so a misbehaving callback cannot break the directive's
   * RAF loop or the composable's reactive update path.
   */
  onPositioned?: (detail: TeleportToEventDetail) => void
  /**
   * Side-effect callback invoked only when the chosen placement *changes*
   * between consecutive successful position calculations. Receives the
   * previous placement and the new one.
   *
   * On the very first successful tick, fires with `prev: null, next: chosen`.
   * After that, fires only when `chosen` differs from the cached previous
   * value — useful for triggering CSS transitions or re-animating an arrow on
   * a flip without per-tick noise (`onPositioned` covers per-tick needs).
   *
   * Skipped when the reference is missing/detached or the directive is
   * disabled (`enabled: false`). Both of those branches also reset the
   * internal previous-placement cache to `null`, so the next successful tick
   * re-fires with `prev: null, next: chosen`.
   *
   * If the callback throws, the error is caught and logged via
   * `console.error` (same posture as `onPositioned`) so a misbehaving
   * callback cannot break the directive's RAF loop or the composable's
   * reactive update path.
   */
  onPlacementChange?: (
    prev: 'top' | 'bottom' | 'left' | 'right' | null,
    next: 'top' | 'bottom' | 'left' | 'right',
  ) => void
  /**
   * Optional arrow element. When provided and connected, the directive emits
   * two CSS custom properties on the host:
   *
   *   - `--teleport-arrow-x` — for vertical placements (`'top'` / `'bottom'`),
   *     the horizontal distance from the host's left edge to the reference
   *     element's horizontal center, in `px`. For horizontal placements
   *     (`'left'` / `'right'`), this is `0px`.
   *   - `--teleport-arrow-y` — for horizontal placements, the vertical distance
   *     from the host's top edge to the reference element's vertical center,
   *     in `px`. For vertical placements, this is `0px`.
   *
   * Consumer CSS pins the arrow to the host edge facing the reference and
   * slides it along the perpendicular axis using the var, e.g.:
   *
   * ```css
   * [data-teleport-placement="bottom"] .arrow {
   *   top: 0;
   *   left: var(--teleport-arrow-x);
   *   transform: translate(-50%, -50%);
   * }
   * ```
   *
   * Accepts the same shape as `to`: a plain `HTMLElement`, a
   * `Ref<HTMLElement | null>`, or a getter. When the arrow becomes detached
   * (e.g. removed from the DOM mid-lifecycle), the next calculation tick
   * clears the CSS variables so consumer styles do not lock onto stale
   * values.
   *
   * The arrow element itself is not styled by the directive — it is referenced
   * solely so the directive can detect detachment and clear the vars; the
   * positioning math is exposed exclusively via the two custom properties.
   */
  arrow?: MaybeRefOrGetter<HTMLElement | null | undefined>
  /**
   * Cross-axis alignment of the host relative to the reference element.
   *
   * The cross axis is the axis perpendicular to `placement`:
   *   - For vertical placement (`'auto'` / `'top'` / `'bottom'`), the cross
   *     axis is HORIZONTAL: `'start'` left-anchors the host's left edge to
   *     the reference's left edge, `'center'` horizontally centers the host
   *     on the reference, `'end'` right-anchors the host's right edge to the
   *     reference's right edge.
   *   - For horizontal placement (`'left'` / `'right'`), the cross axis is
   *     VERTICAL: `'start'` top-aligns the host's top edge with the
   *     reference's top edge (current default behavior), `'center'`
   *     vertically centers the host on the reference, `'end'` bottom-aligns
   *     the host's bottom edge with the reference's bottom edge.
   *
   * When OMITTED, the legacy implicit `anchorRight` heuristic stays in play
   * for vertical placement (the host auto-switches to a right-anchored
   * coordinate when the reference sits past `WIDTH_THRESHOLD` of the
   * viewport width). Passing any explicit value — including `'start'` — opts
   * out of that heuristic.
   *
   * For horizontal `'center'` / `'end'`, the host's height is treated as
   * `maxHeight` for the alignment math (the host's actual rendered height is
   * not measured). Use a smaller `maxHeight` if you need tighter alignment.
   *
   * Mobile full-bleed mode (`window.innerWidth < 768` AND `!matchWidth` AND
   * vertical placement) still pins the host to `left: 0` with `100vw` width;
   * `crossAxisAlign` is a no-op in that mode.
   */
  crossAxisAlign?: 'start' | 'center' | 'end'
  /**
   * When `true`, subscribe a `ResizeObserver`, an `IntersectionObserver`, and
   * a `MutationObserver` to the resolved reference element so the host
   * re-positions on layout changes that don't bubble through
   * `scroll` / `resize` — for example:
   *
   *   - reference's `offsetWidth` / `offsetHeight` changing because content
   *     reflowed inside it (caught by `ResizeObserver`)
   *   - an image inside the reference finishing lazy-load
   *   - a sibling element inserted/removed above the reference, shifting it
   *     downward
   *   - the reference's own visibility changing as ancestors scroll into and
   *     out of view (caught by `IntersectionObserver`)
   *   - `style` / `class` attribute mutations on the reference, child
   *     additions/removals, or text changes that shift the visible content
   *     without changing the bounding box (caught by `MutationObserver`)
   *
   * Default: `false` — opt-in for back-compat. All three observers are
   * attached on `mounted` (after the resolved `to` element is connected) and
   * disconnected on `unmounted` (or `onScopeDispose` for the composable form).
   *
   * The `IntersectionObserver` uses the resolved `boundary` option as its
   * `root` when boundary is an `HTMLElement`, otherwise the viewport (`null`).
   *
   * The `MutationObserver` watches `attributes` (filtered to `style` + `class`
   * to avoid trampoline loops on unrelated attribute writes), `childList`, and
   * `characterData`. Subtree mutations are NOT observed by default — they are
   * usually noise for positioning math.
   *
   * Gracefully degrades: when any of these observer constructors is undefined
   * (very old browsers, SSR, certain test environments), the directive falls
   * back to the others and to the existing `scroll` / `resize` listeners
   * without throwing.
   *
   * All three observer callbacks ultimately route through the same RAF-batched
   * `scheduleUpdate` path used by `scroll` / `resize`, so multiple observer
   * callbacks within a frame collapse into a single recalc.
   */
  autoUpdate?: boolean
  /**
   * When `true` AND `autoUpdate: true`, initialize the `MutationObserver` with
   * `subtree: true` so deep mutations *inside* the reference element (any
   * descendant's `style` / `class` change, child insertion/removal, or text
   * mutation) trigger a recalc.
   *
   * Default: `false`. Subtree observation is opt-in because chatty subtrees
   * (e.g. a reference that contains a virtualized list, an animated child, or
   * any continuously-mutating descendant) can cause trampoline recalc loops
   * that are wasteful for positioning math.
   *
   * No effect when `autoUpdate` is falsy. The `attributeFilter` (`['style',
   * 'class']`), `childList`, and `characterData` settings are unchanged — the
   * subtree flag only widens the *scope* of those observations from the
   * direct reference to its entire descendant tree.
   *
   * Toggling this flag mid-life (with the same `to` element) re-attaches the
   * `MutationObserver` so the new subtree setting takes effect immediately.
   */
  autoUpdateSubtree?: boolean
  /**
   * Override the element(s) that the directive listens on for `scroll` events.
   *
   *   - `'window'` (default) — attach to `window` with `{ capture: true }` so
   *     scrolls on any nested scroll container in the document also drive
   *     recalcs. Highest coverage; lowest performance ceiling for very deep
   *     pages with many scroll containers.
   *   - an `HTMLElement` — attach the listener directly on that element with
   *     `{ capture: true }`. The capture phase still catches scrolls on
   *     descendant scroll containers inside the supplied element, but events
   *     elsewhere in the document do not trigger recalcs. Use this when the
   *     reference element lives inside a known scrolling container and the
   *     rest of the page's scroll activity is irrelevant to the host's
   *     position.
   *   - an `HTMLElement[]` — attach the listener to EACH connected element in
   *     the array. Useful when the reference is nested inside multiple
   *     independent scrolling ancestors that don't share a single common
   *     scroll container (e.g. an inner scroll pane inside an outer scroll
   *     pane, neither of which delegates scroll to `window`). Detached
   *     entries are silently skipped — no fallback to `window`, because the
   *     consumer explicitly enumerated the targets. An empty array means no
   *     scroll listener at all (the host will only update on `resize` /
   *     observer events / manual `update()`).
   *
   * Switching the value mid-life (via a directive `update` or a reactive
   * options change in the composable) detaches the listener from any target
   * that is no longer part of the next set and attaches to any target that is
   * new — targets present in both the old and new set are NOT touched, so a
   * partial swap does not interrupt the listener for retained targets. When
   * a single `scrollContainer` HTMLElement becomes detached, the directive
   * falls back to `window` so the host stays responsive instead of going
   * dead. (Array form does not fall back; see above.)
   *
   * The `resize` listener is unaffected — it always lives on `window`.
   */
  scrollContainer?: HTMLElement | HTMLElement[] | 'window'
  /**
   * Hide the host (`visibility: 'hidden'`) while the reference element is
   * **fully out of view**, and show it again the moment any part of the
   * reference comes back.
   *
   * **Default: `true`.** A popover whose reference has scrolled away has
   * nothing to anchor to, so it is left floating over unrelated content —
   * which is never what you wanted. Pass `false` to opt out.
   *
   * "Out of view" is measured against the intersection of `boundary` and the
   * viewport, and it is a plain 2D test on all four sides:
   *
   * ```
   * clip = intersect(boundaryRect, viewportRect)
   * hidden = refBottom <= clip.top  || refTop  >= clip.bottom
   *       || refRight  <= clip.left || refLeft >= clip.right
   * ```
   *
   * Consequences worth knowing:
   *   - It is **binary, not a ratio** — a reference with one pixel showing is
   *     still a reference, and a dropdown whose trigger is half on screen
   *     should stay put.
   *   - Touching counts as hidden (`<=` / `>=`), matching Floating UI.
   *   - A reference inside a `boundary` pane that has *itself* scrolled off
   *     the screen counts as hidden — that is what the viewport intersection
   *     buys over a boundary-only test.
   *   - A `display: none` reference reports an all-zero rect, so it hides
   *     rather than silently teleporting the host to `(0, 0)`.
   *
   * No clipping-ancestor walk is performed: this library reads the
   * reference's rect and nothing else, and an ancestor walk would cost an
   * O(depth) `getComputedStyle` sweep on every frame of every scroll. A
   * reference clipped by an `overflow: hidden` ancestor that is *itself* on
   * screen therefore still counts as visible — pass that ancestor as
   * `boundary` when you need it accounted for.
   *
   * Uses the same never-touch-`display` mechanism as `overflow: 'hide'`: the
   * hide is written as `visibility`, marked with `data-teleport-hidden` on the
   * host, and only ever cleared by the directive that applied it — so
   * `v-show` / `v-if` / cascade `display` rules keep working, and the
   * consumer's own inline `visibility` is restored verbatim on show.
   *
   * Independent from `overflow: 'hide'`, and combinable with it:
   *   - `overflow: 'hide'` keys off whether the *host* overflows the viewport
   *     after the positioning math.
   *   - `hideWhenReferenceHidden` keys off whether the *reference* is out of
   *     view, regardless of where the host landed.
   *
   * Either signal hides. `TeleportToEventDetail` reports them apart:
   * `referenceHidden` is this predicate's raw answer (measured and reported
   * even when you have opted out, so you can drive a `v-if` yourself) and
   * `hidden` is whether the host actually ended up hidden this tick.
   *
   * Leaving this on also puts a floor under the `scroll` listener: `window`
   * is attached in addition to any `scrollContainer` you name, because a
   * reference can leave the viewport through a page scroll the named
   * container never sees. Opting out removes the floor too.
   */
  hideWhenReferenceHidden?: boolean
}

export type TeleportToEventDetail = {
  placement: TeleportToSide
  /**
   * Available space (px) on the chosen side: the raw, boundary-clipped gap
   * between the reference and that edge of the boundary. For vertical
   * placements this is vertical space; for horizontal placements
   * (`'left'` / `'right'`) this is horizontal space to the chosen side.
   *
   * The reserved edge buffers are **not** subtracted. They used to be, which
   * made this number irreconcilable with `maxHeight` — the buffers now only
   * weight the `'auto'` preference between two sides, and `maxHeight` is
   * `min(this, your maxHeight)` for vertical placements.
   *
   * Can be negative: the reference is past that edge of the boundary.
   */
  availableSpace: number
  /**
   * Available space (px) on the OTHER side of the same axis — the side that
   * was not chosen — measured exactly like `availableSpace`.
   *
   * Reported so a consumer can explain the placement decision (and render
   * both sides of it) without re-measuring the rects.
   */
  oppositeSpace: number
  /**
   * Outcome of the `flip` fit test for this tick. `'unmeasured'` whenever no
   * fit test ran — see `TeleportToFit`. Mirrored onto the host as
   * `data-teleport-fit` by the directive, so `fit === 'neither'` (the host is
   * clamped to a side that cannot hold it, possibly to `0` height) is
   * observable from CSS as well as from this event.
   */
  fit: TeleportToFit
  /** The `max-height` (px) actually written on the host this tick. */
  maxHeight: number
  /**
   * Whether `maxHeight` came out at `0` — the chosen side has no room at all,
   * so the host is painted at nothing but its own padding, fully opaque, with
   * nothing else to distinguish it from a popover whose content is short.
   *
   * Mirrored onto the host as `data-teleport-collapsed` (present/absent).
   * Separate from `fit` on purpose: a host with no measurable box reports
   * `fit: 'unmeasured'` and is collapsed at the same time, which is exactly
   * the case that used to render as an invisible 10px box with no signal.
   */
  collapsed: boolean
  /**
   * Whether the host's own content is **taller than the `max-height` being
   * written** — the popover you are looking at is not short, it is cut.
   *
   * Mirrored onto the host as `data-teleport-truncated` (present/absent).
   *
   * This is deliberately NOT folded into `fit`. `fit` answers "does the host,
   * at the size it will render, fit on this side", and `'fits'` stays the
   * correct answer when the thing that made it that size was your own
   * `maxHeight` (or ours, defaulting to 240). Cutting is a separate fact, and
   * it is the one the fit verdict structurally cannot carry: a host clamped by
   * `maxHeight` fits on both sides and is cut on both.
   *
   * Whether to raise `maxHeight`, scroll the host or shorten the content is
   * your call — being told is not optional.
   */
  truncated: boolean
  /**
   * The host's natural content width (px), measured under the width
   * constraints this tick applies and with no side coordinate in the way, or
   * `null` when the host has no box even then (a `display: none` ancestor) —
   * and when there is no host at all, which is the `useTeleportTo` case where
   * the composable was given no element.
   *
   * This is the number the fit test used, exposed so a consumer can explain
   * the decision — `contentHeight` against `availableSpace` and `maxHeight` is
   * the whole verdict.
   */
  contentWidth: number | null
  /**
   * The host's natural content height (px) at `contentWidth`, with no
   * `max-height` in the way, or `null` on the same terms as `contentWidth`.
   *
   * `contentHeight > maxHeight` is exactly `truncated`.
   */
  contentHeight: number | null
  /**
   * Whether the reference element was **fully out of view** on this tick,
   * measured against `intersect(boundary, viewport)` on all four sides.
   *
   * This is the raw measurement, not the decision: it is reported the same
   * way whether or not `hideWhenReferenceHidden` is on. That is the point —
   * a consumer who wants the host *unmounted* rather than merely invisible
   * passes `hideWhenReferenceHidden: false` and drives a `v-if` off this.
   */
  referenceHidden: boolean
  /**
   * Whether the directive actually hid the host on this tick — i.e. whether
   * it wrote `visibility: 'hidden'` and stamped `data-teleport-hidden`.
   *
   * True when `referenceHidden` is true and hiding is not opted out, OR when
   * `overflow: 'hide'` fired because the host itself overflowed. Reading
   * `hidden` without `referenceHidden` therefore cannot tell you *why*; read
   * both.
   */
  hidden: boolean
}

/** Internal per-element state stored in a WeakMap. */
export type DirectiveState = {
  resizeHandler: () => void
  scrollHandler: () => void
  rafId: number | null
  options: TeleportToOptions
  /**
   * Last successfully-computed placement, or `null` when none has been
   * computed yet (or when the directive was last disabled / had a missing
   * reference). Used to gate `onPlacementChange` invocations.
   */
  prevPlacement: 'top' | 'bottom' | 'left' | 'right' | null
  /**
   * `ResizeObserver` instance attached to the currently observed reference
   * element when `autoUpdate: true`. `null` otherwise (or when the host
   * environment lacks `ResizeObserver`).
   */
  resizeObserver: ResizeObserver | null
  /**
   * `IntersectionObserver` instance attached to the currently observed
   * reference element when `autoUpdate: true`. `null` otherwise (or when
   * the host environment lacks `IntersectionObserver`).
   */
  intersectionObserver: IntersectionObserver | null
  /**
   * `MutationObserver` instance attached to the currently observed reference
   * element when `autoUpdate: true`. Catches `style` / `class` attribute
   * mutations + `childList` + `characterData` changes — layout-affecting
   * mutations that don't bubble through `scroll`/`resize` and that
   * `ResizeObserver` may miss when the bounding box stays the same but the
   * visible content shifts. `null` otherwise (or when the host environment
   * lacks `MutationObserver`).
   */
  mutationObserver: MutationObserver | null
  /**
   * The HTMLElement currently observed by the auto-update observers, or
   * `null` when no element is observed. Used so a `to` ref/getter that
   * resolves to a different element across updates correctly re-attaches
   * the observers without leaking the old subscription.
   */
  observedToEl: HTMLElement | null
  /**
   * Cached `subtree` value last passed to the `MutationObserver` for the
   * currently-observed element. Used to detect a mid-life flip of
   * `autoUpdateSubtree` so the observers can be re-attached with the new
   * setting (the same element with a different subtree flag would otherwise
   * short-circuit the `observedToEl === toEl` no-op branch).
   */
  observedSubtree: boolean
  /**
   * The set of `EventTarget`s (window and/or HTMLElement[s]) that the `scroll`
   * listener is currently attached to. Tracked so that a mid-life change to
   * `scrollContainer` can diff against the next resolved set and only detach
   * from removed targets / attach to added targets without leaking listeners
   * on retained ones. Always non-null after `mounted` (may be `[]` if the
   * consumer passed an empty array).
   */
  scrollTargets: EventTarget[]
}
