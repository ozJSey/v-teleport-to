# Architecture

`v-teleport-to` is a thin Vue 3 directive over a small, single-purpose
positioning core. The `src/` tree is split so each file owns exactly one
concern, with a strictly downward dependency graph.

## Module map

| File | Owns | Depends on |
|------|------|------------|
| `src/constants.ts` | Layout magic numbers (buffers, breakpoint, defaults) | — |
| `src/types.ts` | Public option / event types + internal `DirectiveState` | — |
| `src/calculate-position.ts` | Pure `computePositionStyles` (returns styles + detail, no DOM mutation) **and** `calculatePosition` (applies the result + dispatches `teleport-positioned`; returns the detail or `null`). Also owns the `isVirtualReference` type guard — shared with `auto-update` so observer attachment skips synthetic refs that have no DOM node to observe, and the hide mechanism (`hideHost` / `releaseHide` + the `preHideVisibility` `WeakMap`). **Invariant: the host's box is read exactly once per tick, and only through `measure-host.ts`** — the same measurement feeds the fit test, the cross-axis anchor and the arrow variables, because two reads let them disagree about how wide the host is (which put `--teleport-arrow-x` on a right-anchored host's corner). It is taken BEFORE any of this tick's coordinates are written, since the side coordinate itself caps a shrink-to-fit host at the room on the side being tested. **Invariant: `truncated` is reported, never acted on** — the content being taller than the `max-height` we write is a fact for the consumer; feeding it back into the placement would close the side → style → measurement → side cycle by hand. **Invariant: every style key the directive can write is written on every tick, `''` where it does not apply** — `width` was only ever set, never cleared, so `matchWidth: true → false` welded it on forever. **Invariant: the directive only clears a hide it itself applied.** Hiding writes `visibility: 'hidden'` — never `display`, which belongs to the consumer (`v-show` bails on `!value === !oldValue`, and Vue's `patchStyle` repair only covers `:style` bindings, so one imperative `display` write defeats it permanently) — and stamps `data-teleport-hidden` as the ownership record. `releaseHide` no-ops without that marker and is idempotent, so every dormant branch can call it blindly. Ownership is keyed off the element's own attribute rather than `DirectiveState` on purpose: reading that state would need an import from `schedule-update`, closing a cycle. Also owns the reference-visibility predicate behind `hideWhenReferenceHidden` (default **on**): four-sided, binary, measured against a `clipRect` = `intersect(boundaryRect, viewportRect)`. **Invariant: `strategy: 'absolute'` resolves against the offsetParent's PADDING box, in that parent's scrolled content coordinates** — `clientTop`/`clientLeft` for the border, `clientWidth`/`clientHeight` for the far edges, minus `scrollTop`/`scrollLeft`. Never the border box `getBoundingClientRect()` returns, which was wrong by `border - scroll` on every axis (measured in Chrome: 438px above the trigger in a pane scrolled 450px) and wrong again at the far edges, where a classic scrollbar shrinks the origin (`right: 0` lands at `left + clientLeft + clientWidth`, behind the scrollbar). The scroll term has one exemption: an offsetParent that IS `document.scrollingElement` has already moved with the page scroll, so subtracting again double-counts it — which is every quirks-mode document, where `<body>` is both. jsdom cannot see any of this — every one of those five numbers reads `0` there — so the unit tests model a real parent through `makeOffsetParent` and the browser check lives on playground card 12. **Invariant: `clipRect` never feeds `boundaryRect`** — the boundary drives the placement and available-space math, and clamping it to the viewport would silently move popovers inside an over-hanging boundary. `referenceHidden` is measured on every tick regardless of the option and reported on the event detail, so a consumer who opts out can still drive a `v-if`. | `constants`, `resolve-placement`, `types` |
| `src/resolve-placement.ts` | `resolvePlacement(placement, spaces, rawSpaces, flip, hostExtent)` — the one decision in this library with real semantics: which side the host goes on, plus the `fit` verdict explaining why. Also owns `OPPOSITE_SIDE`. **No DOM**: it does not read or write an element, and since the TT-17/18/19 fix it does not own the measurement either — `measure-host.ts` does, because taking it correctly turned out to be the hard half of the problem. **Invariant: the fit test runs on every configuration, including the default** — `placement: 'auto'` derives its preferred side comparatively and then goes through the same ladder an explicit side does, and `flip` defaults to `true`. `'auto'` returning before the fit test, with `flip` opt-in, is what made a bare binding never ask whether the host fitted. **Invariant: two space records, one buffered and one raw.** The buffered record weights `'auto'`'s preference between two sides and nothing else; the raw record answers the fit test and is what `max-height` is clamped to. The edge buffers are absolute constants applied to whatever `boundary` is passed, so charging them to the height made "neither fits" permanent in a small pane and cut a host that had room. **Invariant: `flip` is fit-based, not comparative** — the preferred side is held while the host fits on it and moves only when it cannot. When the host cannot be measured the requested side stands (moving it on no evidence is worse than honouring it); when neither side fits, the raw-roomier side wins and `fit` says so. The extent it is handed is `null` — never `0` — for an unmeasurable host, because `0` would read as "fits anywhere". | `types` |
| `src/measure-host.ts` | `measureNaturalExtent(hostEl, constraints)` — the host's NATURAL box, and the only measurement the placement decision is allowed to depend on. One synchronous probe: force `data-teleport-state="open"`, remove `data-teleport-placement`, clear an inline `display: none`, neutralise `max-height` / `height` / `transform` / `transition` / `animation`, apply the width constraints this tick is about to write, read `getBoundingClientRect()`, then restore the whole `style` attribute verbatim. Nothing paints in between. **Invariant: the number must be a property of the CONTENT, not of the side the host is currently on** — reading through our own clamp is circular, and the fallback that papered over it (answer with the `maxHeight` option) meant the content's real size never entered the decision (TT-19). **Invariant: `scrollHeight` and `offsetHeight` stay forbidden** — the first counts an absolutely-positioned `::after` arrow, so the two sides took turns forever; the second rounds to whole pixels, so a 39.531px host was indistinguishable from one clamped at 40px. Both livelocks are pinned by browser controls and unit tests. Returns `null`, never `0`, when the host has no box even unclamped. | `types` (type-only) |
| `src/virtual-reference.ts` | `isVirtualReference` type guard — anything with a `getBoundingClientRect` and no DOM node. Shared with `auto-update` so observer attachment skips synthetic references there is nothing to observe. | `types` |
| `src/placement-change.ts` | Shared `invokePlacementChange(opts, prev, next)` helper — diffs the placement, fires `opts.onPlacementChange` if changed, catches throws | `types` |
| `src/auto-update.ts` | Shared `autoUpdate` machinery — `createObservers` / `disconnectObservers` / `syncObservers` keep a `ResizeObserver` + `IntersectionObserver` + `MutationObserver` triple attached to the resolved `to` element when `opts.autoUpdate` is on; the MO observes `style` / `class` attribute mutations (filtered) + `childList` + `characterData` for layout-affecting changes RO/IO may miss; idempotent re-attach when `to` switches; graceful no-op (per-constructor) when any observer constructor is undefined | `types`, `vue` (`toValue`) |
| `src/scroll-target.ts` | `resolveScrollTargets(opts)` + `diffScrollTargets(prev, next)` + shared listener-options constants — collapses `scrollContainer` (omitted / `'window'` / `HTMLElement` / `HTMLElement[]`) to the `EventTarget[]` that both the directive and the composable should attach the `scroll` listener to. Detached single HTMLElement falls back to `window`; array form skips detached entries and does NOT fall back (consumer enumerated the targets). `diffScrollTargets` computes the add/remove set for mid-life swaps so retained targets are not disturbed. **Invariant: `window` is a floor, not an alternative** — it is unioned into the resolved set whenever `hideWhenReferenceHidden` is on (i.e. by default), because a reference can leave the viewport through a page scroll that a narrowed `scrollContainer` never sees, and a default-on behaviour that silently fails on a documented configuration is worse than no default. The opt-out is total: `hideWhenReferenceHidden: false` attaches exactly what the consumer named, empty array included. | `types` |
| `src/schedule-update.ts` | RAF-batched update scheduler + `WeakMap<HTMLElement, DirectiveState>` host-state registry | `calculate-position`, `placement-change`, `types` |
| `src/warn-missing-to.ts` | Deferred missing-`to` warning. A template ref is `null` during the render pass that reads it, so `mounted` legitimately sees `to: null` on every correct usage — warning there is pure noise. Defers to `nextTick` and re-reads `state.options` through `stateMap`, so it fires only for a `to` that never arrives, and stays silent for a host unmounted before the flush. `nextTick` rather than a frame deliberately: a frame handle would be a second pending callback for `unmounted` to track and cancel. | `schedule-update`, `vue` (`nextTick`) |
| `src/directive.ts` | Vue lifecycle hooks (`mounted` / `updated` / `unmounted`); registers/clears scroll + resize listeners; routes auto-update observer callbacks through `scheduleUpdate`. **Invariant: `mounted` always records state, even with no `to`.** `updated` opens with `if (!stateMap.get(el)) return`, so an element that skips registration can never be revived — and `to` is null on first mount for every template ref. Missing `to` means *dormant* (state recorded, no scroll targets, `data-teleport-state="closed"`), never *skipped*. Every dormant branch also calls `releaseHide` — going dormant runs no calculation, so without it a host hidden on the previous tick would stay hidden forever. | `auto-update`, `calculate-position`, `placement-change`, `schedule-update`, `scroll-target`, `types`, `warn-missing-to`, `vue` |
| `src/use-teleport-to.ts` | `useTeleportTo` composable — reactive `styles`/`placement`/`availableSpace`/`maxHeight` refs for non-directive callers (e.g. inside `<Teleport to="body">` slots). Owns **when** the recalc runs, which is the one place the composable is structurally harder than the directive: three triggers (sync on the options, post-flush on the same, and the owning component's `updated`), and a shallow compare on `styles` so a re-measure that lands on the same answer cannot re-render its own way into a loop. **Invariant: both dormant branches go through one `goDormant()`** — `enabled: false` and a `to` that resolves to null/detached are the same state, and hand-listing the resets twice is how they drifted: the detached branch cleared seven of thirteen outputs and left `styles` alone, so a host hidden by `hideWhenReferenceHidden` stayed `visibility: hidden` in the bound record while `hidden` reported `false`. It is this file's `releaseHide` + `clearPositionAttributes`, and it can go further than the directive (which leaves `el.style.top` where it was) because the record is ours to empty | `auto-update`, `calculate-position`, `placement-change`, `scroll-target`, `types`, `vue` |
| `src/plugin.ts` | `app.use()` wrapper — registers the directive under `DIRECTIVE_NAME = 'teleport-to'` | `directive`, `vue` |
| `src/index.ts` | Public re-export surface (named + default + types) | all of the above |
| `vTeleportTo.ts` (root) | Build entry — re-exports from `./src` | `src/index.ts` |

## Dependency direction

```
constants ─────────┐
resolve-placement ─┤
measure-host ──────┤
virtual-reference ─┤
                   ├──► calculate-position ──┬──► directive ──► plugin ──┐
types ────────────►┤            │            │      ▲                   │
                   │            └──► schedule-update┼─────┘              │
                   │                     └──► warn-missing-to            │
                   │                                                     │
                   └──► use-teleport-to ─────────────────────────────────┤
                                                                         ▼
                                                                     index.ts
                                                                         ▲
                                                                         │
                                                                 vTeleportTo.ts
                                                                   (build entry)
```

No upward edges. `constants.ts` and `types.ts` are leaves with no internal
imports; `resolve-placement.ts` and `measure-host.ts` import only `types.ts`,
and neither imports the other — the decision and the measurement are separated
on purpose, because the bug they were fused into was a decision that depended
on a number the decision itself had produced. `index.ts` is a pure barrel.

## Why this shape

- **Pure math is testable in isolation.** `calculate-position.ts` exposes a
  pure `computePositionStyles` (returns styles + event detail) with no Vue
  dependency. The directive's `calculatePosition` and the `useTeleportTo`
  composable both call into it — guaranteeing both code paths produce
  byte-identical positioning output.
- **State stays out of the directive.** Per-host listeners + RAF id live in a
  module-scope `WeakMap` inside `schedule-update.ts`. The directive hooks are
  thin wrappers that read/write that map. GC of the host element auto-cleans
  the entry.
- **The composable has to be told when the DOM changed; the directive is told
  by Vue.** `updated` fires after the patch, on every re-render, and the
  directive writes `el.style` directly — so it can neither measure too early nor
  feed its own output back into the render. A composable has both problems, and
  1.1.1 was the release that admitted it: a sync-flush effect measured the
  previous frame's DOM, and nothing re-ran when a reference moved through state
  the options getter never read. See the "When the recalc runs" block in
  `use-teleport-to.ts` for the three triggers and why none of them subsumes the
  others.
- **Plugin is a one-line wrapper.** Keeping it separate means consumers who
  prefer manual registration (`app.directive('teleport-to', vTeleportTo)`)
  pay no plugin overhead, and tree-shaking drops it.
- **Build artifact is one minified file per format.** `tsup` follows the
  single root entry, walks the graph, tree-shakes, and emits
  `dist/vTeleportTo.min.js` (ESM) + `dist/vTeleportTo.min.cjs` (CJS) with
  matching `.d.ts` / `.d.cts` and source maps.

## Adding a feature

1. If it's a new constant — add to `constants.ts`.
2. If it's a new option — extend `TeleportToOptions` in `types.ts` and
   consume in `calculate-position.ts`.
3. If it changes which SIDE the host lands on — `resolve-placement.ts`, not
   `calculate-position.ts`. The latter owns "where exactly, given the side".
4. If it's a new lifecycle behavior — touch `directive.ts`.
5. If it changes WHEN or HOW the host is measured — `measure-host.ts`, and
   re-check both livelocks in a real browser before believing the unit suite.
   This is the function both documented infinite loops came out of.
6. Always: add a test to `vTeleportTo.test.ts` that pins the contract before
   shipping. For anything fit-related, note that jsdom has no layout — a host
   only has a measurable extent if the test stubs one (`sizeHost`), so a test
   that forgets to is silently exercising the comparative fallback instead.
   `sizeHost` models a browser rather than a number: `natural` is clamped by
   whatever `max-height` was last written, `collapsedTo` models a box the
   consumer's closed state has collapsed (reported on every read except the
   probe's), `naturalAt` models text that re-wraps at the measured width, and a
   host with an inline `display: none` has no box at all. The bug that shipped
   three P0 tickets was the case where the rect is SMALLER than the content —
   which the harness could not express until `collapsedTo` existed.
7. And for anything measurement-shaped, add a browser check to
   `playground/scripts/interactions/v-teleport-to.mjs`. jsdom cannot see this
   family of defect at all: it has no layout, so the suite drives a stub of the
   exact thing that was wrong.
8. If it touches `use-teleport-to.ts`, the check has to live on a card whose
   shape can express the failure. TT-22's P0 survived a blind certification of
   every other option because card 11 had no interaction check AND could not
   have carried one: its content was always rendered and its reference never
   moved, so the trigger condition was unreachable on it. A card that cannot
   fail is worth exactly as much as a check that cannot fail.

## Public surface

Re-exported from the package root:

- `vTeleportTo` (named + default) — the directive object
- `TeleportToPlugin` — `{ install(app) }` for `app.use()`
- `DIRECTIVE_NAME` — `'teleport-to'` (the kebab-case name used at template
  time as `v-teleport-to`)
- `useTeleportTo(options)` — composable returning reactive position styles
- `TeleportToOptions`, `TeleportToEventDetail`, `TeleportToStyles`,
  `TeleportToFit`, `TeleportToSide`, `UseTeleportToReturn` — types
