# @ozjsey/v-teleport-to

Viewport-aware fixed positioning relative to a reference element — dropdowns, popovers and
autocomplete lists that escape the overflow and clip containers they are rendered inside.

[![npm](https://img.shields.io/npm/v/@ozjsey/v-teleport-to.svg)](https://www.npmjs.com/package/@ozjsey/v-teleport-to)
![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![gzipped 4.46 KiB](https://img.shields.io/badge/gzipped-4.46%20KiB-blue.svg)
![dependencies 0](https://img.shields.io/badge/dependencies-0-blue.svg)

**[See it running, and edit it in the browser →](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to)**

## The problem

A dropdown rendered where it belongs in the markup is clipped by whatever it is inside:
`overflow: hidden`, `overflow: clip`, `clip-path` and `mask-image` on any ancestor all cut it off at
that ancestor's edge.

Move it into `<Teleport to="body">` and the clipping stops, but the anchoring goes with it. You now
own the scroll listener, the resize listener, the "is there room below or should it open upward"
test, and a re-measure on every frame of both — for every popover on the page.

## The solution

One binding on the host, naming the element it should follow. The math reads rects — the
reference's, and the host's own when it has to answer a fit question — but never any ancestor's
overflow or clip styles, and it writes viewport coordinates under `position: fixed`, which is
exactly why the host escapes those ancestors.

```vue
<button ref="trigger">Open</button>

<div v-teleport-to="{ to: trigger }" class="dropdown">…</div>
```

`flip` is on by default and **fit-based**: it holds the side you asked for while the host fits
there, and moves only when it stops fitting, so `'bottom'` is never a synonym for "the roomier
side". `hideWhenReferenceHidden` is on by default too — a popover whose reference has scrolled away
has nothing to anchor to, so it hides rather than floating over unrelated content.

**The one limitation to know before you start**, and it is CSS's rather than this library's: an
ancestor with a `transform`, `filter`, `perspective`, `will-change: transform` or `contain` becomes
the **containing block** for any `position: fixed` descendant, so the browser resolves the host
against that ancestor and clips it again. Render the host inside a `<Teleport to="body">` slot and
bind styles from `useTeleportTo()` instead —
[that escape hatch, running](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/composable).

## Install

```bash
npm install @ozjsey/v-teleport-to
```

Vue 3 is a peer dependency — it won't be bundled. **Vue 3.3.0 or newer is required**: the
positioning core reads its options through `toValue()`, which Vue 3.3.0 added and 3.2.x does not
export.

```ts
import { createApp } from 'vue'
import { TeleportToPlugin } from '@ozjsey/v-teleport-to'
import App from './App.vue'

createApp(App).use(TeleportToPlugin).mount('#app')
```

The plugin registers the directive under the kebab-case name `teleport-to`, so templates use it as
`v-teleport-to="..."`. Or import `vTeleportTo` into a single component — Vue auto-registers the
variable because the name starts with `v`.

## Usage

### A dropdown that escapes its container

```vue
<script setup lang="ts">
import { ref } from 'vue'

const trigger = ref<HTMLElement>()
const open = ref(false)
const items = ['Profile', 'Settings', 'Sign out']
</script>

<template>
  <button ref="trigger" @click="open = !open">Open</button>

  <div v-teleport-to="{ to: trigger, enabled: open }" v-show="open" class="dropdown">
    <div v-for="item in items" :key="item">{{ item }}</div>
  </div>
</template>
```

`enabled: open` beside `v-show="open"` is not a duplicate switch. `v-show` decides whether the host
is **painted**; `enabled` decides whether the directive is **measuring**. Leave it out and the
directive goes on positioning a `display: none` host on every scroll frame.

### Open and close animations, with no `<Transition>` wrapper

```css
.dropdown {
  opacity: 0; transform: scale(0.95);
  transition: opacity 120ms, transform 120ms;
}
.dropdown[data-teleport-state="open"] {
  opacity: 1; transform: scale(1);
}
```

`data-teleport-state` is `"open"` after a successful position calc and `"closed"` while the
directive is disabled or its `to` is missing or detached — **and those two are the only ways back**.
So drive `enabled`, and let this recipe *replace* `v-show` rather than pair with it: `v-show` writes
`display: none` in the same patch as the attribute flips, so neither transition gets a frame to run
in. A closed state that collapses the box (`max-height: 0`) is safe — it is neutralised for the
duration of the measurement the fit test takes.

### Saying so when there is no room

```css
/* A cut popover should look cut, not just short. */
.dropdown[data-teleport-truncated] {
  overflow-y: auto; /* the rest becomes reachable rather than lost */
  mask-image: linear-gradient(to bottom, #000 calc(100% - 1.5rem), transparent);
}

/* Neither side of the axis can hold it — say so instead of rendering a sliver. */
.dropdown[data-teleport-fit="neither"] {
  outline: 2px solid orangered;
}
```

`truncated` means the content is taller than the `max-height` being written, so the popover you are
looking at is not short, it is cut. It happens on ordinary geometry — `maxHeight` defaults to 240 —
while every other signal on the host reads healthy. The same values arrive on the
`teleport-positioned` event, next to the chosen placement, the room on both sides of the axis, and
whether the reference is hidden.

## Everything else

Every option, every event, every state attribute — driven in a real browser and editable as you
read, in the [`v-teleport-to` playground tab](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to).
Fourteen cards, including the ones that answer what this page deliberately does not:

- [placement and the flip ladder](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/placement-flip) · [sizing](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/sizing) · [`boundary` and `scrollContainer`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/boundary-scroll) · [`overflow`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/overflow)
- [events, callbacks and state attributes](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/events-state) — every field printed live as you drag the reference around
- [content measurement](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/content-measurement) and [`v-show` before or after the directive](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/vshow-order) — how the host is measured, and the one rule it asks of you
- [arrow positioning](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/arrow) · [cross-axis alignment and offsets](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/cross-axis-offsets) · [`autoUpdate`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/auto-update) · [virtual references](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/virtual-reference) · [`strategy: 'absolute'`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/strategy-absolute) · [`useTeleportTo`](https://ozjsey.github.io/npm-portfolio-playground/#v-teleport-to/composable)

[CHANGELOG.md](./CHANGELOG.md) ·
[ARCHITECTURE.md](https://github.com/ozjsey/v-teleport-to/blob/main/ARCHITECTURE.md)

## License

MIT
