# Changelog

## 1.1.5 — 2026-09-20

A render loop in `useTeleportTo` that locks the page. Present in every released version of the
composable; found on the live documentation site, not in a unit test.

### Fixed

- **A host whose measured height never settles drove the owning component until Vue bailed out**
  with *"Maximum recursive updates exceeded"*. The page stops responding; the popover is stuck
  wherever the last pass left it.

  `update()` writes thirteen outputs. `styles` was compared before assigning — `sameStyles` — and
  the remaining twelve were assigned unconditionally. Five of those are floats read straight off
  `getBoundingClientRect`: `availableSpace`, `oppositeSpace`, `maxHeight`, `contentWidth`,
  `contentHeight`. A ref assigned a value differing in the ninth decimal place still triggers, so
  a consumer rendering any of them re-rendered, the re-render ran the `onUpdated` path, that
  measured again, and the next measurement differed again.

  The module's own comment set out why the update paths terminate — "this only converges because
  the second pass over an unchanged DOM produces an equal record and `sameStyles` swallows it" —
  and named the consequence if the invariant were ever weakened. It was weaker than the comment
  assumed all along: `sameStyles` only ever guarded one of the thirteen.

  Those five now write only when the value moves by at least 0.05px, which is below anything a
  consumer can act on and far above the noise. A real move clears it on the first measurement;
  jitter never does. `placement`, `fit`, `collapsed`, `truncated`, `referenceHidden`, `hidden` and
  `state` are unchanged — Vue already swallows an identical primitive.

  Caught by playground card 11 in the daily workflow on Linux, five times a run, against the
  **published** package; it does not reproduce on macOS, which is what a measurement sitting on a
  fractional-pixel boundary looks like. `vTeleportTo.convergence.test.ts` pins the mechanism
  rather than that geometry: a host that jitters by 0.001px reproduces the bail-out exactly, and
  the test also fails on read count alone, so it still detects the loop if Vue ever stops
  counting. The new file is registered in `vitest.workspace.ts`, whose `include` is an allowlist —
  a test file that is not named there does not run, and does not say so.

## 1.1.4 — 2026-09-18

Documentation only; no code change. The README is cut to a landing page — problem, solution,
install, a couple of usage examples — because the playground now carries the reference: every
option driven in a real browser rather than described in a table. Claims that could not be
verified against the source were deleted rather than carried across.

## 1.1.3

Two defects in code paths the unit suite could only ever stub, and one gate that could not fail.
`1.1.3` was published on 2026-09-17, superseding 1.1.2.

Both fixes are certified in Chrome, not in jsdom, because jsdom is structurally unable to see
either of them: it has no layout, so `clientTop`, `clientWidth` and `scrollTop` all read `0` on
every element and the wrong formula and the right one agree exactly.

### Fixed

- **`strategy: 'absolute'` ignored the offsetParent's border and its scroll offset, so the host
  landed hundreds of pixels from its reference.** The containing block for an absolutely
  positioned child is the offsetParent's **padding box, in that parent's scrolled content
  coordinates**. 1.1.2 used the border box `getBoundingClientRect()` returns, unscrolled — which is
  correct only for a parent with no border that never scrolls. `position: relative` +
  `overflow: auto` on one element is the documented use case for this strategy ("the host lives
  inside a scrolling parent"), and it is exactly the case that was wrong.

  Measured in Chrome against the published 1.1.2 artifact — a 12px/20px-bordered pane scrolled to
  450, host anchored below its trigger:

  ```
  1.1.2   writtenTop "102px"  writtenLeft "50px"   deltaY -438  deltaX 20
  1.1.3   writtenTop "540px"  writtenLeft "30px"   deltaY    0  deltaX  0
  ```

  `deltaY` is the host's top edge minus the reference's bottom edge: 438px above the trigger it is
  supposed to hang off. The same run with `placement: 'top'` + `crossAxisAlign: 'end'` inside a
  pane with a 17px classic scrollbar, scrolled 420 down and 90 right:

  ```
  1.1.2   bottom "240px"  right "190px"   deltaBottom -457  deltaRight -127
  1.1.3   bottom "-217px" right "63px"    deltaBottom    0  deltaRight    0
  ```

  One case is exempt from the scroll term, and finding it is why this was measured rather than
  reasoned about: when the offsetParent IS `document.scrollingElement`, its rect has already moved
  with the page scroll and subtracting again double-counts. That is every quirks-mode document
  (`compatMode: "BackCompat"`), where `<body>` is both the viewport scroller and the offsetParent
  of a statically positioned host. Measured on a page scrolled 1200px, the guardless origin wrote
  `top: 2840px` and put the host 1192px BELOW its reference; with the guard it writes `1640px`,
  byte-identical to what 1.1.2 wrote there. In a standards-mode document the scrolling element is
  `<html>`, which is never an `offsetParent`, so the guard costs one identity comparison.

  The far edges resolve against `clientWidth` / `clientHeight`, not `rect.right - border`: a
  `right: 0` child of a parent with a 17px classic scrollbar has its right edge at
  `left + clientLeft + clientWidth` — measured at 443 where the border box implies 460 — so the
  scrollbar shrinks the origin. Six unit tests pin the arithmetic through a `makeOffsetParent`
  harness that models all five numbers; playground card 12 now puts `position: relative` and
  `overflow: auto` on the SAME element so the card can express the defect at all (its wrapper was
  the offsetParent before, which never scrolled relative to the reference), and a browser check
  sweeps the pane's scroll range asserting the gap stays within 1px.

- **`useTeleportTo` left `visibility: hidden` in the style record when `to` went missing, while
  reporting `hidden: false`.** `hidden` is documented as "whether `styles` carries
  `visibility: 'hidden'`". The dormant branch for a null/detached `to` flipped the flag and left
  the key in the record the consumer binds with `:style="styles"` — so the popover stayed
  invisible with every signal saying it was fine, and there was no later tick to release it. The
  same branch also left `placement` reporting the side it had chosen for a reference that no
  longer exists, against its own documented `null`.

  Root cause was duplication: the two dormant branches (`enabled: false` and a missing `to`)
  hand-listed their resets separately, and the second listed seven of the thirteen. They now share
  one `goDormant()`.

### Changed

- **The `flush: 'post'` recalc trigger now has a test that can fail.** Deleting
  `watchEffect(recalc, { flush: 'post' })` — trigger #2 of the TT-22 fix, which was a P0 — left all
  854 tests green, because every existing test for it calls the composable inside a component where
  `onUpdated` (trigger #3) covers the same frame. The composable is documented as working in a bare
  `effectScope`, and there trigger #3 is never registered. The new test uses that shape and fails
  with `expected 10 to be 250` when the trigger is removed.
- Playground card 12 and `scripts/interactions/v-teleport-to.mjs` per the above; `README.md`,
  `src/types.ts` and `ARCHITECTURE.md` now state the `'absolute'` origin.

## 1.1.2

A one-line `package.json` fix, and the line was a false statement about which Vue versions this
package runs on (PEER-1). The runtime is untouched, and that is checked rather than asserted:
rebuilt from the 1.1.1 source and from this one, `dist/vTeleportTo.min.js` hashes `2a468c6e…` both
times and `dist/vTeleportTo.min.cjs` hashes `8c23f58e…` both times. The 854-test suite is unchanged
and green.

### Fixed

- **`peerDependencies.vue` said `^3.0.0`, and nothing below Vue 3.3.0 has ever run this package.**
  It now says `^3.3.0`. This corrects a false claim — it withdraws no platform, because the
  platform it named was never reachable. The floor is set by **`toValue`**, imported at
  `src/calculate-position.ts:18`, `src/auto-update.ts:14` and `src/use-teleport-to.ts:39`, with its
  companion type `MaybeRefOrGetter` at `src/types.ts:7`. Both arrived in **Vue 3.3.0** — one minor
  later than the `getCurrentScope` / `onScopeDispose` floor the sibling directives sit on, which is
  why this range is not `^3.2.0`. Measured against the published Vue packages rather than read out
  of a changelog:

  ```
  vue 3.1.5   toValue=undefined  MaybeRefOrGetter=ABSENT
  vue 3.2.0   toValue=undefined  MaybeRefOrGetter=ABSENT
  vue 3.2.47  toValue=undefined  MaybeRefOrGetter=ABSENT   ← the last 3.2
  vue 3.3.0   toValue=function   MaybeRefOrGetter=present
  ```

  What the old range bought a consumer, run against the 1.1.1 tarball npm serves today:

  ```
  $ npm install vue@3.2.47 @ozjsey/v-teleport-to@1.1.1
  added 25 packages in 1s                          ← npm raises nothing
  $ node -e "import('@ozjsey/v-teleport-to')"
  SyntaxError: The requested module 'vue' does not provide an export named 'toValue'
  ```

  With `^3.3.0` the same install is refused up front — `npm error ERESOLVE ... peer vue@"^3.3.0"
  from @ozjsey/v-teleport-to@1.1.2` — instead of failing later at the import. Forced past that
  refusal with `--legacy-peer-deps`, 1.1.2 throws the same `SyntaxError`, which is the negative
  control for the floor: the range is now exactly as wide as the package.

  Certified on the built tarball, not on the source tree: `vue@3.3.0` + `npm pack` output →
  `import` succeeds, exporting `DIRECTIVE_NAME, TeleportToPlugin, default, useTeleportTo,
  vTeleportTo`.

### Changed

- **The Vue test matrix now runs the floor instead of a version above it.** The low rung was
  `vue3_3@^3.3.13` — above the 3.3.0 floor, and with a caret that resolves to 3.5.x on a fresh
  install, which would leave both rungs on the same Vue. It is now `vue_floor`, pinned to exactly
  `vue@3.3.0`. The rung can fail: pointed at 3.2.47 it reddens **403 of its 423 tests** — 386 of the
  403 in `vTeleportTo.test.ts` and 17 of the 20 in `playground.smoke.test.ts`. 392 die on
  `TypeError: toValue is not a function`, 5 on assertions that expected no throw, and 6 on null
  dereferences downstream of a position that never computed. The survivors are the cases that never
  reach a position calculation.
- **`vitest.workspace.ts` no longer claims that matrix proves the peer range.** It cannot: Vitest's
  SSR transform rewrites named imports to property reads, so an export the linked Vue lacks arrives
  as `undefined` rather than throwing at link time. Only installing the packed tarball against a
  floor-version Vue tests importability, and the comment now says so.
- `src/types.ts` records why the floor is 3.3.0, next to the import that sets it.
- README states the floor in the Install section.

## 1.1.1

A patch, and one of its four items is a P0 that has been live since 1.1.0.
Everything here came out of a blind certification of the published package
(`TT-22`) — ~700 measured configurations in a real browser, against both the
source and the published `dist`. **The directive was not the problem**: the
TT-17/18/19 repair held under everything thrown at it, including a deliberate
livelock attempt. The composable was.

### Fixed — `useTeleportTo` measured the DOM of the previous frame (P0)

`src/use-teleport-to.ts` ran its recalculation in a `watchEffect` with
`flush: 'sync'`, on the strength of a comment that said *"there's no separate
render step to wait for here"*. There is one, whenever the host's content is
reactive — and that is the ordinary dropdown: `enabled: open` on the options
and a `v-if` on the contents, which is what this README recommends. Both flip in
one reactive tick, so the measurement was taken before Vue patched the contents
in.

Identical markup, identical options, 1280x660, 115px below the trigger and
513px above:

| | placement | fit | maxHeight | contentHeight | truncated | what you saw |
|---|---|---|---|---|---|---|
| directive | `top` | `flipped` | 240 | 242.5 | `true` | 240px, all 8 rows |
| composable (1.1.0) | `bottom` | `fits` | 115 | **10** | **false** | **a 115px sliver, 3 rows of 8** |

The popover was cut to a sliver and **every signal it handed you said it was
fine**. It did not recover after 1.8s, or across close/reopen; a manual
`update()` fixed it, which is what made it a timing bug rather than a geometry
one. `autoUpdate: true` masked it, because observer callbacks land after the
patch — but `autoUpdate` is off by default and is documented as covering what
scroll and resize miss, not as the price of the composable seeing its own host.

The same cause had a second face: a reference that **moves** through reactive
state the options getter never reads — a spacer growing above it, a sibling's
`v-if` — changed no dependency of that effect, so nothing re-ran and the host
stayed where it was indefinitely. The directive tracks this for free, because a
component re-render *is* its `updated` hook.

Now three triggers, and none of them subsumes the others:

1. **sync** on the options/host dependencies — unchanged, and deliberately so:
   a `maxHeight` bumped in an event handler is still readable off `styles` on
   the next line. Pinned by its own test;
2. **post-flush** on the same dependencies — the measurement, taken against the
   DOM Vue has already patched;
3. **`onUpdated`** — every re-render of the owning component, which is exactly
   the directive's hook. Registered only inside a component; a bare
   `effectScope` has no render step and keeps (1) and (2).

`styles` is now **compared before it is re-assigned**. That is load-bearing, not
an optimisation: `styles` is bound into the consumer's template, so a
post-render re-measure that always assigns a fresh record re-renders, which
re-measures, forever — Vue bails out with *"Maximum recursive updates
exceeded"*. The comparison is what makes the correction converge in one extra
render. As a side effect, a scroll or resize that does not move the host now
costs no re-render at all.

Five unit tests and three browser checks, all negative-controlled. The browser
checks needed **card 11 to be rebuilt first**: it had no interaction check, and
its shape — content always rendered, reference never moves — could not have
expressed the trigger condition even with one. That is why a blind certifier
found this and 836 green jsdom tests did not.

### Fixed — dormant hosts kept `data-teleport-truncated` / `data-teleport-collapsed`

`directive.ts`'s `updated` hook hand-listed the attributes it cleared when the
directive went dormant (`enabled: false`, or a `to` that goes away) and listed
two of four. So this README's own
`.dropdown[data-teleport-collapsed] { display: none }` recipe kept matching a
host the directive had let go of, with nothing left on it to explain why. It now
calls `clearPositionAttributes`, the shared helper the detached-reference path
has always used — whose doc comment already warned about exactly this.

### Docs — four claims corrected, all of them measured

- **The Usage snippet did not run.** `v-for="item in items"` with no `items`
  declared. Pasted verbatim it warned and rendered an empty box, and it is the
  first code a new consumer copies.
- **The two headline recipes cancelled each other out.** Usage drove visibility
  with `v-show` alone, so `data-teleport-state` reached `"open"` on the first
  successful calc and never left it — while the Data-attributes section sold
  that attribute as free open/close animation. Measured `opacity: 1` at
  mount-closed, at open and at close. Usage now passes `enabled`, and the
  animation recipe says plainly that it replaces `v-show` rather than pairing
  with it.
- **`maxWidth` x `overflow: 'shift'`: the implementation was better than its
  docs.** The README claimed a numeric `maxWidth` made the shift clamp use that
  value while a CSS string fell back to `parentWidth x widthMultiplier`.
  Measured with `widthMultiplier: 20` and a 518px host, `600`, `'600px'` and
  `'min(90vw, 600px)'` all clamp identically, because the clamp uses the host's
  **measured** width. The projection is only the fallback for a host with no box
  to measure. The advice to "pass a number when overflow accuracy matters" is
  gone.
- **`overflow: 'shift'` is inert for horizontal placement**, and now says so.
  For `placement: 'right'` the host's left edge already starts at the
  reference's right edge, which is also the clamp's floor — shift may never push
  the host onto its own reference. Its entire range of motion is the `offsetX`
  gap, so at the default `offsetX: 0` it is exactly a no-op: measured
  byte-identical boxes against `'none'` at every rail position and both
  multipliers. Use `flip` (on by default, and it runs first) or `'hide'`.

No code changed for any of these four.

### Playground

- **Card 11 (`useTeleportTo`) rebuilt** around the two shapes the P0 needs:
  `enabled` paired with a `v-if` on the popover's rows, and a slider that moves
  the reference through state no option reads. Three interaction checks drive
  it; all three go red against 1.1.0.
- **Card 05 (`overflow`)** gained an `offsetX` control and a live notice naming
  the `'shift'` + horizontal no-op, because a control that does nothing and
  says nothing is how that defect survived.
- **Card 13 (content measurement)** now clips its space to a drawn `boundary`
  box, 96px above the reference and 264px below. Its headline claim — drag the
  content and the placement moves — was previously only true on a short window:
  at 1280x900 and 1280x1400 the placement never moved across the entire slider.
  A native check now drives the sweep at three window heights and requires the
  same transition point at each.
- **Card 09 (virtual reference)** likewise passes `boundary`, so "right-click
  near the bottom of the box and the menu opens above the cursor" is true of the
  box you can see rather than of where your window edge happens to be. It was
  not reproducible at 900px or 700px of viewport height.
- **Card 02**'s source comment claimed the boundary made horizontal space vary
  and the horizontal flip reachable. Neither slider touches the horizontal axis;
  scrolling the box sideways does, and both flips are reachable that way —
  measured, and now pinned by a check.
- **`playground.html` loaded the IIFE Vue build** and then imported a bare
  `'vue'` specifier from the ESM dist, so the standalone page died on
  `Failed to resolve module specifier "vue"` before rendering anything (`TT-21`).
  It uses an import map now, like its five siblings. `pnpm standalone` goes
  5/6 to 6/6.

### Known, and deliberately not fixed here

`repository`, `homepage` and `bugs` all point at a GitHub repo that 404s, so
npmjs.com shows dead links and there is no working issue URL — and
`README.md`'s link to `ARCHITECTURE.md` resolves nowhere, since `files: ["dist"]`
keeps it out of the tarball. This is portfolio-wide (seven of eleven published
packages) and needs an owner decision on the URL, so it is tracked in `META-1`
rather than guessed at here.

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
