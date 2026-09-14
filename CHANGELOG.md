# Changelog

## 1.1.0

**Flipping now maximises how much of the host you can see.** The fit test was
asking about the host's *current box*; the question it means to ask is about the
host's *content*. Those are the same number only when nothing has happened to
the host — and something almost always has.

> "isn't flip supposed to enable FLIP if it's going to be visible at top instead
> of bottom?"

Yes, and now it is. The rule, as an ordered ladder: the whole host is visible on
the preferred side → stay; it is not and the whole host would be visible on the
opposite side → flip; neither side shows all of it → show the most of it and say
so. Every step of that is decided from the content's real size.

### The defect, in the three costumes it was reported in

`TT-17`, `TT-18` and `TT-19` were one bug. The host's box was being read at a
moment when it did not describe the content:

- **absent** — a `v-show` written *after* the directive (the order this README's
  own Usage example teaches) leaves the host `display: none` when the directive
  measures it. `fit` reported `'unmeasured'`, the requested side stood, and
  nothing ever re-measured: wrong on every open, permanently.
- **collapsed** — `[data-teleport-state="closed"] { max-height: 0 }`, the
  animation this README suggests, meant a 127px tooltip was measured as the
  18px of padding it was animating out of. It "fitted" on a side with 60px of
  room and rendered **13 of its 36 words**, with `fit` reading `'fits'` and no
  attribute on the host indicating anything was wrong. Also hit any host whose
  text re-wraps, on its first open, with no animation at all: the host was
  measured at its normal-flow width before the directive's own width was
  applied.
- **our own clamp** — reading the host through the `max-height` this library
  wrote is circular, and the fallback that papered over it answered with the
  `maxHeight` *option*, so the content's real size never entered the decision.
  Measured in Chrome: a host clamped on one tick jumped to the opposite side on
  the next with 256px of room and 240px of content on the side it left — `flip`
  behaving comparatively again, which is the one thing it is defined not to do.

### The fix

A new module, `src/measure-host.ts`, owns the one measurement the placement
decision may depend on. It takes it as a single synchronous probe: force
`data-teleport-state="open"`, remove `data-teleport-placement`, clear an inline
`display: none`, neutralise `max-height` / `height` / `transform` / `transition`
/ `animation`, apply the width constraints this tick is about to write, read
`getBoundingClientRect()`, and restore the whole `style` attribute verbatim.
Nothing paints in between and the element is byte-identical afterwards.

`scrollHeight` and `offsetHeight` remain forbidden — the first counts an
absolutely-positioned `::after` arrow (the two sides took turns forever), the
second rounds to whole pixels (a 39.531px host was indistinguishable from one
clamped at 40px). Both are now pinned by browser controls as well as unit tests:
measured directly, an arrow-bearing host reports the same `contentHeight` on
both sides while its `scrollHeight` differs by 12px.

### Added

- `detail.truncated` and `data-teleport-truncated` — the content is taller than
  the `max-height` being written, so the popover is not short, it is **cut**.
  `fit` cannot carry this: a host clamped by your own `maxHeight` fits on both
  sides and is cut on both, so `'fits'` is the correct answer and a useless one.
  This is the signal the tooltip report had no way to raise.
- `detail.contentWidth` / `detail.contentHeight` — the measurement the decision
  was taken from, so the verdict can be explained without re-measuring.
  `contentHeight > maxHeight` is exactly `truncated`. `null` when the host has
  no box even unclamped, which is also when `fit` is `'unmeasured'`.
- `useTeleportTo` returns `truncated`, `contentWidth` and `contentHeight`
  alongside the existing refs.

### Changed

- `MEASURE_EPSILON` — the sub-pixel tolerance on "is the content taller than the
  clamp?" — corrected from `0.5` to `1/64`. It is a reporting threshold, not a
  livelock guard: nothing downstream of `truncated` feeds a decision. Both
  operands sit on the engine's layout grid (1/64px in Blink and WebKit, 1/60px
  in Gecko), so the tolerance only has to absorb the ≤1/128px error between the
  `max-height` we write and the value the engine quantises it to. Measured in
  Chrome: at `0.5` a host clamped 0.484px below its own content reported nothing
  at all, which is a real cut going unreported by the one flag that exists to
  stop that.
- `flip: false` no longer skips the host measurement. It never really did — the
  host's rect was read on every tick for the cross-axis anchor and the arrow
  variables — and the probe replaces that read rather than adding one. What
  `flip: false` opts out of is the *decision*; the host is still measured, so
  the arrow lands correctly and truncation is still reported.

### Fixed

- `TeleportToEventDetail` was missing `truncated`, `contentWidth` and
  `contentHeight`, so `npm run build` failed at the `.d.ts` step and the package
  could not be built at all. `vitest` does not typecheck, so 806 green tests said
  nothing about it.

### Verifying

836 unit tests (up from 806), of which 30 are new and cover the measurement
directly. `sizeHost`, the jsdom harness, gained the modes it needed to hold a
regression for this at all: `collapsedTo` (a box shorter than
`min(natural, clamp)` — the case the old harness structurally could not express,
because both its modes *guaranteed* the rect was at least as tall as the content
allowed), `naturalAt` (text that re-wraps at the measured width) and an inline
`display: none` that yields no box. Eight mutations of the fix — removing the
probe, restoring the `maxHeight` fallback, not clearing `display`, dropping the
width constraints, skipping the style restore, putting the epsilon back to
`0.5`, and reintroducing each of the two forbidden measurement sources
(`scrollHeight`, `offsetHeight`) — each turn the suite red.

Because jsdom has no layout, the unit suite can only drive a stub of the thing
that was wrong, so the real gate is a browser: `playground/scripts/interactions/
v-teleport-to.mjs`, seven checks over cards 02, 13 and 14, counting words painted
inside the host's content box rather than reading attributes. Against the
pre-fix measurement six of the seven fail, one of them reporting exactly the
symptom in the original report — *13 of 36 words shown, `fit: fits`*. The
seventh is the arrow livelock control, which must pass either way or it is not a
control.

New playground cards: **13 — content measurement** (a tooltip, not a menu:
wrapping text with a content-length slider, an explicit placement and a
box-collapsing closed state) and **14 — v-show before or after the directive**
(the two orderings side by side, which must agree). Card **02** gained the
second axis it was missing: it varied the *room* and never the *content*, so it
structurally could not catch this.

## 1.0.0

First release.

The 2.0.0 and 3.0.0 entries that previously stood here described breaking changes
between local development states that were never published. No consumer ever saw a
0.x, 1.x or 2.x of this package, so presenting three major versions implied a
migration history that does not exist. Collapsed into one initial release.

### What it does

Teleports a host element to `document.body` and positions it against a reference,
escaping any `overflow: hidden` ancestor. Reads only the reference's
`getBoundingClientRect()` — never an ancestor's overflow or clip styles.

- `placement` — `auto` (default, vertical) or an explicit `top`/`bottom`/`left`/`right`
- `flip` — move to the opposite side along the placement axis when the chosen side
  cannot hold the host
- `hideWhenReferenceHidden` — on by default; the host hides when its reference is
  fully outside the clip rect, so a popover is never left floating with nothing to
  anchor to
- `overflow`, `boundary`, `scrollContainer`, `matchWidth`, `maxWidth`,
  `widthMultiplier`, `crossAxisAlign`, `arrow`, `strategy`, `autoUpdate`
- state on the host: `data-teleport-state`, `-placement`, `-fit`, `-hidden`,
  `-collapsed`
- `useTeleportTo` composable for consumers who want the numbers rather than the writes

### Known at time of release

`TT-17`, `TT-18` and `TT-19` — one defect in three forms: the fit test could be
handed a measurement that did not describe the host's content, when the host was
`display: none`, animating from a collapsed box, or already clamped. In those cases a
popover could be truncated while `fit` reported `fits`. **All three are closed in
1.1.0**, and the advice that stood here — animate `opacity` and `transform` rather
than `height` or `max-height` — is no longer necessary: a closed state that collapses
the box is neutralised for the duration of the measurement.
