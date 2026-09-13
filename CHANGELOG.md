# Changelog

All notable changes to `v-teleport-to`. Dates are the day the change landed in
this repository; the package has never been published, so no version below has
a registry counterpart yet.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] — 2026-09-07

The default configuration now asks whether the host fits where it was put. It
never did before, which made almost every other guarantee in this README
conditional on options nobody was told to pass.

### Fixed

- **The bare binding never tested fit.** `placement: 'auto'` — the default —
  returned the comparatively roomier side *before* the fit test could run, and
  `flip` defaulted to `false`, so `v-teleport-to="{ to: ref }"` never asked
  whether the popover fitted. It was clamped into whatever room that side had,
  down to `max-height: 0px`, and `data-teleport-fit` was permanently
  `"unmeasured"` — so the one diagnostic that names the dead end could not fire
  on the configuration that needed it. Measured in Chrome on a bare dropdown
  with 180px above and 250px below: a 192px menu was placed above and cut to
  130px, `visibility: visible`, no signal. It now flips below and renders whole.
- **The edge buffers were charged to the host's height.** `BUFFER_BOTTOM`
  (150px) and `BUFFER_TOP` (50px) are absolute constants applied to whatever
  `boundary` is passed; they were subtracted from `availableSpace`, from the fit
  test and from `max-height`. A 200px scroll pane lost 150 of its 200px, making
  "neither side fits" the permanent answer, and a menu with 300px of real room
  below was cut at 150px. They now weight `'auto'`'s preference between the two
  vertical sides and nothing else.
- **`matchWidth: true → false` welded `width` on forever.** `width` was only
  ever set, never cleared — the omission every other side (`top` / `bottom` /
  `left` / `right`) is explicitly guarded against with `''`.
- **`maxWidth` and `widthMultiplier` could not narrow the host.**
  `min-width: <reference width>` was written unconditionally and beat
  `max-width`, so on a 220px reference `widthMultiplier: 0.5` rendered 220px and
  the README's own "`maxWidth: 0` collapses the host" rendered 220px. The floor
  now yields to the ceiling.
- **Mobile full-bleed detached every dropdown from its trigger.** Below 768px
  the directive wrote `left: 0` and `max-width: 100vw` but never `width`, so a
  host narrower than the viewport was pinned to the screen's left edge with its
  trigger elsewhere. Full-bleed now writes a real `width: 100vw`, and
  `maxWidth` opts out of the whole branch — anchor included — instead of only
  its width half.
- **`--teleport-arrow-x` was wrong on any right-anchored host.** The host's left
  edge was derived from its *projected* width (`parentWidth × widthMultiplier`)
  while the host is positioned with CSS `right:`, so the arrow was off by
  `projected − rendered` — 127px outside the popover at `widthMultiplier: 3`.
  The `anchorRight` heuristic fires automatically past 71% of the viewport
  width, so no option was needed to reach it. The rendered width is now used
  wherever the host's left edge is derived from its width, which corrects
  `crossAxisAlign: 'center'` positioning for the same reason.
- **The README's `v-if` recipe was a one-way trapdoor.** `v-if` unmounts the
  host, which unmounts the directive, so no further `teleport-positioned` fires
  and the flag could never go back to `false`; a trigger starting below the fold
  destroyed the host on its first tick. Replaced with two recipes that work when
  pasted.

### Changed

- **BREAKING: `flip` defaults to `true`.** An explicit `placement` is a
  preference honoured while it works, not a sticky instruction that lets the
  host be cut. `flip: false` is the opt-out and skips the fit test entirely.
- **BREAKING: `placement: 'auto'` is fit-aware.** It prefers the roomier
  vertical side, then applies the same ladder an explicit side gets. Still
  vertical-only.
- **BREAKING: an unmeasurable host keeps the side you asked for.** It used to
  fall back to the comparative rule, which was defensible while `flip` was
  opt-in and is not now that it is the default — `placement: 'bottom'` on a
  host with no laid-out box would otherwise silently become `'top'` on the
  strength of no evidence.
- **BREAKING: `detail.availableSpace` / `oppositeSpace` are raw.** The edge
  buffers are no longer subtracted, so the numbers reconcile with `maxHeight`.
- **`useTeleportTo(options, host?)` takes the host element.** Pass it and the
  fit test and `strategy: 'absolute'` both work there; omit it and they degrade
  exactly as they did before, but now by choice rather than by construction.

### Added

- **`detail.collapsed` and `data-teleport-collapsed`.** `maxHeight` came out at
  `0`: the host is painted at nothing but its own padding, fully opaque. `fit`
  cannot carry this on its own, because a host with no measurable box reports
  `'unmeasured'` and is collapsed at the same time — which is exactly the state
  that used to render as an invisible empty box with no signal. Also on the
  composable as `collapsed: Ref<boolean>`.

### Verification

806 unit tests across 5 projects (Vue 3.3, Vue 3.5, SSR). Mutation-tested: 14 of
14 mutants killed, each one reverting a specific fix or guard above — `'auto'`
returning before the fit test, the `flip` default, the fit test and the
`max-height` clamp reading the buffered spaces, `collapsed` never reporting or
never being mirrored, `width` set-but-never-cleared, the projected width back in
the cross-axis maths, the full-bleed branch ignoring `maxWidth`, the
unconditional `min-width`, the composable dropping the host, an unmeasurable
host degrading to comparative, and both historical livelock sources
(`measureHostExtent` no longer seeing through our own clamp, the raw comparison
in the `'neither'` fallback).

Driven in headless Chrome against the real playground cards, and re-run against
the built `dist/` entry with identical results:

| Claim | Card | Measured |
|---|---|---|
| bare binding flips instead of being cut | 01 | 194px menu, `bottom` with 400px below → `top` at 220px below, full height both times |
| virtual reference flips | 09 | `fit: fits` at 224px below the cursor → `fit: flipped` at 84px |
| composable flips once given the host | 11 | host passed → `flipped`, 150px tall; host omitted → `unmeasured`, clamped to 60px with 627px free above |
| `matchWidth` `true → false` clears `width` | 03 | 258.6 → 220 → **258.6**, `style.width` empty, stable across forced recalcs |
| narrowing knobs work | 03 | `widthMultiplier: 0.5` on a 220px reference → **110px**; `maxWidth: 120` → 120px; `maxWidth: 0` → the host's padding |
| full-bleed writes a width | 01 @ 400px | `width: 100vw`, host spans 0…400 of a 400px viewport |
| arrow tracks a right-anchored host | 06 | 234px rendered vs 576px projected, right-anchored at 76% of the viewport, arrow off centre **0.0px** at every slider position |
| the zero clamp surfaces | 02 | `max-height: 0px` with `data-teleport-collapsed` present and `fit: 'unmeasured'` |

`fit: 'neither'` and the `flipped → fits` ladder were walked on card 02 across
the reference's full travel: `fits` at both extremes, `neither` in the middle
where each side has 163px and the popover wants 177px.
