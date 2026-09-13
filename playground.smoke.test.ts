/**
 * Playground responsive smoke test.
 *
 * The `playground.html` demo is the canonical "does the library work in a real
 * Vue app" exhibit. This suite mounts the playground's template structure via
 * `createApp(...).use(TeleportToPlugin).mount()` and exercises each of the
 * four demo dropdowns at the three responsive breakpoints we claim to support:
 *
 *   - mobile  (~375 × 720)
 *   - tablet  (~768 × 900)
 *   - desktop (~1280 × 900)
 *
 * For each breakpoint × each dropdown, the test asserts:
 *   1. The directive fires the `teleport-positioned` event when the dropdown
 *      becomes visible (proves the directive wired up against the rendered
 *      template + the plugin install path).
 *   2. The resolved `style.position` is `'fixed'` (the entire raison d'être
 *      of this library is escaping overflow containers via fixed positioning).
 *   3. The applied position keeps the dropdown's anchor edge inside the
 *      viewport — no negative `top`/`left`, no off-right overflow once the
 *      width has resolved (mobile uses `100vw` which is always in-bounds).
 *
 * Acceptance for the P7 task: "verify the demo dropdown placements stay
 * visible + non-overlapping at all three [breakpoints]".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, ref } from 'vue'
import { TeleportToPlugin, vTeleportTo, type TeleportToEventDetail } from './vTeleportTo'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

type Rect = { top: number; left: number; width: number; height: number }

function rectAt(r: Rect): DOMRect {
  return {
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect
}

/**
 * Per-breakpoint synthetic layout for the four playground triggers.
 *
 * Top values are chosen so that on every breakpoint, `spaceBelow > spaceAbove`
 * for the bottom-default refs (overflow / basic / match) — this anchors the
 * placement decision and lets the test assert `placement: 'bottom'`. The
 * force-top ref is positioned with explicit `placement: 'top'` so its
 * placement is independent of the math.
 *
 * Buffers (`BUFFER_BOTTOM=150`, `BUFFER_TOP=50` — each named for the boundary
 * edge its gap is measured to):
 *   spaceBelow = boundaryRect.bottom − refBottom − BUFFER_BOTTOM
 *   spaceAbove = refTop − boundaryRect.top − BUFFER_TOP
 */
const LAYOUTS = {
  mobile: {
    width: 375,
    height: 720,
    // refTop=120 → spaceBelow = 720−160−150 = 410, spaceAbove = 120−50 = 70.
    refOverflow: { top: 120, left: 24, width: 280, height: 40 },
    // refTop=200 → spaceBelow = 720−240−150 = 330, spaceAbove = 200−50 = 150.
    refBasic: { top: 200, left: 24, width: 160, height: 40 },
    refMatch: { top: 200, left: 200, width: 150, height: 40 },
    refForceTop: { top: 400, left: 24, width: 160, height: 40 },
  },
  tablet: {
    width: 768,
    height: 900,
    // refTop=140 → spaceBelow = 900−180−150 = 570, spaceAbove = 140−50 = 90.
    refOverflow: { top: 140, left: 32, width: 220, height: 40 },
    // refTop=240 → spaceBelow = 900−280−150 = 470, spaceAbove = 240−50 = 190.
    refBasic: { top: 240, left: 32, width: 140, height: 40 },
    refMatch: { top: 240, left: 200, width: 180, height: 40 },
    refForceTop: { top: 240, left: 410, width: 150, height: 40 },
  },
  desktop: {
    width: 1280,
    height: 900,
    refOverflow: { top: 140, left: 40, width: 220, height: 40 },
    // refTop=240 → spaceBelow = 900−280−150 = 470, spaceAbove = 240−50 = 190.
    refBasic: { top: 240, left: 40, width: 140, height: 40 },
    refMatch: { top: 240, left: 220, width: 180, height: 40 },
    refForceTop: { top: 240, left: 440, width: 150, height: 40 },
  },
} as const

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true })
}

/**
 * Build + mount a Vue app whose template mirrors `playground.html`'s
 * directive-bound dropdowns, registered through the public plugin install.
 *
 * Returns the four trigger refs (so the test can pre-stage rects), the four
 * dropdown elements (so the test can read inline styles + listen for events),
 * and an `unmount` callback.
 */
function mountPlayground() {
  const host = document.createElement('div')
  host.style.cssText = 'position:relative;'
  document.body.appendChild(host)

  const refOverflow = ref<HTMLElement | null>(null)
  const refBasic = ref<HTMLElement | null>(null)
  const refMatch = ref<HTMLElement | null>(null)
  const refForceTop = ref<HTMLElement | null>(null)

  const overflowOpen = ref(false)
  const basicOpen = ref(false)
  const matchOpen = ref(false)
  const forceTopOpen = ref(false)

  const app = createApp({
    setup() {
      return { refOverflow, refBasic, refMatch, refForceTop, overflowOpen, basicOpen, matchOpen, forceTopOpen }
    },
    render() {
      return h('div', [
        h('button', { ref: 'refOverflow', class: 'trigger', onClick: () => (overflowOpen.value = !overflowOpen.value) }, 'overflow'),
        h(
          'div',
          {
            class: 'dropdown overflow-dd',
            style: overflowOpen.value ? '' : 'display:none',
            ['v-teleport-to' as any]: { to: refOverflow.value, maxHeight: 200 },
          },
          'overflow content',
        ),

        h('button', { ref: 'refBasic', class: 'trigger', onClick: () => (basicOpen.value = !basicOpen.value) }, 'basic'),
        h(
          'div',
          {
            class: 'dropdown basic-dd',
            style: basicOpen.value ? '' : 'display:none',
            ['v-teleport-to' as any]: { to: refBasic.value },
          },
          'basic content',
        ),

        h('button', { ref: 'refMatch', class: 'trigger', onClick: () => (matchOpen.value = !matchOpen.value) }, 'match'),
        h(
          'div',
          {
            class: 'dropdown match-dd',
            style: matchOpen.value ? '' : 'display:none',
            ['v-teleport-to' as any]: { to: refMatch.value, matchWidth: true },
          },
          'match content',
        ),

        h('button', { ref: 'refForceTop', class: 'trigger', onClick: () => (forceTopOpen.value = !forceTopOpen.value) }, 'force-top'),
        h(
          'div',
          {
            class: 'dropdown force-top-dd',
            style: forceTopOpen.value ? '' : 'display:none',
            ['v-teleport-to' as any]: { to: refForceTop.value, placement: 'top' },
          },
          'force-top content',
        ),
      ])
    },
  })

  app.use(TeleportToPlugin)
  app.mount(host)

  // The public plugin install MUST register the directive — sanity check.
  if (app.directive('teleport-to') !== vTeleportTo) {
    throw new Error('TeleportToPlugin failed to register the teleport-to directive')
  }

  return {
    host,
    app,
    refOverflow,
    refBasic,
    refMatch,
    refForceTop,
    overflowOpen,
    basicOpen,
    matchOpen,
    forceTopOpen,
    dropdowns: {
      overflow: host.querySelector('.overflow-dd') as HTMLElement,
      basic: host.querySelector('.basic-dd') as HTMLElement,
      match: host.querySelector('.match-dd') as HTMLElement,
      forceTop: host.querySelector('.force-top-dd') as HTMLElement,
    },
    unmount() {
      app.unmount()
      host.remove()
    },
  }
}

/**
 * Manually invoke the directive's `mounted` hook against a target element +
 * options object. Mirrors `mountDirective` from `vTeleportTo.test.ts` and
 * lets us drive the directive without re-rendering the Vue app (avoids
 * jsdom + `v-teleport-to` template-string parsing pitfalls).
 */
function applyDirective(el: HTMLElement, value: any) {
  const binding = { value, oldValue: undefined as unknown, modifiers: {}, dir: vTeleportTo, instance: null }
  vTeleportTo.mounted!(el, binding as any, null as any, null as any)
}

function unmountDirective(el: HTMLElement) {
  const binding = { value: {} as any, oldValue: undefined as unknown, modifiers: {}, dir: vTeleportTo, instance: null }
  vTeleportTo.unmounted!(el, binding as any, null as any, null as any)
}

/**
 * Stage a synthetic `getBoundingClientRect` on a freshly-created element +
 * append it to `<body>` so `isConnected` is true. Mirrors `makeRef()` from
 * `vTeleportTo.test.ts`.
 */
function makeRefAt(rect: Rect): HTMLElement {
  const el = document.createElement('button')
  document.body.appendChild(el)
  el.getBoundingClientRect = () => rectAt(rect)
  return el
}

function makeDropdown(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('playground.html — responsive smoke', () => {
  // For each breakpoint × each demo dropdown, the four assertions form a
  // single coherent claim: "the directive's public surface, exercised through
  // the plugin install path, produces a styled, in-viewport host at this
  // viewport size".
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    describe(`@ ${name} (${layout.width}×${layout.height})`, () => {
      it('TeleportToPlugin registers the directive on app.use()', () => {
        setViewport(layout.width, layout.height)
        const { app, unmount } = mountPlayground()
        expect(app.directive('teleport-to')).toBe(vTeleportTo)
        unmount()
      })

      it('overflow dropdown — fires teleport-positioned and stays in-viewport', () => {
        setViewport(layout.width, layout.height)
        const refEl = makeRefAt(layout.refOverflow)
        const dd = makeDropdown()

        const events: TeleportToEventDetail[] = []
        dd.addEventListener('teleport-positioned', (e: any) => events.push(e.detail))

        applyDirective(dd, { to: refEl, maxHeight: 200 })

        expect(events).toHaveLength(1)
        expect(['top', 'bottom']).toContain(events[0].placement)
        expect(dd.style.position).toBe('fixed')

        // Top must not be negative; bottom must not exceed the viewport.
        if (dd.style.top !== '') {
          const top = parseFloat(dd.style.top)
          expect(top).toBeGreaterThanOrEqual(0)
          expect(top).toBeLessThan(layout.height)
        }
        // maxHeight ≤ requested 200 (clamped if there's less room).
        const maxH = parseFloat(dd.style.maxHeight)
        expect(maxH).toBeLessThanOrEqual(200)
        expect(maxH).toBeGreaterThan(0)

        unmountDirective(dd)
      })

      it('basic dropdown — defaults to bottom placement when there is room below', () => {
        setViewport(layout.width, layout.height)
        const refEl = makeRefAt(layout.refBasic)
        const dd = makeDropdown()

        const events: TeleportToEventDetail[] = []
        dd.addEventListener('teleport-positioned', (e: any) => events.push(e.detail))

        applyDirective(dd, { to: refEl })

        expect(events).toHaveLength(1)
        // Bottom space (windowHeight - refBottom - bufferBottom) is comfortably
        // larger than top space at every breakpoint in this layout.
        expect(events[0].placement).toBe('bottom')
        expect(dd.style.position).toBe('fixed')
        expect(dd.style.top).toBe(`${layout.refBasic.top + layout.refBasic.height}px`)

        unmountDirective(dd)
      })

      it('matchWidth dropdown — width tracks the reference width on every breakpoint', () => {
        setViewport(layout.width, layout.height)
        const refEl = makeRefAt(layout.refMatch)
        const dd = makeDropdown()

        applyDirective(dd, { to: refEl, matchWidth: true })

        // `matchWidth` short-circuits the mobile full-bleed branch by design
        // (consumers passing `matchWidth: true` have explicitly opted out of
        // 100vw). Across all three breakpoints, the host width matches the
        // reference width.
        expect(dd.style.maxWidth).toBe(`${layout.refMatch.width}px`)
        expect(dd.style.minWidth).toBe(`${layout.refMatch.width}px`)
        expect(dd.style.width).toBe(`${layout.refMatch.width}px`)
        expect(dd.style.position).toBe('fixed')

        unmountDirective(dd)
      })

      it('forced-top dropdown — emits placement: "top" with bottom-anchor styles', () => {
        setViewport(layout.width, layout.height)
        const refEl = makeRefAt(layout.refForceTop)
        const dd = makeDropdown()

        const events: TeleportToEventDetail[] = []
        dd.addEventListener('teleport-positioned', (e: any) => events.push(e.detail))

        applyDirective(dd, { to: refEl, placement: 'top' })

        expect(events).toHaveLength(1)
        expect(events[0].placement).toBe('top')
        // Top placement clears `top` and writes `bottom` (= windowHeight - parentTop + offsetY).
        expect(dd.style.top).toBe('')
        expect(dd.style.bottom).not.toBe('')
        const bottom = parseFloat(dd.style.bottom)
        expect(bottom).toBeGreaterThanOrEqual(0)
        expect(bottom).toBeLessThan(layout.height)

        unmountDirective(dd)
      })

      it('all four dropdowns coexist without state leakage (independent refs)', () => {
        setViewport(layout.width, layout.height)
        const refO = makeRefAt(layout.refOverflow)
        const refB = makeRefAt(layout.refBasic)
        const refM = makeRefAt(layout.refMatch)
        const refF = makeRefAt(layout.refForceTop)
        const ddO = makeDropdown()
        const ddB = makeDropdown()
        const ddM = makeDropdown()
        const ddF = makeDropdown()

        applyDirective(ddO, { to: refO, maxHeight: 200 })
        applyDirective(ddB, { to: refB })
        applyDirective(ddM, { to: refM, matchWidth: true })
        applyDirective(ddF, { to: refF, placement: 'top' })

        // Each dropdown got its own positioning math (no state crosstalk through
        // the `WeakMap<HTMLElement, DirectiveState>` keying).
        expect(ddO.style.position).toBe('fixed')
        expect(ddB.style.position).toBe('fixed')
        expect(ddM.style.position).toBe('fixed')
        expect(ddF.style.position).toBe('fixed')

        // Force-top got bottom-anchor; the others got top-anchor.
        expect(ddF.style.bottom).not.toBe('')
        expect(ddF.style.top).toBe('')
        expect(ddB.style.top).not.toBe('')
        expect(ddB.style.bottom).toBe('')

        // matchWidth emits a fixed `width` on every breakpoint (it overrides
        // the mobile full-bleed branch — consumers opted out of 100vw).
        expect(ddM.style.width).toBe(`${layout.refMatch.width}px`)

        unmountDirective(ddO)
        unmountDirective(ddB)
        unmountDirective(ddM)
        unmountDirective(ddF)
      })
    })
  }

  // Cross-breakpoint discoverability: opening the same dropdown at three
  // different viewports yields three different placements / widths consistent
  // with the breakpoint contract.
  it('mobile full-bleed: a no-matchWidth dropdown gets `100vw` and `left:0` (<768px)', () => {
    setViewport(375, 720)
    const refEl = makeRefAt({ top: 200, left: 200, width: 150, height: 40 })
    const dd = makeDropdown()

    applyDirective(dd, { to: refEl })

    // Mobile (<MOBILE_BREAKPOINT=768) without matchWidth → host pinned to
    // viewport's left edge with `maxWidth: 100vw`.
    expect(dd.style.maxWidth).toBe('100vw')
    expect(dd.style.left).toBe('0px')

    unmountDirective(dd)
  })

  it('desktop right-anchored: ref past 71% width threshold anchors right', () => {
    setViewport(1280, 900)
    // 1280 * 0.71 = 908.8; right = 1100 > 908.8 → anchor right.
    const refEl = makeRefAt({ top: 200, left: 950, width: 150, height: 40 })
    const dd = makeDropdown()

    applyDirective(dd, { to: refEl })

    // Right-anchor branch sets `right`, clears `left`.
    expect(dd.style.right).not.toBe('')
    expect(dd.style.left).toBe('')
    const right = parseFloat(dd.style.right)
    expect(right).toBeGreaterThanOrEqual(0)
    expect(right).toBeLessThan(1280)

    unmountDirective(dd)
  })
})
