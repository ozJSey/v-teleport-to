/**
 * The host's NATURAL extent — the one measurement the placement decision is
 * allowed to depend on.
 *
 * ## Why this module exists
 *
 * The fit test asks a question about the CONTENT: "how much room does this
 * host need?" Every version of this library before 1.1.0 answered it by
 * reading the host's *current rendered box*, and that box is not the content.
 * It is the content after four things have happened to it, three of which this
 * library or the consumer caused:
 *
 *   1. `display: none` — a dropdown that has never been opened has no box at
 *      all. Measured `null`, reported `fit: 'unmeasured'`, and because nothing
 *      ever re-measured, that verdict was permanent (TT-17). Writing `v-show`
 *      AFTER the directive — the order the README teaches — put every host in
 *      this state on every open.
 *   2. A closed state that COLLAPSES the box. `[data-teleport-state="closed"]
 *      { max-height: 0 }` is the animation the README itself suggests; at
 *      measure time it reported 18px of padding for a 127px tooltip, so the
 *      cramped side "fitted" and the user read 13 of 36 words. `fit` said
 *      `'fits'` (TT-18). This is the case that matters most, because the
 *      measurement did not fail — it succeeded and lied.
 *   3. Our own `max-height` clamp, written from the side we chose last tick.
 *      Reading through it is circular, and the old code papered over the
 *      circularity by answering with the consumer's `maxHeight` OPTION
 *      instead — so the content's real size never entered the decision and
 *      anything taller than `DEFAULT_MAX_HEIGHT` was cut in silence (TT-19).
 *   4. On the horizontal axis, the side coordinate itself. A host placed with
 *      `left: <x>` and `width: auto` is shrink-to-fit CAPPED at
 *      `containing block − left` (CSS 2.2 §10.3.7), i.e. capped at the space
 *      on the side being tested — so `room >= hostWidth` was
 *      `room >= min(natural, room)`, true by construction. Measured: room
 *      240px, natural 320px, rendered 240px, verdict `fits`, 1000px of unused
 *      room on the other side.
 *
 * ## What it does instead
 *
 * One synchronous probe: neutralise everything that is not the content, read
 * the rect, put it all back. Nothing paints in between — a style write and a
 * forced layout inside the same task are invisible — and the element is
 * byte-identical afterwards, because the whole `style` attribute is captured
 * and restored verbatim rather than key by key.
 *
 * Neutralised, and why each one:
 *
 * | Written                        | Undoes |
 * |--------------------------------|--------|
 * | `data-teleport-state="open"`   | the consumer's closed-state rules (2) — this is the state the fit test is asking about |
 * | inline `display` cleared       | `v-show` (1) |
 * | `position` + `top/left: 0`, `right/bottom: auto` | the side coordinate's shrink-to-fit cap (4), and puts the host in the same containing block it will end up in |
 * | `max-height: none`, `height: auto` | our own clamp (3) and a `height: 0` closed state |
 * | `min-width` / `max-width` / `width` | applies the width the host is ABOUT to get, so wrapping text is measured at its real line length rather than at whatever width it happened to have in flow — the no-animation half of TT-18 |
 * | `transform: none`              | a `scaleY(0)` closed state, which scales the rect |
 * | `transition` / `animation: none` | a value still in flight from the last state change |
 *
 * All of it `!important`, because an inline important declaration outranks an
 * author important one — which `[data-teleport-state="closed"] { max-height: 0
 * !important }`, the exact shape in the owner's report, relies on.
 *
 * `data-teleport-placement` is REMOVED for the duration. That is the whole
 * point of the module: the number handed to `resolvePlacement` must not depend
 * on the side `resolvePlacement` chose last time, or the two sides take turns
 * forever. Content keyed on the placement attribute is the one remaining way a
 * consumer can reopen that loop, and the README says so.
 *
 * ## The two livelocks this must never reintroduce
 *
 * Both were found by driving the playground in a real browser, both surfaced
 * as a Vue "Maximum recursive updates exceeded", and neither is visible to
 * jsdom:
 *
 * - **`scrollHeight`** counts absolutely-positioned descendants, so an
 *   `::after` arrow pinned to whichever edge faces the reference made the host
 *   measure ~5px taller on one side than the other. We read
 *   `getBoundingClientRect()`, which is the border box: an absolutely
 *   positioned decoration cannot vote.
 * - **`offsetHeight`** rounds to whole pixels, so a host naturally 39.531px
 *   tall was indistinguishable from one clamped at 40px. The rect is
 *   fractional. Both cases have controls in the browser harness AND in the
 *   unit suite.
 *
 * ## Cost
 *
 * One extra forced layout per tick (the reference's own rect already forced
 * one). The probe is the ONLY read of the host's box: the cross-axis anchor,
 * the arrow variables and the fit test all consume this single measurement,
 * which is the invariant that kept `--teleport-arrow-x` on the host instead of
 * 127px outside it.
 */

/**
 * The width constraints the host is about to be given. Measuring under them —
 * rather than under whatever width the host happens to have right now — is
 * what makes wrapping text report the height it will really have.
 */
export type HostWidthConstraints = {
  position: 'fixed' | 'absolute'
  /** CSS `min-width` value the tick will write. */
  minWidth: string
  /** CSS `max-width` value the tick will write. */
  maxWidth: string
  /** CSS `width` value the tick will write; `''` means "shrink to fit". */
  width: string
}

/** The host's own box with nothing but its content deciding the size. */
export type NaturalExtent = {
  /** Border-box width under the tick's width constraints, unsqueezed. */
  width: number
  /** Border-box height at that width, with no `max-height` in the way. */
  height: number
}

/**
 * Measure `hostEl` as if it were open, unclamped and free of any side.
 *
 * Returns `null` when the host has no box even then — a host inside a
 * `display: none` ancestor, or one whose own `display: none` comes from a CSS
 * rule this module cannot name a replacement value for. `null` is the honest
 * answer and makes `resolvePlacement` keep the requested side; a `0` would be
 * a lie that reads as "fits anywhere".
 */
export function measureNaturalExtent(
  hostEl: HTMLElement,
  constraints: HostWidthConstraints,
): NaturalExtent | null {
  // The whole attribute, so the restore cannot miss a key, drop a priority or
  // resurrect one the consumer had removed.
  const savedStyle = hostEl.getAttribute('style')
  const savedState = hostEl.dataset.teleportState
  const savedPlacement = hostEl.dataset.teleportPlacement

  const s = hostEl.style
  const force = (prop: string, value: string): void => s.setProperty(prop, value, 'important')

  // Ask the question in the open state, on no side.
  hostEl.dataset.teleportState = 'open'
  delete hostEl.dataset.teleportPlacement

  // `v-show`'s hide is an inline `display: none`; clearing it lets the box
  // exist. A rule-based `display: none` that survives `state="open"` cannot be
  // undone without inventing a display value, and inventing one (`block` on a
  // flex host) would be a worse answer than "unmeasurable".
  if (s.display === 'none') s.display = ''

  force('position', constraints.position)
  force('top', '0')
  force('left', '0')
  force('right', 'auto')
  force('bottom', 'auto')
  force('max-height', 'none')
  force('height', 'auto')
  force('min-width', constraints.minWidth)
  force('max-width', constraints.maxWidth)
  force('width', constraints.width === '' ? 'auto' : constraints.width)
  force('transform', 'none')
  force('transition', 'none')
  force('animation', 'none')

  const rect = hostEl.getBoundingClientRect()

  if (savedStyle === null) hostEl.removeAttribute('style')
  else hostEl.setAttribute('style', savedStyle)
  if (savedState === undefined) delete hostEl.dataset.teleportState
  else hostEl.dataset.teleportState = savedState
  if (savedPlacement === undefined) delete hostEl.dataset.teleportPlacement
  else hostEl.dataset.teleportPlacement = savedPlacement

  if (rect.width <= 0 && rect.height <= 0) return null
  return { width: rect.width, height: rect.height }
}
