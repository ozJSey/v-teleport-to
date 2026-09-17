# @ozjsey/v-teleport-to

See in action: [npm portfolio playground](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to).

**Or go straight to the card for the thing you came for** — every one is live, and editable in the
browser:
[basic dropdown](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/basic-dropdown) ·
[placement + flip](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/placement-flip) ·
[sizing](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/sizing) ·
[boundary + scrollContainer](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/boundary-scroll) ·
[arrow](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/arrow) ·
[events + state attributes](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/events-state) ·
[`useTeleportTo`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/composable)

Vue 3 directive for viewport-aware fixed positioning relative to a reference element.  
Escapes all overflow/clip containers — perfect for dropdowns, popovers, and autocomplete lists.

## Install

```bash
npm install @ozjsey/v-teleport-to
```

Vue 3 is a peer dependency — it won't be bundled. **Vue 3.3.0 or newer is required**: the positioning core reads its options through `toValue()`, which Vue 3.3.0 added and 3.2.x does not export.

## Register

### Global (plugin — recommended)

```ts
import { createApp } from 'vue'
import { TeleportToPlugin } from '@ozjsey/v-teleport-to'

const app = createApp(App)
app.use(TeleportToPlugin)
app.mount('#app')
```

The plugin registers the directive globally under the kebab-case name
`teleport-to`, so templates use it as `v-teleport-to="..."`.

### Global (manual)

```ts
import { createApp } from 'vue'
import { vTeleportTo } from '@ozjsey/v-teleport-to'

const app = createApp(App)
app.directive('teleport-to', vTeleportTo)
app.mount('#app')
```

### Per-component

```vue
<script setup lang="ts">
import { vTeleportTo } from '@ozjsey/v-teleport-to'
</script>
```

## Usage

```vue
<template>
  <button ref="trigger" @click="open = !open">Open</button>

  <div v-teleport-to="{ to: trigger, enabled: open }" v-show="open" class="dropdown">
    <div v-for="item in items" :key="item">{{ item }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { vTeleportTo } from '@ozjsey/v-teleport-to'

const trigger = ref<HTMLElement>()
const open = ref(false)
const items = ['Profile', 'Settings', 'Sign out']
</script>
```

`enabled: open` beside `v-show="open"` is not a duplicate switch. `v-show` decides
whether the host is **painted**; `enabled` decides whether the directive is
**measuring**. Leave it out and the directive goes on positioning a
`display: none` host on every scroll frame, and `data-teleport-state` never
leaves `"open"` — which is the one thing the animation recipe under
*[Data attributes](#data-attributes)* keys off. (That recipe replaces `v-show`;
it does not pair with it — see the note there.)

## Options

Most of these are a control on a card rather than a paragraph: the fit ladder on
[placement + flip](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/placement-flip), every width knob and the mobile full-bleed branch on
[sizing](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/sizing), `boundary` / `scrollContainer` / `hideWhenReferenceHidden` on
[boundary + scrollContainer](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/boundary-scroll), and `overflow` on
[overflow](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/overflow). Change them there before you decide which you need.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `to` | `HTMLElement \| VirtualReference \| Ref<…> \| () => …` | **required** | Reference to position relative to. Accepts a plain element, a Vue template ref, a getter, or a **virtual reference** (any object with a `getBoundingClientRect()` method — useful for cursor coords, selection ranges, or any synthetic origin). Resolved every tick — refs/getters that yield `null` initially and are populated later are supported. Virtual refs skip the `isConnected` check and the `autoUpdate` observer attachment; consumers should call `update()` (composable) or trigger a directive update to recalc on cursor/range changes. |
| `placement` | `'auto' \| 'top' \| 'bottom' \| 'left' \| 'right'` | `'auto'` | Placement preference. `'top'`/`'bottom'` are vertical; `'left'`/`'right'` place the host beside the reference (top-aligned, with the host's near edge anchored to the reference's matching edge). `'auto'` is vertical-only — it prefers the larger of `top`/`bottom`, then applies the same fit test an explicit side gets, so the host lands on a side it fits on when one exists. Every value here is a *preference*, honoured while the host fits; pass `flip: false` to pin it regardless. |
| `maxHeight` | `number` | `240` | Maximum height in px |
| `widthMultiplier` | `number` | `1.5` | Width multiplier relative to the reference element. Because it multiplies the *reference's* width, it projects `0` for a **virtual reference** that is a point (`width: 0`) — pass `maxWidth` instead for cursor-anchored menus. |
| `maxWidth` | `number \| string` | — | Explicit upper bound for the host width. Overrides the default `parentWidth × widthMultiplier` AND the mobile fullbleed (`100vw`, `<768px`) branch. Number → `${n}px`; string → passed through (any CSS width, e.g. `'min(80vw, 400px)'`). `matchWidth: true` wins on conflict (explicit pinning beats explicit clamping). The form you pass does **not** change the `overflow: 'shift'` clamp: the clamp uses the host's *measured* width, taken under this tick's width constraints, so `600`, `'600px'` and `'min(90vw, 600px)'` all clamp against the same real number. Number vs CSS string only decides the FALLBACK width used when there is no host box to measure at all — a numeric `maxWidth` projects itself, a CSS string projects `parentWidth × widthMultiplier` because no number can be resolved without rendering. That case is `useTeleportTo` called without its host argument, or a host with no box even with the clamp lifted; every directive binding measures. `maxWidth: 0` is a valid value and collapses the host — the `min-width: <reference width>` floor yields to it (it did not before the first release, and every narrowing knob was a no-op). Setting `maxWidth` also opts the host out of the mobile full-bleed branch entirely, anchor included. |
| `offsetY` | `number` | `0` | Vertical offset in px |
| `offsetX` | `number` | `0` | Horizontal offset in px |
| `zIndex` | `number` | `1201` | CSS z-index value |
| `matchWidth` | `boolean` | `false` | Match reference element width exactly |
| `enabled` | `boolean` | `true` | Enable/disable positioning |
| `boundary` | `HTMLElement \| 'viewport'` | `'viewport'` | Clipping boundary for available-space math. Pass a scrollable container's element to clamp `maxHeight` and the auto-placement decision against its rect instead of the viewport. Detached elements transparently fall back to viewport. |
| `flip` | `boolean` | `true` | Move the host to the opposite side along the placement axis when the preferred side **cannot fit the host**. Vertical: `top` ↔ `bottom`. Horizontal: `left` ↔ `right`. Applies to `placement: 'auto'` too — `'auto'` picks its preferred side comparatively and then runs the same ladder. **Fit-based, not comparative**: the preferred side is held for as long as it works, even when the opposite side has more room. Per tick: preferred side fits → stay (`fit: 'fits'`); it cannot and the opposite can → flip (`fit: 'flipped'`); neither can → the side with more room wins so there is still a defined answer (`fit: 'neither'`). "Fits" compares the raw, boundary-clipped space to that edge against the host's own extent along the axis — its `getBoundingClientRect()` height for `'top'`/`'bottom'`, its width for `'left'`/`'right'`. The edge buffers this library reserves are deliberately not charged to that comparison or to `maxHeight`; see *Edge buffers* below. Costs one layout read per tick when there is a host to read, shared with the cross-axis and arrow math. Because the host is measured, keep its box size independent of the side it is given: an absolutely-positioned arrow that swaps edges on `[data-teleport-placement]` is fine (it changes neither the host's height nor its width), content that reflows to a different height per side is not — it can chase itself between the two. When the host cannot be measured (no laid-out box yet, `display: none`, or `useTeleportTo` without a host argument) the side you asked for stands and `fit` reports `'unmeasured'`; a zero measurement is treated as unknown, never as "fits anywhere". `flip: false` pins the side and skips the fit test. |
| `strategy` | `'fixed' \| 'absolute'` | `'fixed'` | CSS positioning strategy. `'fixed'` (default) uses viewport-relative coordinates so the host escapes overflow/clip ancestors. `'absolute'` uses coordinates relative to the host's nearest positioned ancestor (its `offsetParent`) — useful when the host should track a scrolling parent. Those coordinates resolve against that ancestor's **padding box, in its scrolled content coordinates**: its border widths and its own `scrollTop` / `scrollLeft` are part of the origin, so `position: relative` and `overflow: auto` on the same element works. With `useTeleportTo`, pass the host element as the second argument — `useTeleportTo(options, hostRef)` — or `'absolute'` falls back to viewport-relative coordinates that the browser then resolves against the offsetParent anyway, landing the host far from the reference. |
| `overflow` | `'shift' \| 'hide' \| 'none'` | `'none'` | Overflow handling along the placement axis. For VERTICAL placement (`'auto'`/`'top'`/`'bottom'`), the host overflows the left/right viewport edges; `'shift'` clamps `hostLeft` into `[0, viewportWidth − hostWidth]`. **For HORIZONTAL placement (`'left'`/`'right'`), `'shift'` does effectively nothing, and at the default `offsetX: 0` it is exactly a no-op** — `'shift'` and `'none'` produce byte-identical boxes. That is arithmetic, not an omission: the host's near edge already starts at the reference's far edge (`hostLeft = parentRight + offsetX` for `'right'`), and the clamp's floor is that same edge, because shift is never allowed to push the host onto its own reference. The clamp's entire range of motion is therefore the `offsetX` gap: a positive `offsetX` can be clawed back when the host overflows, and nothing else can. Use `flip` (on by default, and it runs first) or `overflow: 'hide'` for horizontal visibility — `'hide'` reads the host's own box against the viewport and works on every axis. Note `flip` is on by default and runs *first*: it moves the host to the other side while that side fits, so `overflow` only ever sees what flipping could not solve. Set `flip: false` if you want to watch `overflow` do the work. `'hide'` hides the host with `visibility: hidden` (never `display` — that belongs to `v-show` / `v-if` / your CSS) when the **host's own box** crosses a viewport edge; the consumer's own inline `visibility` is restored when it fits again. Note this is *not* "hide when the reference scrolls away" — that is `hideWhenReferenceHidden`, and it is already on by default. `'none'` (default) preserves prior behavior. No-op in vertical mobile full-bleed mode (`<768px`, `matchWidth: false`); horizontal placement is always eligible. |
| `onPositioned` | `(detail: TeleportToEventDetail) => void` | — | Side-effect callback invoked once per successful calculation with the same payload as the `teleport-positioned` event. Useful when subscribing to the DOM event is awkward (composable consumers, deeply nested templates). Skipped when `to` is missing/detached or `enabled: false`. A throwing callback is caught and logged via `console.error` — it cannot break the directive's RAF loop. |
| `onPlacementChange` | `(prev: 'top' \| 'bottom' \| 'left' \| 'right' \| null, next: 'top' \| 'bottom' \| 'left' \| 'right') => void` | — | Side-effect callback invoked **only** when the chosen placement changes between consecutive successful ticks. First successful tick fires with `prev: null`. Useful for triggering one-shot CSS transitions or arrow re-animations on a flip without per-tick noise (`onPositioned` covers per-tick needs). Skipped (and the previous-placement cache reset to `null`) when `to` is missing/detached or `enabled: false`. A throwing callback is caught and logged via `console.error`. |
| `arrow` | `HTMLElement \| Ref<HTMLElement \| null> \| () => HTMLElement \| null` | — | Optional arrow element. When provided and connected, the directive emits `--teleport-arrow-x` / `--teleport-arrow-y` CSS custom properties on the host: vertical placements set `arrow-x` to the reference's horizontal center relative to the host's left edge (and `arrow-y = 0px`); horizontal placements set `arrow-y` to the reference's vertical center relative to the host's top edge (and `arrow-x = 0px`). Tracks `overflow: 'shift'`, `anchorRight`, and `crossAxisAlign` adjustments. The arrow element itself is not styled — consumer CSS pins the arrow to the host edge facing the reference and uses the var to slide it along the perpendicular axis. Detached arrow → vars cleared on next tick. |
| `crossAxisAlign` | `'start' \| 'center' \| 'end'` | — (legacy heuristic) | Explicit cross-axis alignment of the host. For VERTICAL placement (`'auto'`/`'top'`/`'bottom'`) the cross axis is HORIZONTAL: `'start'` left-anchors the host to the reference, `'center'` horizontally centers, `'end'` right-anchors. For HORIZONTAL placement (`'left'`/`'right'`) the cross axis is VERTICAL: `'start'` top-aligns (current default), `'center'` vertically centers, `'end'` bottom-aligns. When OMITTED, the legacy implicit `anchorRight` heuristic stays in play for vertical placement (right-anchor when ref is past `WIDTH_THRESHOLD`); passing any explicit value — including `'start'` — opts out. Horizontal `'center'` / `'end'` use `maxHeight` as the host-height proxy. Mobile full-bleed (`<768px`, `!matchWidth`, vertical placement) wins over `crossAxisAlign`. |
| `autoUpdate` | `boolean` | `false` | Subscribe a `ResizeObserver`, an `IntersectionObserver`, and a `MutationObserver` to the resolved reference element so the host re-positions on layout changes that don't bubble through `scroll` / `resize` — content reflow inside the reference, image lazy-load, sibling insertion shifting it downward, ancestor visibility flips, plus `style` / `class` attribute mutations or child / text changes that shift visible content without changing the bounding box. The IO `root` reflects `boundary` (HTMLElement → that element; otherwise viewport). The MO observes `attributes` (filtered to `style` + `class`), `childList`, and `characterData` on the reference (no subtree). All three observers fan out through the same RAF-batched recalc path used by scroll/resize, so multiple callbacks within a frame collapse into a single recompute. Disconnected on `unmounted` / `onScopeDispose` and re-attached when `to` switches mid-life. Gracefully degrades when any constructor is undefined (the others + the regular scroll/resize listeners still drive recalcs). Off by default for back-compat. |
| `autoUpdateSubtree` | `boolean` | `false` | When `true` AND `autoUpdate: true`, widens the `MutationObserver`'s scope so deep mutations *inside* the reference (any descendant's `style` / `class` change, child insertion/removal, or text mutation) trigger a recalc. Off by default because chatty subtrees (virtualized lists, animated children) can cause trampoline loops. The `attributeFilter`, `childList`, and `characterData` settings are unchanged — only the *scope* widens to descendants. Usually redundant: a descendant change that alters the reference's box is already reported by the `ResizeObserver`. It earns its keep when the RO cannot see the change at all — most commonly a **non-replaced inline reference**, which `ResizeObserver` does not report by specification, so text growing inside a nested `<span>` reaches the directive through this option or not at all (playground demo 08). Toggling mid-life re-attaches the MO so the new setting takes effect immediately. No effect when `autoUpdate` is falsy. |
| `scrollContainer` | `HTMLElement \| HTMLElement[] \| 'window'` | `'window'` | Override the element(s) that receive the `scroll` listener. Default `'window'` attaches with `{ capture: true }` so scrolls on any nested scroll container in the document drive recalcs. Pass an `HTMLElement` to scope the listener to that container — events elsewhere in the document do not trigger recalcs (capture phase still catches scrolls on descendants of the supplied element). Pass an `HTMLElement[]` when the reference sits inside multiple independent scrolling ancestors that don't share a single common scroll container — the listener attaches to each connected entry; detached entries are silently skipped (no fallback to `window` — the consumer enumerated the targets), and an empty array means no scroll listener at all. Switching the value mid-life diffs the attached set against the next resolved set: only removed targets get detached, only added targets get attached, and retained targets are NOT disturbed (no spurious cycle). A detached single `HTMLElement` falls back to `window` so the host stays responsive (array form does not fall back). The `resize` listener is unaffected — it always lives on `window`. **`window` is also unioned into whatever you name here whenever `hideWhenReferenceHidden` is on (the default)**: a reference can leave the viewport through a page scroll that a narrowed container never sees, and a default-on behaviour must not silently fail on a configuration this table documents. `hideWhenReferenceHidden: false` removes the floor, so the opt-out is total and you get exactly the targets you named — including none, for the empty array. |
| `hideWhenReferenceHidden` | `boolean` | **`true`** | Hide the host (`visibility: hidden`) while the reference element is **fully out of view**, and show it again the moment any part of it returns. On by default: a popover whose reference has scrolled away has nothing to anchor to, so leaving it painted over unrelated content is never the answer — pass `false` to opt out. "Out of view" is measured against `intersect(boundary, viewport)` on all four sides (`refBottom <= clip.top \|\| refTop >= clip.bottom \|\| refRight <= clip.left \|\| refLeft >= clip.right`). Binary, not a ratio: one pixel of the reference showing keeps the host up. Four-sided, not axis-aware: a reference that scrolls out sideways under `placement: 'bottom'` counts. Intersected with the viewport, so a reference inside a `boundary` pane that has *itself* scrolled off screen counts too. Touching counts as hidden, which also means a `display: none` reference (all-zero rect) hides instead of teleporting the host to `(0, 0)`. No clipping-ancestor walk is done — see *Behavior* below. **Independent** of `overflow: 'hide'`, which keys off the *host* overflowing the viewport; both may be combined, and either signal hides. Leaving this on also puts a `window` floor under the `scroll` listener — see `scrollContainer`. |

## Events

> Every field below, printed live as you drag the reference around:
> [events, callbacks and state attributes](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/events-state).

The directive dispatches a `teleport-positioned` CustomEvent on the element after each position calculation:

```vue
<div
  v-teleport-to="{ to: trigger }"
  @teleport-positioned="onPositioned"
>…</div>
```

```ts
function onPositioned(e: CustomEvent<TeleportToEventDetail>) {
  console.log(e.detail.placement)      // 'top' | 'bottom' | 'left' | 'right'
  console.log(e.detail.availableSpace) // px available on the chosen side (vertical or horizontal axis)
  console.log(e.detail.oppositeSpace)  // px available on the side that was NOT chosen
  console.log(e.detail.fit)            // 'fits' | 'flipped' | 'neither' | 'unmeasured'
  console.log(e.detail.maxHeight)      // actual maxHeight applied
  console.log(e.detail.collapsed)      // did maxHeight come out at 0?
  console.log(e.detail.truncated)      // is the content taller than that maxHeight?
  console.log(e.detail.contentHeight)  // the host's own height, unclamped (px | null)
  console.log(e.detail.contentWidth)   // the host's own width, unsqueezed (px | null)
  console.log(e.detail.referenceHidden) // is the reference fully out of view?
  console.log(e.detail.hidden)          // did the directive hide the host this tick?
}
```

`referenceHidden` is the raw measurement and is reported whether or not
`hideWhenReferenceHidden` is on; `hidden` is what actually happened to the host,
and is also `true` when `overflow: 'hide'` fired. Read both to tell them apart.

### Unmounting the host instead of hiding it

`v-if` on the host **cannot** be driven from the host's own
`teleport-positioned` event. `v-if` unmounts the element, which unmounts the
directive, which stops the event — so `gone` goes `true` once and never comes
back, and if the reference starts below the fold the host is destroyed on its
first tick. Watch the reference from something that outlives the host:

```vue
<script setup lang="ts">
import { ref, useTemplateRef } from 'vue'
import { useTeleportTo } from '@ozjsey/v-teleport-to'

const trigger = useTemplateRef<HTMLElement>('trigger')
const host = useTemplateRef<HTMLElement>('host')

// The composable lives in the component, not on the host — so it keeps
// measuring while the host is unmounted, and can bring it back.
const { styles, referenceHidden } = useTeleportTo(
  () => ({ to: trigger, hideWhenReferenceHidden: false }),
  host,
)
</script>

<template>
  <button ref="trigger">Open</button>
  <div v-if="!referenceHidden" ref="host" :style="styles">…</div>
</template>
```

If you would rather keep the directive, keep the **host** mounted and put the
`v-if` on its contents — the directive keeps measuring, and the expensive
subtree is what comes and goes:

```vue
<div v-teleport-to="{ to: trigger }" @teleport-positioned="hidden = $event.detail.hidden">
  <ExpensiveList v-if="!hidden" />
</div>
```

`availableSpace` + `oppositeSpace` are both sides of the placement axis: the
raw, boundary-clipped gaps, with no edge buffer subtracted — enough to explain
the decision (and render it) without re-measuring the rects. Either may be
negative once the reference passes that edge of the boundary.

`fit` is the outcome of the fit test, which runs on every configuration
including the default:

| `fit` | Meaning |
|---|---|
| `'fits'` | The preferred side could hold the host **at the size it will render**, so it was kept — reported even when the opposite side has more room. Does *not* mean nothing is cut: a host clamped by your own `maxHeight` fits on both sides and is cut on both. Read `truncated` for that. |
| `'flipped'` | The preferred side could not hold the host and the opposite side could. |
| `'neither'` | **No side of the axis can hold the host.** The side with more room was picked and `maxHeight` is clamped to whatever room it has — possibly `0`, in which case `collapsed` is `true` too. Give the boundary more room, lower `maxHeight`, or hide the host yourself. |
| `'unmeasured'` | No fit test ran: `flip: false`, or the host's extent could not be read (see `flip`). The side you asked for stands. |

`collapsed` is the one state `fit` cannot carry on its own: `maxHeight` came
out at `0`, so the host is painted at nothing but its own padding, fully
opaque. A host with no measurable box reports `'unmeasured'` and is collapsed
at the same time — which is exactly the case that used to render as an
invisible empty box with no signal at all.

`truncated` is the other one. It means **the content is taller than the
`max-height` being written**, so the popover you are looking at is not short,
it is cut. `fit` cannot carry it, because a host clamped by your own
`maxHeight` *fits on both sides and is cut on both* — `'fits'` is the correct
answer and a useless one. Flipping cannot help there either; raising
`maxHeight`, scrolling the host (`overflow: auto` makes the rest reachable
rather than lost) or shortening the content can. Mirrored as
`data-teleport-truncated`.

`contentHeight` / `contentWidth` are the measurement the decision was taken
from: the host's own box with the closed state, our `max-height` clamp and the
side coordinate all lifted. `contentHeight > maxHeight` is exactly `truncated`.
Both are `null` when the host has no box even then, which is also when `fit`
reports `'unmeasured'`.

### How the host is measured, and the one rule it asks of you

> Both consequences below have a card: [content measurement](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/content-measurement) is the
> collapsing closed state, and [v-show before or after the directive](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/vshow-order) is the
> ordering that used to decide the answer.

The fit test asks a question about the **content** — "how much room does this
host need?" — and the host's *current rendered box* is not that. It is the
content after `display: none`, a closed-state animation, this library's own
`max-height` and the side coordinate have all had their say. Measuring through
any of them either lied or livelocked, so the measurement is taken once per
tick as a single synchronous probe: the host is put in `data-teleport-state="open"`
with no `data-teleport-placement`, its inline `display` cleared, `max-height`,
`height` and `transform` neutralised, the tick's own width constraints applied,
transitions disabled — the rect is read, and the entire `style` attribute is
restored verbatim. Nothing paints in between, and the element is byte-identical
afterwards.

Two consequences worth knowing:

- **`v-show` before or after the directive no longer matters.** Vue runs
  directives in source order, so `v-show` written *after* `v-teleport-to` used
  to leave the host `display: none` at measure time — `fit: 'unmeasured'`, the
  cramped side kept, and no later tick to correct it. Both orderings now reach
  the same verdict, and `v-show` keeps working, because the probe restores what
  it cleared.
- **A closed state that collapses the box is safe again.**
  `[data-teleport-state="closed"] { max-height: 0 }` — the animation this README
  suggests — used to be measured *as the tooltip's real size*: 18px of padding
  for a 127px tooltip, which "fitted" on a side with 60px of room and rendered
  thirteen of thirty-six words while `fit` said `'fits'`.

**The rule:** the host's box must not depend on the side it is given. An
absolutely-positioned arrow that swaps edges on `[data-teleport-placement]` is
fine — it changes neither the host's height nor its width. Content that
*reflows to a different height per side* is not, and it is the one remaining
way to make the two sides take turns forever. The placement attribute is
removed for the duration of the measurement precisely so that keying content
off it cannot do this by accident.

### Edge buffers

The library reserves `150px` against the boundary's bottom edge and `50px`
against its top, so a menu does not open flush into the edge. Those are
absolute constants applied to whatever `boundary` you pass, so they do **one**
job and one only: weighting `'auto'`'s preference between the two vertical
sides. They are not subtracted from `availableSpace`, from the fit test, or
from `maxHeight` — charging them to a 200px scroll pane made "neither side
fits" the permanent answer, and cut a menu that had 300px of real room below
it. (The horizontal axis has never had buffers; popovers beside a reference sit
flush.)

## Data attributes

The directive writes a `data-teleport-placement` attribute on the host element
after each calculation, so consumer CSS can react to placement without
subscribing to the `teleport-positioned` event:

```css
.dropdown[data-teleport-placement="top"] .arrow {
  transform: rotate(180deg);
}
.dropdown[data-teleport-placement="bottom"] {
  transform-origin: top;
}
```

Values are `"top"`, `"bottom"`, `"left"`, or `"right"`. The attribute is
cleared when the directive is disabled (`enabled: false`), or when its `to`
reference becomes missing or detached — your selectors will simply stop
matching.

Alongside it, `data-teleport-fit` mirrors `detail.fit`
(`"fits" | "flipped" | "neither" | "unmeasured"`), cleared on the same
conditions. It exists mainly so the `"neither"` dead end is visible: a host
that no side of the axis can hold is clamped to the room available, which can
be a few pixels or none at all, and nothing else distinguishes that from a host
with short content.

```css
/* Neither side can hold it — say so instead of rendering a sliver. */
.dropdown[data-teleport-fit="neither"] {
  outline: 2px solid orangered;
}
```

And `data-teleport-collapsed` (present / absent, mirroring `detail.collapsed`)
for the sharper end of the same problem: `maxHeight` came out at `0`, so what
is on screen is the host's padding and nothing else. It is a separate
attribute because `fit` reads `'unmeasured'` whenever the host had no
measurable box — which is precisely the case where a consumer most needs to be
told that this is not a short popover but an impossible one.

```css
.dropdown[data-teleport-collapsed] {
  display: none; /* or a "no room here" affordance of your own */
}
```

And `data-teleport-truncated` (present / absent, mirroring `detail.truncated`)
for the quieter end of it: the host has room, and is still cut, because its
content is taller than the `max-height` being written. That happens on ordinary
geometry — `maxHeight` defaults to `240` — and every other signal on the host
reads healthy while it does.

```css
/* A cut popover should look cut, not just short. */
.dropdown[data-teleport-truncated] {
  overflow-y: auto; /* the rest becomes reachable rather than lost */
  mask-image: linear-gradient(to bottom, #000 calc(100% - 1.5rem), transparent);
}
```

The directive also writes `data-teleport-state="open" | "closed"` for
free open/close animations without a separate `<Transition>` wrapper:

```css
.dropdown {
  opacity: 0; transform: scale(0.95);
  transition: opacity 120ms, transform 120ms;
}
.dropdown[data-teleport-state="open"] {
  opacity: 1; transform: scale(1);
}
```

`"open"` after a successful position calc, `"closed"` while disabled
(`enabled: false`) or while `to` is missing/detached — **and those two are the
only ways back to `"closed"`.** Two consequences, both of which the recipe above
is silently wrong without:

- **Drive `enabled`.** A host whose `to` stays put and whose `enabled` is never
  passed reaches `"open"` on its first successful calc and stays there for the
  rest of its life, so the transition above never runs in either direction. The
  attribute reports whether the *directive* is positioning the host, not whether
  *you* consider the popover open — pass `enabled: open` and the two agree.
- **Do not pair it with `v-show`.** `v-show` writes `display: none`, which takes
  the host out of the box tree in the same patch as the attribute flips, so
  neither the open nor the close transition gets a frame to run in. This recipe
  *replaces* `v-show`: let `[data-teleport-state="closed"]` carry the closed look
  (opacity, scale, `max-height: 0`), and keep `v-show` for the plain
  no-animation dropdown in *[Usage](#usage)*. Every playground card that shows
  this animation is built that way — `enabled` driven, no `v-show`
  ([events and state](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/events-state),
  [content measurement](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/content-measurement),
  [the composable](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/composable)).

**A closed state that collapses the box is safe** — `max-height: 0`, `height: 0` and
`transform: scaleY(0)` are all neutralised for the duration of the measurement
(see *How the host is measured* above), so the fit test sees the tooltip and
not the 18px of padding it is animating out of. Pair with
`transform-origin: var(--teleport-arrow-x) var(--teleport-arrow-y)` (or with
the implicit `transform-origin` set by the directive) for a popover that
visually expands from its anchor edge.

A third attribute, `data-teleport-hidden`, is present (empty value) exactly
while the directive is hiding the host for `overflow: 'hide'` or
`hideWhenReferenceHidden` — it is both the library's ownership record and a
CSS hook:

```css
.dropdown[data-teleport-hidden] {
  pointer-events: none;
}
```

Hiding is done with `visibility: hidden`, never `display`. `display` belongs to
you: `v-show`, `v-if` and your own cascade all write it, and Vue's `v-show`
gives up re-asserting `display: none` once another directive clears it inside
the same patch. `visibility: hidden` also takes the host out of paint,
hit-testing and the accessibility tree while leaving it in the box tree, so
`[data-teleport-state]` transitions keep running and no reflow is paid per show.
When the host becomes visible again the directive restores whatever inline
`visibility` you had set before it hid — and if it never hid the host, it does
not touch `visibility` at all.

## Arrow positioning

> [Arrow positioning](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/arrow) — including the right-anchored host, where the two vars are the
> only thing that keeps the arrow on the reference.

Pass an arrow element via the `arrow` option to receive `--teleport-arrow-x`
and `--teleport-arrow-y` CSS custom properties on the host. They locate the
reference's center within the host's coordinate space, so consumer CSS can
position an arrow without re-running the layout math:

```vue
<template>
  <div v-teleport-to="{ to: trigger, arrow: arrowEl }" class="dropdown">
    <span ref="arrowEl" class="dropdown-arrow" />
    …
  </div>
</template>

<style>
.dropdown-arrow {
  position: absolute;
  width: 12px; height: 12px;
  background: inherit;
  transform: translate(-50%, -50%) rotate(45deg);
}
.dropdown[data-teleport-placement="bottom"] .dropdown-arrow {
  top: 0; left: var(--teleport-arrow-x);
}
.dropdown[data-teleport-placement="top"] .dropdown-arrow {
  bottom: 0; left: var(--teleport-arrow-x); transform: translate(-50%, 50%) rotate(45deg);
}
.dropdown[data-teleport-placement="right"] .dropdown-arrow {
  left: 0; top: var(--teleport-arrow-y);
}
.dropdown[data-teleport-placement="left"] .dropdown-arrow {
  right: 0; top: var(--teleport-arrow-y); transform: translate(50%, -50%) rotate(45deg);
}
</style>
```

The arrow element itself is never styled by the directive — it's only
referenced so the directive can detect detachment and clear the vars when the
arrow is removed from the DOM mid-lifecycle. Both vars are emitted on every
tick (one always equals `0px`); selecting on `[data-teleport-placement="..."]`
keeps each placement's CSS rules independent.

## Composable: `useTeleportTo`

> [`useTeleportTo` inside `<Teleport to="body">`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/composable) — the transformed-ancestor escape
> hatch, wired up and running.

For cases where binding the directive directly is awkward — e.g. when the
positioned element lives inside a `<Teleport to="body">` slot — use the
`useTeleportTo` composable. It returns a reactive `styles` ref that you bind
via `:style`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useTeleportTo } from '@ozjsey/v-teleport-to'

const trigger = ref<HTMLElement>()
const open = ref(false)

const host = ref<HTMLElement>()

// Second argument: the host element. Pass it — the fit test and
// `strategy: 'absolute'` both need it, and both degrade quietly without it.
const { styles, placement } = useTeleportTo(
  () => ({ to: trigger.value!, enabled: open.value, placement: 'auto' }),
  host,
)
</script>

<template>
  <button ref="trigger" @click="open = !open">Open</button>

  <Teleport to="body">
    <div ref="host" v-show="open" :style="styles" :data-placement="placement" class="dropdown">
      …
    </div>
  </Teleport>
</template>
```

The composable accepts the same options as the directive (`TeleportToOptions`)
either as a plain object, a `Ref`, or a getter, plus an **optional second
argument: the host element** (a template ref, a plain element, or a getter).

Pass it. The directive always knows its host; this composable does not unless
you tell it, and two documented behaviours degrade without it — the fit test
has nothing to measure, so placement falls back to the comparative rule and
`fit` is always `'unmeasured'`; and `strategy: 'absolute'` emits viewport
coordinates that the browser then resolves against the offsetParent anyway,
landing the host far from the reference. Omitting it is still supported; the
degradation is opt-in rather than structural.

### When it recalculates

Three triggers, and they are not interchangeable:

1. **Immediately**, the moment an option (or the host ref) changes — so a
   `maxHeight` bumped in an event handler is readable off `styles` on the very
   next line.
2. **Again after the render** those changes caused. This is what makes
   `enabled: open` paired with `v-if` on the host's contents correct: both flip
   in one reactive tick, and a measurement taken before Vue patches the contents
   in reads an empty host, decides the cramped side fits, and writes a
   `max-height` sliver that every signal then reports as healthy. Fixed in
   1.1.1 — before it, that shape needed `autoUpdate: true` or a manual
   `update()`.
3. **On every re-render of the owning component**, which is exactly the
   directive's `updated` hook. A reference that moves because of state your
   options getter never reads — a spacer growing above it, a sibling's `v-if` —
   changes no dependency of (1) or (2), so nothing else would notice. Registered
   only when the composable is called inside a component; a bare `effectScope`
   has no render step and keeps (1) and (2).

Plus `scroll` and `resize` (RAF-batched, capture phase), and the `autoUpdate`
observers when you turn them on. `styles` is compared before it is re-assigned,
so a recalculation that lands on the same answer costs no re-render.

It cleans up automatically when the component (or surrounding `effectScope`) is
disposed. Returned refs:

- `styles: Ref<TeleportToStyles>` — bind to `:style`. Emptied back to `{}` whenever the composable goes dormant (`enabled: false`, or a `to` that resolves to null/detached), so a hide applied by `hideWhenReferenceHidden` is released with it rather than leaving the host invisible with nothing left to un-hide it
- `placement: Ref<'top' | 'bottom' | 'left' | 'right' | null>` — chosen side
- `availableSpace: Ref<number>` — available px on the chosen side
- `oppositeSpace: Ref<number>` — available px on the side that was not chosen
- `fit: Ref<TeleportToFit>` — outcome of the fit test. `'unmeasured'` unless you passed the host as the second argument
- `maxHeight: Ref<number>` — effective max height after clamping
- `collapsed: Ref<boolean>` — did `maxHeight` come out at `0`? Mirrors the directive's `data-teleport-collapsed`
- `truncated: Ref<boolean>` — is the content taller than that `maxHeight`? Mirrors the directive's `data-teleport-truncated`
- `contentHeight: Ref<number | null>` / `contentWidth: Ref<number | null>` — the host's own unclamped box, the number the fit test compared
- `referenceHidden: Ref<boolean>` — was the reference fully out of view on the last calculation? Reported whether or not `hideWhenReferenceHidden` is on, so you can drive a `v-if` off it
- `hidden: Ref<boolean>` — did `styles` come back carrying `visibility: 'hidden'`? True for either hide signal (`hideWhenReferenceHidden` or `overflow: 'hide'`)
- `state: Ref<'open' | 'closed'>` — bind via `:data-teleport-state="state"` to enable `[data-teleport-state="open"]` CSS open/close animations (mirrors the directive's `data-teleport-state` attribute)
- `update(): void` — force an immediate re-calculation

## Behavior

- **Auto placement**: Prefers the vertical side (above or below the reference) with more available space, then runs the fit test on it and moves the host if it does not fit there and the other side can. Intentionally vertical-only — use explicit `'left'` / `'right'` for horizontal popovers. Before the first release `'auto'` returned the comparative answer *before* the fit test could run, and since it was the default placement and `flip` defaulted to off, a bare `v-teleport-to="{ to: ref }"` never asked whether the popover fitted where it was put: it was clamped into whatever room that side had, down to `max-height: 0px`, with `data-teleport-fit` permanently `"unmeasured"`
- **Flip**: on by default and **fit-based** — it holds the side you asked for while the host fits there and moves only when it stops fitting, so `'bottom'` is never a synonym for "the roomier side". See the `flip` option above for the exact rule, the layout read it costs, and what happens when the host cannot be measured. `flip: false` pins the side
- **Horizontal placement**: `placement: 'left' \| 'right'` positions the host beside the reference, top-aligned, with the host's near edge anchored to the reference's matching edge. Bypasses mobile full-bleed and the right-edge anchor branch (consumer's explicit choice wins). `flip` (on by default) swaps `'left'` ↔ `'right'` on the same fit rule, comparing the host's width against the space beside the reference
- **Reference out of view**: The host hides itself (`visibility: hidden`) while the reference is fully outside `intersect(boundary, viewport)`, and comes back when any part of it does. On by default — see `hideWhenReferenceHidden`
- **No clipping-ancestor walk** (deliberate divergence from Floating UI): visibility is decided from the reference's own rect and the boundary you configured, never by walking up the ancestor chain looking for `overflow` / `clip-path` / `contain`. That walk is an O(depth) `getComputedStyle` sweep on every frame of every scroll, and it would cost this library its one structural promise — that it reads the reference's rect and nothing else, which is exactly why the host escapes every clipping ancestor in the first place. The consequence: a reference clipped by an `overflow: hidden` ancestor that is itself on screen still counts as visible. Pass that ancestor as `boundary` when you need it accounted for
- **Mobile viewport** (`<768px`): the host goes genuinely full-bleed — `width: 100vw`, `left: 0` — instead of the multiplier. Setting `maxWidth`, `matchWidth`, or an explicit horizontal `placement` opts out of the whole branch, anchor included
- **Right anchoring**: When the reference element is past 71% of viewport width, the dropdown anchors to the right edge of the reference instead of the left
- **RAF batching**: Scroll and resize events are debounced via `requestAnimationFrame` to prevent layout thrashing
- **Capture-phase scroll**: Listens for scroll events in the capture phase to detect nested scrollable containers
- **Reduced motion**: When `(prefers-reduced-motion: reduce)` matches, the directive does not write `transform-origin` so consumer CSS animations are not silently re-anchored. Any prior inline value is cleared on the next calculation tick.
- **SSR-safe**: The package imports cleanly in a Node.js context with no `window` / `document`. The directive's lifecycle hooks (`mounted`, `updated`, `unmounted`) only fire client-side per Vue 3's SSR contract, so the directive form is automatically a server-side no-op. The `useTeleportTo` composable also handles the server case: when `to` is `null` / `undefined` / a `Ref<HTMLElement | null>` whose value is `null`, no `window` access is attempted and the returned refs hold their default values (`styles: {}`, `placement: null`, `availableSpace: 0`, `oppositeSpace: 0`, `fit: 'unmeasured'`, `maxHeight: 0`, `collapsed: false`, `truncated: false`, `contentWidth: null`, `contentHeight: null`, `referenceHidden: false`, `hidden: false`). Listener registration and `requestAnimationFrame` are gated by `typeof window !== 'undefined'`.
- **Overflow / clip containers**: The default `strategy: 'fixed'` produces viewport-relative coordinates, so the host escapes ancestor `overflow: hidden`, `overflow: clip`, `clip-path`, and `mask-image` clipping. The math reads only the reference's `getBoundingClientRect()` — never any ancestor's overflow or clip styles. Inside a scrolling `overflow: auto` container, pass the scroller via `scrollContainer` so the host follows the inner scroll. Switch to `strategy: 'absolute'` when you explicitly *want* the host to sit inside an ancestor (the consumer accepts the clip trade-off).
- **Transformed-ancestor gotcha** (CSS limitation): when an ancestor has a `transform`, `filter`, `perspective`, `will-change: transform`, or `contain: paint / layout / strict / content` applied, that ancestor becomes the **containing block** for any `position: fixed` descendant — so the host is positioned relative to the ancestor, *not* the viewport, and is clipped by the ancestor's `overflow`. The directive itself emits the same output (viewport-coord math), but the browser's rendering shifts. **Workaround**: render the host inside a `<Teleport to="body">` slot and bind styles via `useTeleportTo()` — the host now lives outside the transformed ancestor at render time, so `position: fixed` recovers its viewport-relative behavior. See the *Composable: `useTeleportTo`* section above.

## Types

```ts
import type {
  TeleportToOptions,
  TeleportToEventDetail,
  TeleportToFit,
  TeleportToSide,
} from '@ozjsey/v-teleport-to'
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the `src/` module layout and
dependency graph.

## License

MIT
