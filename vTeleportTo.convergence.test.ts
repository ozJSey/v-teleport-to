import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useTeleportTo } from './vTeleportTo'

/**
 * The render loop the composable's own comment warns about.
 *
 * `use-teleport-to.ts` documents why its three update paths terminate: (2) and
 * (3) both write `styles`, the consumer binds it, that renders, and rendering
 * runs (3) again — "so this only converges because the second pass over an
 * unchanged DOM produces an equal record and `sameStyles` swallows it. … If
 * that invariant is ever weakened, this stops being a one-frame correction and
 * becomes a render loop — Vue bails out with 'Maximum recursive updates
 * exceeded', and a browser check on playground card 11 exists to catch it."
 *
 * The browser check did catch it. Card 11 threw exactly that, five times a
 * run, in the daily workflow on Linux — against the PUBLISHED package, so it
 * is not a playground-only defect. It does not reproduce on macOS, which is
 * what a measurement sitting on a fractional-pixel boundary looks like.
 *
 * These tests do not try to recreate that geometry. They pin the mechanism,
 * which is weaker than the comment assumes: `sameStyles` guards `styles`, and
 * NOTHING guards the twelve scalar outputs written straight after it. A
 * consumer that renders `availableSpace` or `contentHeight` — card 11 renders
 * both — re-renders whenever one of those floats moves, and a float measured
 * off `getBoundingClientRect` is free to move by a sub-pixel forever.
 */

const hosts: HTMLElement[] = []
afterEach(() => {
  for (const el of hosts.splice(0)) el.remove()
  vi.restoreAllMocks()
})

function makeRef(top: number): HTMLElement {
  const ref = document.createElement('div')
  document.body.appendChild(ref)
  hosts.push(ref)
  ref.getBoundingClientRect = () =>
    ({
      top,
      left: 50,
      width: 200,
      height: 40,
      right: 250,
      bottom: top + 40,
      x: 50,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  return ref
}

/**
 * A host whose height never settles: every measurement is a hair different
 * from the last. This is the invariant violation the comment names — the read
 * is not a stable property of the content — expressed in its mildest possible
 * form, a jitter far below one pixel.
 */
function jitteringHost(): { el: HTMLElement; reads: () => number } {
  const el = document.createElement('div')
  document.body.appendChild(el)
  hosts.push(el)
  let reads = 0
  el.getBoundingClientRect = () => {
    reads += 1
    const height = 120 + (reads % 2) * 0.001
    return {
      top: 0,
      left: 0,
      width: 200,
      height,
      right: 200,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
  Object.defineProperty(el, 'offsetHeight', { get: () => 120, configurable: true })
  Object.defineProperty(el, 'offsetWidth', { get: () => 200, configurable: true })
  return { el, reads: () => reads }
}

/**
 * Mounts a component shaped like playground card 11: it renders the scalar
 * outputs, so each one is a render dependency, and it binds `styles` to a
 * host — which is what closes the loop.
 */
function mountCard(host: HTMLElement, reference: HTMLElement) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  hosts.push(root)

  const Card = defineComponent({
    setup() {
      const { styles, availableSpace, contentHeight, maxHeight, fit } = useTeleportTo(
        () => ({ to: reference, placement: 'bottom' as const, maxHeight: 240 }),
        () => host,
      )
      return () =>
        h('div', [
          // Exactly what card 11 puts on screen.
          h('span', `${Math.round(availableSpace.value)}`),
          h('span', `${contentHeight.value === null ? '—' : Math.round(contentHeight.value)}`),
          h('span', `${Math.round(maxHeight.value)} ${fit.value}`),
          h('div', { style: styles.value }),
        ])
    },
  })

  const app = createApp(Card)
  app.mount(root)
  return app
}

/**
 * A host whose measurement genuinely ALTERNATES, rather than jittering.
 *
 * 1.1.5 guarded the five float outputs with a 0.05px movement threshold, which
 * kills sub-pixel noise — and that was not enough: CI still bailed out on card
 * 11 against the published 1.1.5. A real A-to-B oscillation is not noise, so
 * it passes the threshold untouched and changes `maxHeight`, `fit`,
 * `truncated` and `styles` on every pass.
 *
 * The source does not matter, and that is the point of fixing it here. It
 * could be a flip decision with no hysteresis (`prevPlacement` feeds the
 * onPlacementChange callback, never the decision), a clamp that changes the
 * answer it was derived from, or a consumer stylesheet keyed on
 * `data-teleport-fit`. Whatever oscillates, the library must not lock the
 * page: it is a popover, and the worst honest outcome is that it stops
 * adjusting and says so.
 */
function oscillatingHost(): { el: HTMLElement; reads: () => number } {
  const el = document.createElement('div')
  document.body.appendChild(el)
  hosts.push(el)
  let reads = 0
  el.getBoundingClientRect = () => {
    reads += 1
    // 120 and 300 straddle the 240 clamp, so every pass flips the verdict.
    const height = reads % 2 === 0 ? 120 : 300
    return { top: 0, left: 0, width: 200, height, right: 200, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  Object.defineProperty(el, 'offsetHeight', { get: () => (reads % 2 === 0 ? 120 : 300), configurable: true })
  Object.defineProperty(el, 'offsetWidth', { get: () => 200, configurable: true })
  return { el, reads: () => reads }
}

describe('the render loop card 11 hit in CI', () => {
  it('a measurement that never settles does not recurse without bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { el, reads } = jitteringHost()
    const app = mountCard(el, makeRef(100))

    for (let i = 0; i < 5; i++) await nextTick()

    const recursion = warn.mock.calls
      .map((c) => c.join(' '))
      .filter((m) => /Maximum recursive updates/.test(m))
    app.unmount()

    expect(
      recursion,
      `Vue bailed out of the render loop:\n${recursion[0] ?? ''}`,
    ).toHaveLength(0)
    // The real assertion. A handful of measurements is a correction; hundreds
    // is the loop, whether or not Vue's counter happened to trip first.
    expect(reads(), 'layout reads taken for one mount with no user input').toBeLessThan(40)
  })

  it('an oscillating measurement cannot lock the page either', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { el, reads } = oscillatingHost()
    const app = mountCard(el, makeRef(100))

    for (let i = 0; i < 5; i++) await nextTick()

    const bail = warn.mock.calls
      .map((c) => c.join(' '))
      .filter((m) => /Maximum recursive updates/.test(m))
    app.unmount()

    expect(bail, `Vue bailed out of the render loop:\n${bail[0] ?? ''}`).toHaveLength(0)
    expect(reads(), 'layout reads for one mount with no user input').toBeLessThan(40)
  })
})
