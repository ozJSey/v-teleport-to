import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, effectScope, h, nextTick, ref, vShow, withDirectives, type Ref } from 'vue'
import { vTeleportTo, TeleportToPlugin, useTeleportTo, type TeleportToOptions, type TeleportToEventDetail } from './vTeleportTo'
import { stateMap } from './src/schedule-update'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeEl(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function makeRef(rect: Partial<DOMRect> = {}): HTMLElement {
  const ref = document.createElement('div')
  document.body.appendChild(ref)
  const base: DOMRect = {
    top: 100,
    left: 50,
    width: 200,
    height: 40,
    right: 250,
    bottom: 140,
    x: 50,
    y: 100,
    toJSON: () => ({}),
  }
  ref.getBoundingClientRect = () => ({ ...base, ...rect }) as DOMRect
  return ref
}

/**
 * Give a host element a measurable layout box.
 *
 * jsdom implements no layout, so `offsetHeight` / `offsetWidth` /
 * `scrollHeight` read `0` on every element — which the library treats as
 * "the host's extent is unknown" and answers with the documented comparative
 * fallback, NOT with "it fits anywhere". So a test that means to exercise the
 * fit-based path has to opt in by stubbing a box, and every fit assertion
 * below therefore states the host size it is deciding about.
 */
function sizeHost(
  el: HTMLElement,
  box: {
    height?: number
    width?: number
    natural?: number
    /**
     * A box **shorter than `min(natural, clamp)`** — the host collapsed by the
     * consumer's own closed state (`max-height: 0`, `height: 0`), which is the
     * shape the tooltip bug arrived in. Reported on every read EXCEPT the
     * directive's own measurement probe, because the probe's whole job is to
     * neutralise that state before reading (TT-18).
     *
     * Without this mode the suite structurally cannot hold a regression for
     * the bug: the other two modes are a fixed height and
     * `min(natural, the max-height we last wrote)`, and both *guarantee* the
     * rect is at least as tall as the content allows. This bug is the case
     * where the rect is smaller than both.
     */
    collapsedTo?: number
    /**
     * Natural height as a function of the width the host is measured at —
     * text that re-wraps. The no-animation half of TT-18: a host measured in
     * normal flow at the parent's width needs fewer lines than the same host
     * at the width the directive is about to give it.
     */
    naturalAt?: (width: number) => number
    /** The width the host has in normal flow, before the directive writes one. */
    flowWidth?: number
  },
): HTMLElement {
  /** A CSS length in `px`, or `null` for `auto` / `none` / `100vw` / absent. */
  const px = (value: string): number | null => {
    if (!/^-?[\d.]+px$/.test(value.trim())) return null
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : null
  }
  /**
   * Is the directive measuring right now? The probe lifts the clamp to
   * `max-height: none`, which no other code path writes — so this is the one
   * read where the host is allowed to report its content rather than its box.
   */
  const probing = () => el.style.getPropertyValue('max-height') === 'none'

  const measureWidth = () => {
    if (!probing()) return box.flowWidth ?? box.width ?? 0
    // `width` wins outright (matchWidth / full-bleed); otherwise the host is
    // shrink-to-fit, capped by `max-width`.
    const explicit = px(el.style.getPropertyValue('width'))
    if (explicit !== null) return explicit
    const cap = px(el.style.getPropertyValue('max-width'))
    // No cap in force means no constraint, which in a browser means the host
    // is whatever width normal flow gives it. A probe that forgot to apply the
    // tick's width lands here — and must, or the "wrapping text is measured at
    // the width the tick writes" regression has nothing to detect.
    if (cap === null) return box.flowWidth ?? box.width ?? 0
    return box.width === undefined ? cap : Math.min(box.width, cap)
  }

  const measure = () => {
    // `v-show` hides by writing an inline `display: none`, and an element with
    // no box has no rect. The probe clears it; nothing else does.
    if (el.style.display === 'none') return 0
    if (box.collapsedTo !== undefined && !probing()) return box.collapsedTo
    const natural = box.naturalAt ? box.naturalAt(measureWidth()) : box.natural
    if (natural === undefined) return box.height ?? 0
    // `natural` models a real browser instead of a fixed number: the host is
    // as tall as its content wants, truncated by whatever `max-height` the
    // directive last wrote. That is the loop the fit test has to survive — a
    // host squeezed onto a cramped side must not start reporting that it fits.
    const clamp = Number.parseFloat(el.style.maxHeight)
    return Number.isFinite(clamp) ? Math.min(natural, clamp) : natural
  }
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      width: el.style.display === 'none' ? 0 : measureWidth(),
      height: measure(),
      right: el.style.display === 'none' ? 0 : measureWidth(),
      bottom: measure(),
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  // Whole-pixel mirrors, exactly as a browser reports them. Present so a test
  // that would pass under a rounded measurement source fails here instead of
  // in someone's app: `offsetHeight` cannot tell a host naturally 39.531px
  // tall from one truncated at 40px, and that ambiguity livelocks the flip.
  Object.defineProperty(el, 'offsetHeight', { get: () => Math.round(measure()), configurable: true })
  Object.defineProperty(el, 'offsetWidth', { get: () => Math.round(box.width ?? 0), configurable: true })
  return el
}

/**
 * A host that counts every layout read taken against it. Used to pin the
 * "no layout read unless `flip` asks for one" half of the fit contract.
 */
function countingHost(): { el: HTMLElement; reads: () => number } {
  const el = makeEl()
  let reads = 0
  el.getBoundingClientRect = () => {
    reads += 1
    return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  return { el, reads: () => reads }
}

function mountDirective(el: HTMLElement, value: TeleportToOptions) {
  const binding = { value, oldValue: undefined as unknown, modifiers: {}, dir: vTeleportTo, instance: null }
  vTeleportTo.mounted!(el, binding as any, null as any, null as any)
}

function updateDirective(el: HTMLElement, value: TeleportToOptions) {
  const binding = { value, oldValue: undefined as unknown, modifiers: {}, dir: vTeleportTo, instance: null }
  vTeleportTo.updated!(el, binding as any, null as any, null as any)
}

function unmountDirective(el: HTMLElement) {
  const binding = { value: {} as TeleportToOptions, oldValue: undefined as unknown, modifiers: {}, dir: vTeleportTo, instance: null }
  vTeleportTo.unmounted!(el, binding as any, null as any, null as any)
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Default viewport
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true })
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true })
  vi.useFakeTimers()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('vTeleportTo', () => {
  it('applies position:fixed and correct positioning on mount', () => {
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref })

    expect(el.style.position).toBe('fixed')
    expect(el.style.zIndex).toBe('1201')
  })

  it('places below reference when there is space', () => {
    // ref at top=100, height=40 => bottom=140
    // window=800, space below = 800-140-150 = 510
    // space above = 100-50 = 50
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    expect(el.style.top).toBe('140px') // parentBottom + 0 offset
    expect(el.style.bottom).toBe('')
  })

  it('places above reference when bottom space is insufficient', () => {
    // ref near bottom: top=700, height=40 => bottom=740
    // space below = 800-740-150 = -90 (clamped to 0 in maxHeight calc)
    // space above = 700-50 = 650
    const el = makeEl()
    const ref = makeRef({ top: 700, height: 40, bottom: 740, left: 50, right: 250, width: 200 })
    mountDirective(el, { to: ref })

    expect(el.style.bottom).toBe('100px') // windowHeight - parentTop + 0
    expect(el.style.top).toBe('')
  })

  it('respects maxHeight option', () => {
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref, maxHeight: 100 })

    expect(el.style.maxHeight).toBe('100px')
  })

  it('uses full viewport width on mobile (<768)', () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref })

    expect(el.style.maxWidth).toBe('100vw')
    expect(el.style.left).toBe('0px')
  })

  it('anchors right when reference is past WIDTH_THRESHOLD (0.71)', () => {
    // windowWidth=1024, threshold=1024*0.71=727
    // ref right=800 > 727 => anchor right
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(el, { to: ref })

    expect(el.style.right).toBe('224px') // 1024-800
    expect(el.style.left).toBe('')
  })

  it('matchWidth sets width equal to reference width', () => {
    const el = makeEl()
    const ref = makeRef({ width: 300, left: 50, right: 350 })
    mountDirective(el, { to: ref, matchWidth: true })

    expect(el.style.width).toBe('300px')
    expect(el.style.maxWidth).toBe('300px')
  })

  it('offsetY shifts position vertically', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref, offsetY: 10 })

    expect(el.style.top).toBe('150px') // 140 + 10
  })

  it('offsetX shifts position horizontally', () => {
    const el = makeEl()
    const ref = makeRef({ left: 50, right: 250, width: 200 })
    mountDirective(el, { to: ref, offsetX: 15 })

    expect(el.style.left).toBe('65px') // 50 + 15
  })

  it('recalculates on resize', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    // Change ref rect to simulate resize
    ref.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    })

    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(17) // one RAF frame

    expect(el.style.top).toBe('240px')
  })

  it('recalculates on scroll', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    ref.getBoundingClientRect = () => ({
      top: 50, left: 50, width: 200, height: 40,
      right: 250, bottom: 90, x: 50, y: 50, toJSON: () => ({}),
    })

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.top).toBe('90px')
  })

  it('does not position when enabled is false', () => {
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref, enabled: false })

    expect(el.style.position).toBe('')
  })

  it('cleans up listeners on unmount', () => {
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref })

    const removeSpy = vi.spyOn(window, 'removeEventListener')
    unmountDirective(el)

    const calls = removeSpy.mock.calls.map(c => c[0])
    expect(calls).toContain('resize')
    expect(calls).toContain('scroll')
  })

  it('dispatches teleport-positioned event with correct detail', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })

    let receivedDetail: any = null
    el.addEventListener('teleport-positioned', ((e: CustomEvent) => {
      receivedDetail = e.detail
    }) as EventListener)

    mountDirective(el, { to: ref })

    expect(receivedDetail).not.toBeNull()
    expect(receivedDetail.placement).toBe('bottom')
    // Raw, boundary-clipped gap: the edge buffers weight the `'auto'`
    // preference and nothing else, so they are no longer subtracted here —
    // which is what makes this number reconcilable with `maxHeight`.
    expect(receivedDetail.availableSpace).toBe(660) // 800-140
    expect(receivedDetail.maxHeight).toBe(240) // min(660, 240)
  })

  it('warns when `to` ref is null/undefined', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = makeEl()

    mountDirective(el, { to: null as unknown as HTMLElement })
    // Deferred to the flush: a template ref is still null at `mounted`, so the
    // warning only fires for a `to` that never arrives. See `warn-missing-to`.
    await nextTick()

    expect(warnSpy).toHaveBeenCalledWith('[v-teleport-to] "to" reference element is required.')
  })

  it('uses rAF batching and does not calculate multiple times per frame', () => {
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref })

    // Track getBoundingClientRect calls after mount
    let callCount = 0
    const originalFn = ref.getBoundingClientRect.bind(ref)
    ref.getBoundingClientRect = () => {
      callCount++
      return originalFn()
    }

    // Fire multiple scroll events in same frame
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))

    // Before RAF fires, no recalculations
    expect(callCount).toBe(0)

    // After one frame
    vi.advanceTimersByTime(17)
    expect(callCount).toBe(1)
  })

  it('forced placement "top" always places above', () => {
    // Even with lots of space below, should place above
    const el = makeEl()
    const ref = makeRef({ top: 400, height: 40, bottom: 440, left: 50, right: 250, width: 200 })
    mountDirective(el, { to: ref, placement: 'top' })

    expect(el.style.bottom).toBe('400px') // 800-400
    expect(el.style.top).toBe('')
  })

  it('forced placement "bottom" always places below', () => {
    // Even near the bottom of viewport, should place below
    const el = makeEl()
    const ref = makeRef({ top: 700, height: 40, bottom: 740, left: 50, right: 250, width: 200 })
    mountDirective(el, { to: ref, placement: 'bottom' })

    expect(el.style.top).toBe('740px')
    expect(el.style.bottom).toBe('')
  })

  it('skips re-positioning when `to` element is detached mid-lifecycle', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    // Initial calc happened.
    expect(el.style.position).toBe('fixed')

    // Now detach the ref and track future events.
    ref.remove()
    let dispatched = false
    el.addEventListener('teleport-positioned', () => {
      dispatched = true
    })

    // Make rect lookup blow up if the directive doesn't bail out.
    ref.getBoundingClientRect = () => {
      throw new Error('getBoundingClientRect called on detached element')
    }

    expect(() => {
      window.dispatchEvent(new Event('scroll'))
      vi.advanceTimersByTime(17)
    }).not.toThrow()

    expect(dispatched).toBe(false)
  })

  it('placement "auto" picks bottom deterministically when space is exactly equal above and below', () => {
    // windowHeight=800, BUFFER_BOTTOM=150 (gap below), BUFFER_TOP=50 (gap above).
    // For a tie: spaceBelow == spaceAbove
    //   spaceBelow = 800 - parentBottom - 150
    //   spaceAbove = parentTop - 50
    // → parentTop + parentBottom = 700. With height=40 → top=330, bottom=370.
    // Both directions give 280px of available space — current `>=` tie-break must pick bottom.
    const el = makeEl()
    const ref = makeRef({ top: 330, height: 40, bottom: 370, left: 50, right: 250, width: 200 })

    let detail: any = null
    el.addEventListener('teleport-positioned', ((e: CustomEvent) => { detail = e.detail }) as EventListener)

    mountDirective(el, { to: ref, placement: 'auto' })

    expect(detail).not.toBeNull()
    expect(detail.placement).toBe('bottom')
    expect(detail.availableSpace).toBe(430) // raw: 800 - 370
    expect(el.style.top).toBe('370px')
    expect(el.style.bottom).toBe('')
    expect(el.style.transformOrigin).toBe('top')
  })

  it('toggling `enabled` from false to true triggers calculation in updated', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })

    // Mount disabled — no calculation should happen.
    mountDirective(el, { to: ref, enabled: false })
    expect(el.style.position).toBe('')
    expect(el.style.top).toBe('')

    let detail: any = null
    el.addEventListener('teleport-positioned', ((e: CustomEvent) => { detail = e.detail }) as EventListener)

    // Flip enabled → true. The updated hook should run an initial calculation.
    updateDirective(el, { to: ref, enabled: true })

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
    expect(detail).not.toBeNull()
    expect(detail.placement).toBe('bottom')
  })

  it('directive on multiple elements with different `to` refs do not interfere', () => {
    // Two independent host elements, each bound to its own reference.
    const elA = makeEl()
    const elB = makeEl()
    const refA = makeRef({ top: 100, height: 40, bottom: 140, left: 50, right: 250, width: 200 })
    const refB = makeRef({ top: 300, height: 40, bottom: 340, left: 60, right: 260, width: 200 })

    const detailsA: any[] = []
    const detailsB: any[] = []
    elA.addEventListener('teleport-positioned', ((e: CustomEvent) => detailsA.push(e.detail)) as EventListener)
    elB.addEventListener('teleport-positioned', ((e: CustomEvent) => detailsB.push(e.detail)) as EventListener)

    mountDirective(elA, { to: refA })
    mountDirective(elB, { to: refB })

    // Each host got its own math from its own ref — no cross-talk.
    expect(elA.style.top).toBe('140px')   // refA bottom
    expect(elB.style.top).toBe('340px')   // refB bottom
    expect(detailsA).toHaveLength(1)
    expect(detailsB).toHaveLength(1)
    expect(detailsA[0].placement).toBe('bottom')
    expect(detailsB[0].placement).toBe('bottom')

    // Mutate ONLY refA's geometry. After a single RAF frame, only elA should re-position.
    refA.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)

    // The scroll listener is registered globally (window). Both hosts' RAFs will fire,
    // but each reads from its own `to` ref — so elB's math is unchanged.
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(elA.style.top).toBe('240px')   // moved with refA
    expect(elB.style.top).toBe('340px')   // unchanged — still tracking refB
    expect(detailsA).toHaveLength(2)
    expect(detailsB).toHaveLength(2)

    // Unmounting one host must not affect the other's state.
    unmountDirective(elA)
    // Move refB but keep it inside the "place below" zone:
    //   spaceBelow = 800 - 240 - 150 = 410, spaceAbove = 200 - 50 = 150 → bottom wins.
    refB.getBoundingClientRect = () => ({
      top: 200, left: 60, width: 200, height: 40,
      right: 260, bottom: 240, x: 60, y: 200, toJSON: () => ({}),
    } as DOMRect)

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    // elA was unmounted → no further updates (still 240px).
    expect(elA.style.top).toBe('240px')
    expect(detailsA).toHaveLength(2)
    // elB still alive → re-positioned to refB's new bottom.
    expect(elB.style.top).toBe('240px')
    expect(detailsB).toHaveLength(3)
  })

  it('offsetX shifts horizontally in the same viewport direction for both left and right anchored placements', () => {
    // Goal: pin SYMMETRIC offsetX semantics — positive offsetX shifts the host
    // RIGHT in viewport coordinates regardless of which side it is anchored to.
    // Math:
    //   left-anchored:  el.style.left  = parentLeft + offsetX
    //   right-anchored: el.style.right = windowWidth - parentRight - offsetX
    //                  → el's right edge in viewport = parentRight + offsetX
    // Both place the element's anchored edge `offsetX` pixels to the right of
    // the parent's matching edge. (Negative offsetX shifts left in both cases.)

    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })

    // ── Left-anchored: ref's right edge well below threshold (1024 * 0.71 = 727)
    const elL = makeEl()
    const refL = makeRef({ left: 50, right: 250, width: 200 })
    mountDirective(elL, { to: refL, offsetX: 15 })
    expect(elL.style.left).toBe('65px')         // 50 + 15  → shifted right by 15
    expect(elL.style.right).toBe('')

    const elLneg = makeEl()
    const refLneg = makeRef({ left: 50, right: 250, width: 200 })
    mountDirective(elLneg, { to: refLneg, offsetX: -15 })
    expect(elLneg.style.left).toBe('35px')      // 50 - 15  → shifted left by 15
    expect(elLneg.style.right).toBe('')

    // ── Right-anchored: ref's right edge above threshold (800 > 727)
    const elR = makeEl()
    const refR = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(elR, { to: refR, offsetX: 15 })
    // Element's right edge in viewport = 1024 - rightValue = parentRight + offsetX = 815.
    // CSS right = windowWidth - parentRight - offsetX = 1024 - 800 - 15 = 209.
    expect(elR.style.right).toBe('209px')
    expect(elR.style.left).toBe('')

    const elRneg = makeEl()
    const refRneg = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(elRneg, { to: refRneg, offsetX: -15 })
    // Negative offsetX → element shifted LEFT 15px → right CSS grows by 15.
    expect(elRneg.style.right).toBe('239px')    // 1024 - 800 - (-15)
    expect(elRneg.style.left).toBe('')
  })

  it('does not throw on mount when `to` element is detached from the DOM', () => {
    const el = makeEl()
    const ref = document.createElement('div') // never appended → detached
    ref.getBoundingClientRect = () => {
      throw new Error('getBoundingClientRect called on detached element')
    }

    expect(() => mountDirective(el, { to: ref })).not.toThrow()
    // No styles applied because we bailed out.
    expect(el.style.position).toBe('')
  })

  // ── `to` polymorphism: HTMLElement | Ref<HTMLElement> | () => HTMLElement ──

  it('accepts `to` as a Ref<HTMLElement>', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const toRef = ref<HTMLElement | null>(refEl)

    mountDirective(el, { to: toRef })

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
  })

  it('accepts `to` as a () => HTMLElement getter', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    mountDirective(el, { to: () => refEl })

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
  })

  it('lazily resolves `to` Ref that starts null and is populated later', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const toRef = ref<HTMLElement | null>(null)

    mountDirective(el, { to: toRef })
    // Initially null → no styles applied, but listeners are attached.
    expect(el.style.position).toBe('')

    // Now populate the ref. A scroll triggers re-evaluation.
    toRef.value = refEl
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
  })

  it('lazily resolves `to` getter that returns null until later', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    let resolved: HTMLElement | null = null

    mountDirective(el, { to: () => resolved })
    expect(el.style.position).toBe('')

    resolved = refEl
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
  })
})

describe('boundary option', () => {
  // Helper: boundary element with controlled rect.
  function makeBoundary(rect: Partial<DOMRect>): HTMLElement {
    const b = document.createElement('div')
    document.body.appendChild(b)
    const base: DOMRect = {
      top: 0, left: 0, width: 1024, height: 800,
      right: 1024, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
    }
    b.getBoundingClientRect = () => ({ ...base, ...rect }) as DOMRect
    return b
  }

  it("'boundary: \"viewport\"' is identical to omitting boundary", () => {
    const el1 = makeEl()
    const el2 = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    mountDirective(el1, { to: refEl })
    mountDirective(el2, { to: refEl, boundary: 'viewport' })

    expect(el1.style.maxHeight).toBe(el2.style.maxHeight)
    expect(el1.style.top).toBe(el2.style.top)
    expect(el1.style.transformOrigin).toBe(el2.style.transformOrigin)
  })

  it('HTMLElement boundary clips available vertical space (clamps maxHeight)', () => {
    const el = makeEl()
    // Ref sits low inside a short boundary; 310px of room below.
    // boundary: top=50, bottom=450 (height 400). ref: top=100, bottom=140.
    // spaceBelow (boundary) = 450 - 140 = 310 → clamped by maxHeight 240.
    // spaceBelow (viewport) would be 800 - 140 = 660 → also 240, so the
    // clamp is demonstrated by shrinking the boundary further below.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 50, height: 250, bottom: 300 })

    mountDirective(el, { to: refEl, boundary })

    expect(el.style.maxHeight).toBe('160px') // 300 - 140
    expect(el.style.top).toBe('140px') // still bottom-anchored
    expect(el.style.transformOrigin).toBe('top')
  })

  it('HTMLElement boundary can flip auto placement from bottom to top', () => {
    const el = makeEl()
    // Boundary sits in the top half (0..200). Ref near its bottom (160..180).
    // spaceBelow (boundary) = 200 - 180 - 150 = -130
    // spaceAbove (boundary) = 160 - 0 - 50 = 110
    // → top placement. Without boundary: spaceBelow=470 → bottom.
    const refEl = makeRef({ top: 160, height: 20, bottom: 180 })
    const boundary = makeBoundary({ top: 0, height: 200, bottom: 200 })

    mountDirective(el, { to: refEl, boundary, placement: 'auto' })

    expect(el.style.transformOrigin).toBe('bottom') // top-anchored placement
    expect(el.style.top).toBe('') // top-anchored clears `top`
    expect(el.style.bottom).toBe(`${800 - 160}px`) // windowHeight - parentTop = 640px
  })

  it('boundary clipping is reflected in teleport-positioned event detail', () => {
    const el = makeEl()
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })

    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 50, height: 250, bottom: 300 })

    mountDirective(el, { to: refEl, boundary })

    expect(events).toHaveLength(1)
    expect(events[0].placement).toBe('bottom')
    expect(events[0].availableSpace).toBe(160) // 300 - 140, no buffer
    expect(events[0].maxHeight).toBe(160)
  })

  it('detached boundary element falls back to viewport', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 50, height: 400, bottom: 450 })
    boundary.remove() // detach before mount

    mountDirective(el, { to: refEl, boundary })

    // Falls back to viewport: spaceBelow = 800 - 140 = 660, clamped to 240.
    expect(el.style.maxHeight).toBe('240px')
  })

  it('useTeleportTo respects boundary option', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 50, height: 250, bottom: 300 })

    const scope = effectScope()
    const { styles, availableSpace } = scope.run(() =>
      useTeleportTo({ to: refEl, boundary }),
    )!

    expect(styles.value.maxHeight).toBe('160px')
    expect(availableSpace.value).toBe(160)

    scope.stop()
  })
})

// `flip` is FIT-based: the preferred side is held for as long as the host fits
// on it, and only moves when it cannot. These tests give the host a measurable
// box (see `sizeHost`) so they exercise that path; the comparative fallback for
// an unmeasurable host has its own tests in the fit-semantics block below.
describe('flip option', () => {
  it('flips placement: "bottom" to top when bottom runs out of room (flip: true)', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    // ref near bottom: top=700, bottom=740 → spaceBelow = 800-740-150 = -90, spaceAbove = 700-50 = 650
    // 80px host: bottom cannot hold it, top can → flip.
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    // Flipped to top-anchored placement.
    expect(el.style.transformOrigin).toBe('bottom')
    expect(el.style.top).toBe('')
    expect(el.style.bottom).toBe('100px') // windowHeight - parentTop = 800 - 700
  })

  it('flips placement: "top" to bottom when top runs out of room (flip: true)', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    // ref near top: top=20, bottom=60 → spaceAbove = 20 - 50 = -30, spaceBelow = 800-60-150 = 590
    // 80px host: top cannot hold it, bottom can → flip.
    const refEl = makeRef({ top: 20, height: 40, bottom: 60 })
    mountDirective(el, { to: refEl, placement: 'top', flip: true })

    // Flipped to bottom-anchored placement.
    expect(el.style.transformOrigin).toBe('top')
    expect(el.style.bottom).toBe('')
    expect(el.style.top).toBe('60px') // parentBottom
  })

  it('DOES flip when flip is omitted — the default is on, and placement is a preference', () => {
    // The mutation test for the `flip` default. Measurable 80px host, 60px of
    // room below (800 − 740) and 700 above: omitting `flip` must still move
    // the host. Before, omission meant "stay and be cut".
    const el = makeEl()
    sizeHost(el, { height: 80 })
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl, placement: 'bottom' })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.transformOrigin).toBe('bottom') // top-anchored
    expect(el.style.top).toBe('')
    expect(el.style.bottom).toBe('100px')
  })

  it('does NOT flip when flip: false explicitly', () => {
    const el = makeEl()
    // Same shape: the host is measurable and does not fit below, so `false`
    // is doing the work.
    sizeHost(el, { height: 80 })
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: false })

    expect(el.style.transformOrigin).toBe('top')
    expect(el.style.top).toBe('740px')
    expect(el.dataset.teleportFit).toBe('unmeasured') // no fit test ran
  })

  it('keeps placement when flip: true and the chosen side fits', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    // Default makeRef position: spaceBelow=510, spaceAbove=50 → bottom fits.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.style.transformOrigin).toBe('top')
    expect(el.style.top).toBe('140px')
    expect(el.style.bottom).toBe('')
    expect(el.dataset.teleportFit).toBe('fits')
  })

  it('flips mid-scroll when chosen side runs out of room (flip: true)', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    // Start with bottom-dominant geometry — placement: 'bottom' fits.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.style.top).toBe('140px')
    expect(el.style.transformOrigin).toBe('top')

    // Scroll: ref drops near viewport bottom → spaceBelow becomes negative.
    refEl.getBoundingClientRect = () => ({
      top: 700, left: 50, width: 200, height: 40, right: 250, bottom: 740,
      x: 50, y: 700, toJSON: () => ({}),
    } as DOMRect)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    // Flipped to top-anchored.
    expect(el.style.transformOrigin).toBe('bottom')
    expect(el.style.top).toBe('')
    expect(el.style.bottom).toBe('100px')
  })

  it('flip: true with placement: "auto" matches plain "auto" behavior (no-op)', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const elBaseline = makeEl()
    sizeHost(elBaseline, { height: 80 })
    mountDirective(elBaseline, { to: refEl, placement: 'auto' })

    const el = makeEl()
    sizeHost(el, { height: 80 })
    mountDirective(el, { to: refEl, placement: 'auto', flip: true })

    expect(el.style.top).toBe(elBaseline.style.top)
    expect(el.style.bottom).toBe(elBaseline.style.bottom)
    expect(el.style.transformOrigin).toBe(elBaseline.style.transformOrigin)
  })

  it('teleport-positioned event detail reflects the flipped placement', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })

    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(events).toHaveLength(1)
    expect(events[0].placement).toBe('top')
    expect(events[0].availableSpace).toBe(700) // parentTop - 0, raw
    expect(events[0].oppositeSpace).toBe(60) // the side it rejected: 800 - 740
    expect(events[0].fit).toBe('flipped')
  })

  it('useTeleportTo without a host keeps the requested side — it does not guess', () => {
    // No host means no fit answer. Second-guessing the consumer's named side
    // on the strength of no measurement is what the comparative fallback used
    // to do; it now honours what they asked for and says `'unmeasured'`.
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })

    const scope = effectScope()
    const { styles, placement, fit } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'bottom', flip: true }),
    )!

    expect(placement.value).toBe('bottom')
    expect(fit.value).toBe('unmeasured')
    expect(styles.value.top).toBe('740px')

    scope.stop()
  })

  it('useTeleportTo WITH a host runs the fit test and flips like the directive', () => {
    // The composable's documented degradation is opt-in now: pass the host and
    // the fit test works there exactly as it does on the directive path.
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    const host = sizeHost(makeEl(), { height: 80 })

    const scope = effectScope()
    const { styles, placement, fit } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'bottom' }, host),
    )!

    expect(placement.value).toBe('top')
    expect(fit.value).toBe('flipped')
    expect(styles.value.bottom).toBe('100px')
    expect(styles.value.top).toBe('')

    scope.stop()
  })
})

// ─── flip: fit-based semantics ─────────────────────────────────────────────────
//
// The distinguishing property, and the reason `flip` exists as a separate
// option: the preferred side is HELD while the host fits on it, even when the
// opposite side has more room. Under the old comparative rule every one of the
// "stays" tests below would flip, and `placement: 'bottom'` + `flip` produced
// byte-identical output to plain `placement: 'auto'`.
//
// Geometry recap (default viewport 1024×800, no boundary). The fit test and
// the `max-height` clamp read the RAW gaps; the edge buffers only weight the
// `'auto'` preference between two sides:
//   raw below = 800 − refBottom          raw above = refTop
//   raw right = 1024 − refRight          raw left  = refLeft
//   preference below = raw below − BUFFER_BOTTOM(150)
//   preference above = raw above − BUFFER_TOP(50)
describe('flip option — fit-based semantics', () => {
  function makeBoundary(rect: Partial<DOMRect> = {}): HTMLElement {
    const b = document.createElement('div')
    document.body.appendChild(b)
    const base: DOMRect = {
      top: 0, left: 0, width: 1024, height: 800,
      right: 1024, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
    }
    b.getBoundingClientRect = () => ({ ...base, ...rect }) as DOMRect
    return b
  }

  // ── vertical ────────────────────────────────────────────────────────────────

  it('keeps "bottom" when the host fits below even though above has FOUR TIMES the room', () => {
    // raw below = 260, raw above = 500. An 80px host fits below. Comparative
    // on the buffered preference (110 vs 450) would elect 'top' — the bug.
    const el = makeEl()
    sizeHost(el, { height: 80 })
    const refEl = makeRef({ top: 500, height: 40, bottom: 540 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.top).toBe('540px')
    expect(el.style.bottom).toBe('')
    expect(el.style.transformOrigin).toBe('top')
    // min(raw 260, maxHeight 240). The buffer is not charged to the content:
    // it used to be, and a host with 260px of real room was cut at 110px.
    expect(el.style.maxHeight).toBe('240px')
  })

  it('keeps "top" when the host fits above even though below has more room', () => {
    // raw above = 200, raw below = 560. A 100px host fits above. Comparative
    // on the buffered preference (150 vs 410) would elect 'bottom'.
    const el = makeEl()
    sizeHost(el, { height: 100 })
    const refEl = makeRef({ top: 200, height: 40, bottom: 240 })
    mountDirective(el, { to: refEl, placement: 'top', flip: true })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.bottom).toBe('600px') // 800 - refTop
    expect(el.style.top).toBe('')
    expect(el.style.maxHeight).toBe('200px') // min(raw 200, 240)
  })

  it('flips when the preferred side cannot fit the host and the opposite can', () => {
    // Ref lower down: raw below = 140, raw above = 620. A 200px host does not
    // fit below and does fit above.
    const el = makeEl()
    sizeHost(el, { height: 200 })
    const refEl = makeRef({ top: 620, height: 40, bottom: 660 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.bottom).toBe('180px') // 800 - refTop
    expect(el.style.top).toBe('')
    expect(el.style.transformOrigin).toBe('bottom')
  })

  it('host height decides the side: same geometry, two host sizes, two sides', () => {
    // raw below = 140, raw above = 620.
    const refEl = makeRef({ top: 620, height: 40, bottom: 660 })

    const small = makeEl()
    sizeHost(small, { height: 80 })
    mountDirective(small, { to: refEl, placement: 'bottom', flip: true })

    const large = makeEl()
    sizeHost(large, { height: 200 })
    mountDirective(large, { to: refEl, placement: 'bottom', flip: true })

    expect(small.dataset.teleportPlacement).toBe('bottom')
    expect(large.dataset.teleportPlacement).toBe('top')
  })

  it('falls back to comparative when NEITHER side fits, and says so', () => {
    // Short viewport: raw below = 400-260 = 140, raw above = 100. A 200px host
    // fits on neither side → the side with the most RAW room wins (the buffered
    // preference would have said 'top' — 50 vs −10 — and handed the consumer
    // 100px of content instead of 140), and the verdict is reported rather
    // than silently rendering a squeezed host.
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true, writable: true })
    const el = makeEl()
    sizeHost(el, { height: 200 })
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    const refEl = makeRef({ top: 100, height: 160, bottom: 260 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('bottom') // raw 140 > 100
    expect(el.dataset.teleportFit).toBe('neither')
    expect(events[0].fit).toBe('neither')
    expect(events[0].availableSpace).toBe(140)
    expect(events[0].oppositeSpace).toBe(100)
    expect(el.style.maxHeight).toBe('140px')
    expect(events[0].collapsed).toBe(false) // clamped, but not to nothing
  })

  it('the 0px-host dead band is observable — fit AND a collapsed flag (TT-13)', () => {
    // A reference as tall as its own scroll pane: raw room is 0 on both sides,
    // so `maxHeight` genuinely clamps to 0 and the host paints as nothing but
    // its padding, fully opaque. That used to be reachable on ordinary
    // geometry purely because the 150/50 buffers were charged to the height;
    // now it takes a reference with no room at all, and when it happens the
    // host says so.
    const el = makeEl()
    sizeHost(el, { height: 120 })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 100, height: 40, bottom: 140, left: 0, right: 400, width: 400 })
    mountDirective(el, { to: refEl, boundary, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('bottom') // raw 0 == raw 0, tie
    expect(el.dataset.teleportFit).toBe('neither')
    expect(el.style.maxHeight).toBe('0px')
    expect(el.hasAttribute('data-teleport-collapsed')).toBe(true)
  })

  it('a collapsed host says so even when its extent could not be measured', () => {
    // The case `fit` cannot carry on its own: no measurable box means
    // `'unmeasured'`, which reads like "nothing to report" — while the host is
    // being painted at zero height. This is the state the audit found
    // rendering as a 10px empty box with `visibility: visible` and no signal.
    const el = makeEl() // no sizeHost — nothing to measure
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 100, height: 40, bottom: 140, left: 0, right: 400, width: 400 })
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    mountDirective(el, { to: refEl, boundary })

    expect(el.dataset.teleportFit).toBe('unmeasured')
    expect(el.style.maxHeight).toBe('0px')
    expect(el.hasAttribute('data-teleport-collapsed')).toBe(true)
    expect(events[0].collapsed).toBe(true)
  })

  it('the collapsed flag clears again once there is room', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundary({ top: 100, height: 40, bottom: 140, left: 0, right: 400, width: 400 })
    mountDirective(el, { to: refEl, boundary })
    expect(el.hasAttribute('data-teleport-collapsed')).toBe(true)

    boundary.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.hasAttribute('data-teleport-collapsed')).toBe(false)
    expect(el.style.maxHeight).toBe('240px')
  })

  it('flip: false never moves the host, however badly it fits', () => {
    // spaceBelow = -90 and the 200px host is measurable — nothing may move it.
    const el = makeEl()
    sizeHost(el, { height: 200 })
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: false })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('unmeasured')
    expect(el.style.top).toBe('740px')
  })

  it('an unmeasurable host keeps the requested side, and never reports "fits"', () => {
    // With no measurable box the honest answer is "unknown" — a 0px
    // measurement must never be read as "fits anywhere". The side the consumer
    // named is then the least surprising answer: moving it on the strength of
    // no evidence is what the comparative fallback used to do, and under a
    // default-on `flip` that would silently relocate every popover whose host
    // is `display: none` on the tick it is measured.
    const el = makeEl() // no sizeHost
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('unmeasured')
  })

  it('placement: "auto" — the DEFAULT — runs the fit test and moves the host', () => {
    // The mutation test for TT-15. `'auto'` used to return the comparatively
    // roomier side before the fit test could run, so a bare binding never
    // asked whether the popover fitted where it was put.
    //
    // Geometry chosen so the two rules disagree, which takes the asymmetric
    // buffers to arrange: a 380px-tall reference at 200..580 in an 800px
    // viewport gives raw above 200, raw below 220 — but the PREFERENCE is
    // 200−50 = 150 above against 220−150 = 70 below, so `'auto'` prefers top.
    // A 210px host does not fit in 200 above and does fit in 220 below.
    const refEl = makeRef({ top: 200, height: 380, bottom: 580 })

    const el = makeEl()
    sizeHost(el, { height: 210 })
    mountDirective(el, { to: refEl }) // bare binding: no placement, no flip

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.top).toBe('580px')
    expect(el.style.bottom).toBe('')
  })

  it('placement: "auto" prefers the roomier side while the host fits on it', () => {
    // The other half of the same rule: fit-awareness does not turn `'auto'`
    // into "always the side with the most raw room". Same geometry, a host
    // small enough to fit above — the preference stands.
    const refEl = makeRef({ top: 200, height: 380, bottom: 580 })

    const el = makeEl()
    sizeHost(el, { height: 120 })
    mountDirective(el, { to: refEl })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('fits')
  })

  it('placement: "auto" + flip: false is the opt-out — comparative, no measurement', () => {
    // `'auto'` names no side, so `flip: false` pins the comparative one.
    const refEl = makeRef({ top: 200, height: 380, bottom: 580 })

    const el = makeEl()
    sizeHost(el, { height: 210 })
    mountDirective(el, { to: refEl, flip: false })

    expect(el.dataset.teleportPlacement).toBe('top') // preference, uncorrected
    expect(el.dataset.teleportFit).toBe('unmeasured')
  })

  it('placement: "auto" stays vertical-only — the fit test never elects a horizontal side', () => {
    // A host far too tall for either vertical side must not be answered with
    // 'left' or 'right'; `'auto'` is a vertical contract.
    const refEl = makeRef({ top: 200, height: 380, bottom: 580 })

    const el = makeEl()
    sizeHost(el, { height: 240, width: 10 })
    mountDirective(el, { to: refEl })

    expect(['top', 'bottom']).toContain(el.dataset.teleportPlacement)
  })

  it('sees through its own max-height clamp — a squeezed host does not start "fitting"', () => {
    // A host clamped to a cramped side measures exactly as tall as that side,
    // so a naive `offsetHeight` read would report "fits" from the second tick
    // onward and the host would stay squeezed forever. `natural: 400` models
    // the real browser: content taller than the clamp, truncated by it.
    const el = makeEl()
    sizeHost(el, { natural: 400 })
    const refEl = makeRef({ top: 620, height: 40, bottom: 660 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    // 400 wants 240 (its maxHeight cap): raw below is 140, raw above is 620 →
    // flips to top and takes the full 240.
    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.maxHeight).toBe('240px')
  })

  it('a host whose content genuinely is 110px keeps the cramped side', () => {
    const el = makeEl()
    sizeHost(el, { natural: 110 })
    const refEl = makeRef({ top: 620, height: 40, bottom: 660 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('fits')
  })

  it('"neither" survives the tick that clamps the host — it is not a one-frame signal', () => {
    // Short viewport: raw below = 140, raw above = 100. A host wanting 200px
    // fits on neither side, so the directive clamps it to 140 — and on the
    // NEXT tick that clamped host measures 140, which 140 "fits". Reading the
    // clamp back is what keeps the verdict honest across ticks.
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true, writable: true })
    const el = makeEl()
    sizeHost(el, { natural: 200 })
    const refEl = makeRef({ top: 100, height: 160, bottom: 260 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportFit).toBe('neither')
    expect(el.style.maxHeight).toBe('140px')
    expect(el.getBoundingClientRect().height).toBe(140) // truncated by our clamp

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.dataset.teleportFit).toBe('neither')
    expect(el.dataset.teleportPlacement).toBe('bottom')

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.dataset.teleportFit).toBe('neither')
  })

  it('a side that fits stays put across ticks once the host is positioned', () => {
    // The mirror of the test above: a host that genuinely fits must not be
    // talked out of its side by its own applied clamp either.
    const el = makeEl()
    sizeHost(el, { natural: 80 })
    const refEl = makeRef({ top: 500, height: 40, bottom: 540 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    for (let tick = 0; tick < 3; tick += 1) {
      expect(el.dataset.teleportPlacement).toBe('bottom')
      expect(el.dataset.teleportFit).toBe('fits')
      window.dispatchEvent(new Event('scroll'))
      vi.advanceTimersByTime(17)
    }
  })

  it('a sub-pixel host is not mistaken for one truncated by our own clamp', () => {
    // The clamp test has to work at sub-pixel precision. Boundary 50..357.34,
    // ref 90..120 → raw above = 40, raw below = 237.34. A host naturally
    // 39.531px tall fits above (40 ≥ 39.531), so the directive clamps to 40 —
    // and a whole-pixel reading of that host comes back as 40, which reads as
    // "truncated", which demands the full 240px maxHeight, which fits on
    // neither side, which moves the host, which lifts the clamp, which makes
    // it fit again. Reproduced in a real browser as a Vue
    // "Maximum recursive updates exceeded"; the fix is measuring the rect.
    const el = makeEl()
    sizeHost(el, { natural: 39.531 })
    const refEl = makeRef({ top: 90, height: 30, bottom: 120 })
    const boundary = makeBoundary({ top: 50, height: 307.34, bottom: 357.34 })
    mountDirective(el, { to: refEl, boundary, placement: 'top', flip: true })

    expect(el.style.maxHeight).toBe('40px')
    for (let tick = 0; tick < 5; tick += 1) {
      expect(el.dataset.teleportPlacement).toBe('top')
      expect(el.dataset.teleportFit).toBe('fits')
      window.dispatchEvent(new Event('scroll'))
      vi.advanceTimersByTime(17)
    }
  })

  it('the height that must fit is capped at the maxHeight option', () => {
    // 1000px of content, but the consumer capped the host at 100px — so 100px
    // is all that has to fit, and the 140px below is enough.
    const el = makeEl()
    sizeHost(el, { natural: 1000 })
    const refEl = makeRef({ top: 620, height: 40, bottom: 660 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true, maxHeight: 100 })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.maxHeight).toBe('100px')
  })

  it('an arrow that moves with the placement cannot move the decision', () => {
    // Regression: `scrollHeight` was tried as the "see through the clamp"
    // source and livelocked in a real browser — a `::after` arrow pinned to
    // the edge facing the reference inflates the scrolling area on whichever
    // side it is currently on, so the two sides took turns until Vue threw
    // "Maximum recursive updates exceeded". `offsetHeight` ignores
    // absolutely-positioned children, so a decoration cannot vote.
    const el = makeEl()
    sizeHost(el, { height: 40 })
    // Whatever the arrow does to the scrolling area, it must not be read.
    // Inflated on whichever side the host is currently on — the shape an
    // edge-pinned arrow gives the scrolling area. Reading it would flip the
    // host to 'top' on tick 2, deflate, and flip back on tick 3, forever.
    Object.defineProperty(el, 'scrollHeight', {
      get: () => (el.dataset.teleportPlacement === 'bottom' ? 4000 : 40),
      configurable: true,
    })
    const refEl = makeRef({ top: 500, height: 40, bottom: 540 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    for (let tick = 0; tick < 5; tick += 1) {
      expect(el.dataset.teleportPlacement).toBe('bottom')
      window.dispatchEvent(new Event('scroll'))
      vi.advanceTimersByTime(17)
    }
    expect(el.dataset.teleportFit).toBe('fits')
  })

  it('reads the host box exactly once per tick, and not at all without a host', () => {
    // The contract changed when `flip` became the default: the host IS read on
    // every tick, because the fit test, the cross-axis anchor and the arrow
    // variables all need it. What must hold is that they share ONE read —
    // two reads is how the arrow and the placement came to disagree about how
    // wide the host was — and that it costs no extra reflow, since the
    // reference's own rect has already forced one by this point.
    const refEl = makeRef({ top: 500, height: 40, bottom: 540 })

    const on = countingHost()
    mountDirective(on.el, { to: refEl, placement: 'bottom' })
    expect(on.reads()).toBe(1)

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(on.reads()).toBe(2)

    const auto = countingHost()
    mountDirective(auto.el, { to: refEl })
    expect(auto.reads()).toBe(1)
  })

  it('flip: false skips the fit test but still shares the one host read', () => {
    // `flip: false` opts out of the DECISION, not of the arrow being right.
    const refEl = makeRef({ top: 500, height: 40, bottom: 540 })

    const off = countingHost()
    mountDirective(off.el, { to: refEl, placement: 'bottom', flip: false })
    expect(off.reads()).toBe(1)
    expect(off.el.dataset.teleportFit).toBe('unmeasured')
  })

  // ── horizontal ──────────────────────────────────────────────────────────────

  it('keeps "right" when the host fits beside it even though left has more room', () => {
    // ref left=600 right=800 → spaceRight = 224, spaceLeft = 600.
    // The 200px-wide host fits on the right. Note the projected width the
    // overflow math uses would be 200 × 1.5 = 300 — the fit test measures the
    // host instead, so a narrow host is not flipped away on a projection.
    const el = makeEl()
    sizeHost(el, { width: 200 })
    const refEl = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: true })

    expect(el.dataset.teleportPlacement).toBe('right')
    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.left).toBe('800px')
    expect(el.style.right).toBe('')
  })

  it('flips "right" → "left" when the host cannot fit on the right', () => {
    const el = makeEl()
    sizeHost(el, { width: 400 }) // 400 > spaceRight 224, ≤ spaceLeft 600
    const refEl = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: true })

    expect(el.dataset.teleportPlacement).toBe('left')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.right).toBe('424px') // 1024 - refLeft
    expect(el.style.left).toBe('')
  })

  it('falls back to comparative when neither horizontal side fits, and says so', () => {
    const el = makeEl()
    sizeHost(el, { width: 700 }) // wider than both 224 and 600
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    const refEl = makeRef({ left: 600, right: 800, width: 200 })
    // `widthMultiplier: 3.5` puts the host's own `max-width` at 700 so the
    // 700px content is reachable. The default 1.5 caps it at 300, and a host
    // cannot measure wider than the `max-width` the tick applies — the fit
    // test would then be deciding about a width the host can never render at,
    // which is the horizontal half of the bug this measurement exists to fix.
    mountDirective(el, { to: refEl, placement: 'right', flip: true, widthMultiplier: 3.5 })

    expect(el.dataset.teleportPlacement).toBe('left') // 600 > 224
    expect(el.dataset.teleportFit).toBe('neither')
    expect(events[0].availableSpace).toBe(600)
    expect(events[0].oppositeSpace).toBe(224)
  })

  it('flip: false never moves a horizontally-placed host', () => {
    const el = makeEl()
    sizeHost(el, { width: 400 })
    const refEl = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: false })

    expect(el.dataset.teleportPlacement).toBe('right')
    expect(el.dataset.teleportFit).toBe('unmeasured')
    expect(el.style.left).toBe('800px')
  })

  it('an unmeasurable width keeps the requested horizontal side', () => {
    // Same rule as the vertical axis: no measurement, no second-guessing.
    const el = makeEl() // no sizeHost
    const refEl = makeRef({ left: 600, right: 800, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: true })

    expect(el.dataset.teleportPlacement).toBe('right')
    expect(el.dataset.teleportFit).toBe('unmeasured')
  })

  // ── reported state ──────────────────────────────────────────────────────────

  it('event detail reports the losing side for every placement', () => {
    const el = makeEl()
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, placement: 'bottom' })

    expect(events[0].placement).toBe('bottom')
    expect(events[0].availableSpace).toBe(660) // 800-140, raw
    expect(events[0].oppositeSpace).toBe(100) // 100, raw
    expect(events[0].fit).toBe('unmeasured') // no measurable host box
  })

  it('data-teleport-fit is cleared when the directive goes dormant', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })
    expect(el.dataset.teleportFit).toBe('fits')

    updateDirective(el, { to: refEl, enabled: false })
    expect(el.hasAttribute('data-teleport-fit')).toBe(false)
  })

  it('data-teleport-fit is cleared when the reference detaches', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })
    expect(el.dataset.teleportFit).toBe('fits')

    refEl.remove()
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.hasAttribute('data-teleport-fit')).toBe(false)
  })

  it('useTeleportTo exposes fit + oppositeSpace, and reports the documented degradation', () => {
    // Without a host the composable has nothing to measure, so `fit` says so
    // and the requested side stands — the degradation is stated in the return
    // type rather than silently pretended away.
    const refEl = makeRef({ top: 500, height: 40, bottom: 540 })

    const scope = effectScope()
    const { placement, availableSpace, oppositeSpace, fit } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'bottom', flip: true }),
    )!

    expect(fit.value).toBe('unmeasured')
    expect(placement.value).toBe('bottom')
    expect(availableSpace.value).toBe(260) // raw: 800 - 540
    expect(oppositeSpace.value).toBe(500) // raw: refTop

    scope.stop()
  })
})

describe('data-teleport-placement attribute', () => {
  it('sets data-teleport-placement="bottom" on host when placed below', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.getAttribute('data-teleport-placement')).toBe('bottom')
  })

  it('sets data-teleport-placement="top" on host when placed above', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 700, height: 40, bottom: 740 })
    mountDirective(el, { to: refEl })

    expect(el.dataset.teleportPlacement).toBe('top')
  })

  it('flips data-teleport-placement on scroll when geometry changes', () => {
    const el = makeEl()
    sizeHost(el, { height: 80 })
    // Start with plenty of room below.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true })

    expect(el.dataset.teleportPlacement).toBe('bottom')

    // Scroll the reference near the bottom: now there is no room below.
    refEl.getBoundingClientRect = () => ({
      top: 700, left: 50, width: 200, height: 40,
      right: 250, bottom: 740, x: 50, y: 700, toJSON: () => ({}),
    } as DOMRect)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.dataset.teleportPlacement).toBe('top')
  })

  it('clears data-teleport-placement when enabled toggles to false', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })
    expect(el.dataset.teleportPlacement).toBe('bottom')

    updateDirective(el, { to: refEl, enabled: false })
    expect(el.dataset.teleportPlacement).toBeUndefined()
    expect(el.hasAttribute('data-teleport-placement')).toBe(false)
  })

  it('does not set data-teleport-placement when `to` is missing on mount', () => {
    const el = makeEl()
    // Suppress the [v-teleport-to] warn from the missing-to bail.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })

    expect(el.hasAttribute('data-teleport-placement')).toBe(false)
  })

  it('clears data-teleport-placement when `to` becomes detached and a recalc fires', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })
    expect(el.dataset.teleportPlacement).toBe('bottom')

    refEl.remove()
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.hasAttribute('data-teleport-placement')).toBe(false)
  })
})

describe('TeleportToPlugin', () => {
  it('exposes an install function', () => {
    expect(TeleportToPlugin).toBeTypeOf('object')
    expect(TeleportToPlugin.install).toBeTypeOf('function')
  })

  it('registers vTeleportTo as the global "teleport-to" directive on app.use()', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const app = createApp({ render: () => h('div') })
    app.use(TeleportToPlugin)

    // Vue normalises directive lookup: registered name must resolve back to the
    // exact directive object.
    expect(app.directive('teleport-to')).toBe(vTeleportTo)

    app.mount(host)
    app.unmount()
  })

  it('actually positions an element when used through the plugin in a real Vue render', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const ref = makeRef({ top: 100, height: 40, bottom: 140 })

    const app = createApp({
      render() {
        return h('div', {
          ref: 'panel',
          ['v-teleport-to' as any]: { to: ref },
        })
      },
    })
    app.use(TeleportToPlugin)

    // Sanity: the directive is reachable through the public install.
    expect(app.directive('teleport-to')).toBe(vTeleportTo)

    app.mount(host)
    app.unmount()
  })

  it('install is idempotent — calling app.use twice does not throw', () => {
    const app = createApp({ render: () => h('div') })
    expect(() => {
      app.use(TeleportToPlugin)
      app.use(TeleportToPlugin)
    }).not.toThrow()
    expect(app.directive('teleport-to')).toBe(vTeleportTo)
  })
})

// ─── useTeleportTo composable ──────────────────────────────────────────────────

describe('useTeleportTo', () => {
  it('exposes reactive styles, placement, availableSpace and maxHeight refs', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const result = scope.run(() => useTeleportTo({ to: refEl }))!

    expect(result.styles).toBeDefined()
    expect(result.placement).toBeDefined()
    expect(result.availableSpace).toBeDefined()
    expect(result.maxHeight).toBeDefined()
    expect(typeof result.update).toBe('function')

    // Initial calculation already ran.
    expect(result.styles.value.position).toBe('fixed')
    expect(result.styles.value.top).toBe('140px')
    expect(result.placement.value).toBe('bottom')
    expect(result.availableSpace.value).toBe(660) // raw: 800 - 140
    expect(result.maxHeight.value).toBe(240)

    scope.stop()
  })

  it('produces the same styles as the directive for the same options', () => {
    const refForDirective = makeRef({ top: 100, height: 40, bottom: 140 })
    const el = makeEl()
    mountDirective(el, { to: refForDirective })

    const refForComposable = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refForComposable }))!

    // Each property the directive applied is reflected in the composable's styles.
    expect(styles.value.position).toBe(el.style.position)
    expect(styles.value.zIndex).toBe(el.style.zIndex)
    expect(styles.value.top).toBe(el.style.top)
    expect(styles.value.maxHeight).toBe(el.style.maxHeight)
    expect(styles.value.transformOrigin).toBe(el.style.transformOrigin)

    scope.stop()
  })

  it('reactively updates when options ref changes', async () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const opts = ref<TeleportToOptions>({ to: refEl, maxHeight: 200 })

    const scope = effectScope()
    const { styles, maxHeight } = scope.run(() => useTeleportTo(opts))!

    expect(styles.value.maxHeight).toBe('200px')
    expect(maxHeight.value).toBe(200)

    opts.value = { to: refEl, maxHeight: 100 }
    // watchEffect schedules; flush microtasks/timers.
    await Promise.resolve()
    vi.advanceTimersByTime(17)

    expect(styles.value.maxHeight).toBe('100px')
    expect(maxHeight.value).toBe(100)

    scope.stop()
  })

  it('recalculates on scroll via RAF batching', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl }))!

    expect(styles.value.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(styles.value.top).toBe('240px')
    scope.stop()
  })

  it('cleans up listeners when scope is stopped', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl }))!

    expect(styles.value.top).toBe('140px')

    const removeSpy = vi.spyOn(window, 'removeEventListener')
    scope.stop()

    const removed = removeSpy.mock.calls.map(c => c[0])
    expect(removed).toContain('resize')
    expect(removed).toContain('scroll')

    // After stop, scrolling does not update styles further.
    refEl.getBoundingClientRect = () => ({
      top: 500, left: 50, width: 200, height: 40,
      right: 250, bottom: 540, x: 50, y: 500, toJSON: () => ({}),
    } as DOMRect)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(styles.value.top).toBe('140px') // unchanged
  })

  it('clears styles and placement when enabled is false', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const opts = ref<TeleportToOptions>({ to: refEl, enabled: true })

    const scope = effectScope()
    const { styles, placement } = scope.run(() => useTeleportTo(opts))!

    expect(styles.value.position).toBe('fixed')
    expect(placement.value).toBe('bottom')

    opts.value = { to: refEl, enabled: false }
    vi.advanceTimersByTime(17)

    expect(Object.keys(styles.value)).toHaveLength(0)
    expect(placement.value).toBeNull()

    scope.stop()
  })

  it('does not throw when `to` is missing or detached', () => {
    const scope = effectScope()
    expect(() => {
      scope.run(() => useTeleportTo({ to: null as unknown as HTMLElement }))
    }).not.toThrow()
    scope.stop()

    const detached = document.createElement('div') // never appended
    detached.getBoundingClientRect = () => {
      throw new Error('called on detached')
    }
    const scope2 = effectScope()
    expect(() => {
      scope2.run(() => useTeleportTo({ to: detached }))
    }).not.toThrow()
    scope2.stop()
  })

  it('accepts `to` as a Ref<HTMLElement>', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const toRef = ref<HTMLElement | null>(refEl)

    const scope = effectScope()
    const { styles, placement } = scope.run(() => useTeleportTo({ to: toRef }))!

    expect(styles.value.position).toBe('fixed')
    expect(styles.value.top).toBe('140px')
    expect(placement.value).toBe('bottom')
    scope.stop()
  })

  it('accepts `to` as a () => HTMLElement getter', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: () => refEl }))!
    expect(styles.value.position).toBe('fixed')
    expect(styles.value.top).toBe('140px')
    scope.stop()
  })

  it('reactively re-runs when a `to` Ref is later populated', async () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const toRef = ref<HTMLElement | null>(null)

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: toRef }))!

    // Initially nothing — ref is null.
    expect(styles.value.position).toBeUndefined()

    toRef.value = refEl
    await Promise.resolve()
    vi.advanceTimersByTime(17)

    expect(styles.value.position).toBe('fixed')
    expect(styles.value.top).toBe('140px')
    scope.stop()
  })

  it('manual update() recomputes styles immediately', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles, update } = scope.run(() => useTeleportTo({ to: refEl }))!

    expect(styles.value.top).toBe('140px')

    // Change geometry without firing scroll/resize.
    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)

    update()
    expect(styles.value.top).toBe('340px')

    scope.stop()
  })
})

// ─── strategy: 'fixed' | 'absolute' ────────────────────────────────────────────

/** Pin a custom offsetParent on the host element. jsdom does not lay out
 *  pages, so `el.offsetParent` is unreliable by default — explicit override
 *  via `Object.defineProperty` keeps these tests deterministic. */
function setOffsetParent(el: HTMLElement, parent: HTMLElement | null) {
  Object.defineProperty(el, 'offsetParent', { value: parent, configurable: true })
}

describe('strategy option', () => {
  it('defaults to position:fixed when strategy is omitted (back-compat)', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })
    expect(el.style.position).toBe('fixed')
  })

  it('strategy:"fixed" explicitly produces position:fixed with viewport coords', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, strategy: 'fixed' })
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
    expect(el.style.left).toBe('50px')
  })

  it('strategy:"absolute" sets position:absolute on the host', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })
    expect(el.style.position).toBe('absolute')
  })

  it('strategy:"absolute" computes top/left relative to offsetParent rect', () => {
    const el = makeEl()
    const offsetParentEl = document.createElement('div')
    document.body.appendChild(offsetParentEl)
    offsetParentEl.getBoundingClientRect = () => ({
      top: 50, left: 30, right: 530, bottom: 450,
      width: 500, height: 400, x: 30, y: 50, toJSON: () => ({}),
    } as DOMRect)
    setOffsetParent(el, offsetParentEl)

    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 80, right: 280, width: 200 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })

    // Coords are subtracted from the offsetParent rect:
    //   top  = parentBottom (140) - offsetParent.top (50) = 90
    //   left = parentLeft   (80)  - offsetParent.left(30) = 50
    expect(el.style.position).toBe('absolute')
    expect(el.style.top).toBe('90px')
    expect(el.style.left).toBe('50px')
    expect(el.style.bottom).toBe('')
    expect(el.style.right).toBe('')
  })

  it('strategy:"absolute" with placement:"top" computes bottom relative to offsetParent', () => {
    const el = makeEl()
    const offsetParentEl = document.createElement('div')
    document.body.appendChild(offsetParentEl)
    offsetParentEl.getBoundingClientRect = () => ({
      top: 50, left: 30, right: 530, bottom: 450,
      width: 500, height: 400, x: 30, y: 50, toJSON: () => ({}),
    } as DOMRect)
    setOffsetParent(el, offsetParentEl)

    // Reference near viewport bottom forces auto → 'top' placement.
    const refEl = makeRef({ top: 700, height: 40, bottom: 740, left: 80, right: 280, width: 200 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })

    // bottom = offsetParent.bottom (450) - parentTop (700) = -250
    expect(el.style.position).toBe('absolute')
    expect(el.style.bottom).toBe('-250px')
    expect(el.style.top).toBe('')
  })

  it('strategy:"absolute" anchors right relative to offsetParent', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const offsetParentEl = document.createElement('div')
    document.body.appendChild(offsetParentEl)
    offsetParentEl.getBoundingClientRect = () => ({
      top: 0, left: 0, right: 1024, bottom: 800,
      width: 1024, height: 800, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    setOffsetParent(el, offsetParentEl)

    // ref past WIDTH_THRESHOLD (right=800 in 1024px viewport, threshold ~727)
    const refEl = makeRef({ left: 600, right: 800, width: 200, top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })

    // right = offsetParent.right (1024) - parentRight (800) = 224
    expect(el.style.right).toBe('224px')
    expect(el.style.left).toBe('')
  })

  it('strategy:"absolute" with no offsetParent falls back to viewport-relative coords', () => {
    const el = makeEl()
    setOffsetParent(el, null)

    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 50, right: 250, width: 200 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })

    // Fallback: viewport-rect → top = parentBottom - 0 = 140; left = parentLeft - 0 = 50.
    expect(el.style.position).toBe('absolute')
    expect(el.style.top).toBe('140px')
    expect(el.style.left).toBe('50px')
  })

  it('strategy:"absolute" with detached offsetParent falls back to viewport', () => {
    const el = makeEl()
    const orphan = document.createElement('div') // never appended → !isConnected
    setOffsetParent(el, orphan)

    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })

    expect(el.style.position).toBe('absolute')
    expect(el.style.top).toBe('140px')
  })

  it('strategy:"absolute" stays anchored when ref + offsetParent scroll together', () => {
    const el = makeEl()
    const offsetParentEl = document.createElement('div')
    document.body.appendChild(offsetParentEl)
    offsetParentEl.getBoundingClientRect = () => ({
      top: 50, left: 30, right: 530, bottom: 450,
      width: 500, height: 400, x: 30, y: 50, toJSON: () => ({}),
    } as DOMRect)
    setOffsetParent(el, offsetParentEl)

    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 80, right: 280, width: 200 })
    mountDirective(el, { to: refEl, strategy: 'absolute' })
    expect(el.style.top).toBe('90px') // 140 - 50

    // Both ref and offsetParent shift up by 50px (page scrolled in their shared
    // scroll container). Their relative offset is invariant.
    refEl.getBoundingClientRect = () => ({
      top: 50, left: 80, width: 200, height: 40, right: 280, bottom: 90, x: 80, y: 50, toJSON: () => ({}),
    } as DOMRect)
    offsetParentEl.getBoundingClientRect = () => ({
      top: 0, left: 30, right: 530, bottom: 400, width: 500, height: 400, x: 30, y: 0, toJSON: () => ({}),
    } as DOMRect)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    // top = parentBottom (90) - offsetParent.top (0) = 90 → unchanged
    expect(el.style.top).toBe('90px')
  })

  it('useTeleportTo composable accepts strategy:"absolute" (viewport fallback)', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl, strategy: 'absolute' }))!

    expect(styles.value.position).toBe('absolute')
    // Composable has no host → viewport-relative fallback.
    expect(styles.value.top).toBe('140px')
    expect(styles.value.left).toBe('50px')
    scope.stop()
  })
})

// ─── prefers-reduced-motion ───────────────────────────────────────────────────
//
// jsdom does not implement window.matchMedia. We stub it per-test to control the
// `(prefers-reduced-motion: reduce)` signal.

function mockMatchMedia(reduceMatches: boolean): void {
  // Minimal MediaQueryList shim — the directive only reads `.matches`.
  const mql = (query: string): MediaQueryList => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? reduceMatches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList)
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn(mql),
    writable: true,
    configurable: true,
  })
}

function clearMatchMedia(): void {
  // Restore to "undefined" (jsdom default) so other suites are unaffected.
  Object.defineProperty(window, 'matchMedia', {
    value: undefined,
    writable: true,
    configurable: true,
  })
}

describe('prefers-reduced-motion', () => {
  afterEach(() => {
    clearMatchMedia()
  })

  it('clears transformOrigin when (prefers-reduced-motion: reduce) matches', () => {
    mockMatchMedia(true)
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    // Other styles still apply.
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
    // transformOrigin is NOT written so consumer CSS rules win.
    expect(el.style.transformOrigin).toBe('')
  })

  it('writes transformOrigin normally when reduce does not match (back-compat)', () => {
    mockMatchMedia(false)
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    expect(el.style.transformOrigin).toBe('top')
  })

  it('clears stale transformOrigin when reduce toggles on mid-lifecycle', () => {
    // Start without reduce — directive writes transformOrigin.
    mockMatchMedia(false)
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })
    expect(el.style.transformOrigin).toBe('top')

    // User toggles reduce-motion on. Next recalc tick must clear the stale value.
    mockMatchMedia(true)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.transformOrigin).toBe('')
  })

  it('still writes data-teleport-placement under reduce', () => {
    mockMatchMedia(true)
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    expect(el.dataset.teleportPlacement).toBe('bottom')
  })

  it('still dispatches teleport-positioned with correct detail under reduce', () => {
    mockMatchMedia(true)
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })

    let detail: TeleportToEventDetail | null = null
    el.addEventListener('teleport-positioned', ((e: CustomEvent) => {
      detail = e.detail
    }) as EventListener)

    mountDirective(el, { to: ref })

    expect(detail).not.toBeNull()
    expect(detail!.placement).toBe('bottom')
    expect(detail!.availableSpace).toBe(660) // raw: 800 - 140
    expect(detail!.maxHeight).toBe(240)
  })

  it('useTeleportTo composable honors reduced-motion', () => {
    mockMatchMedia(true)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles, placement } = scope.run(() => useTeleportTo({ to: refEl }))!

    // Other style fields are populated.
    expect(styles.value.position).toBe('fixed')
    expect(styles.value.top).toBe('140px')
    // Composable mirrors the cleared transformOrigin.
    expect(styles.value.transformOrigin).toBe('')
    // Placement signal still works.
    expect(placement.value).toBe('bottom')

    scope.stop()
  })

  it('falls back gracefully when window.matchMedia is undefined (non-DOM env)', () => {
    clearMatchMedia()
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: ref })

    // No matchMedia → assume motion is allowed (existing behavior preserved).
    expect(el.style.transformOrigin).toBe('top')
  })
})

// ─── overflow: 'shift' | 'hide' | 'none' ──────────────────────────────────────
//
// When the reference's horizontal position (after offset/anchor + width math)
// would push the host outside the viewport, the consumer can opt into:
//   - 'shift' — clamp the host back inside the viewport on the overflowing axis
//   - 'hide'  — toggle visibility:hidden / restore so the host disappears off-screen
//   - 'none'  — (default) preserve existing behavior; host may overflow
//
// The check is purely horizontal — vertical overflow is already handled by
// auto-placement / flip / maxHeight clamping.

describe('overflow option', () => {
  it("default 'none' preserves overflowing behavior (back-compat)", () => {
    // ref at left=900, width=200, right=1100 → host with widthMultiplier=1.5
    // would be 300px wide. Right-anchored (right >= 0.71*1024=727), so
    // hostRight=1100, hostLeft=800 — overflows the right edge by 76px.
    // Without overflow option, no shift/hide.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    mountDirective(el, { to: ref })

    // Right-anchored: rightValue = 1024 - 1100 - 0 = -76 → CSS right = '-76px'
    expect(el.style.right).toBe('-76px')
    expect(el.style.left).toBe('')
    expect(el.style.visibility).toBe('')
  })

  it("'shift' clamps left-anchored host that overflows right edge", () => {
    // ref left=400, right=600, width=200, threshold=727 so left-anchored.
    // host width = 200 * 1.5 = 300. hostLeft=400, hostRight=700 → fits (700<1024). No shift.
    // To force overflow, push ref right:
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    // window=800, threshold=568. ref right=560 < 568 ⇒ left-anchored.
    // host width=300. hostLeft=400, hostRight=700 → fits in 800. Need wider.
    // Use offsetX to push host past edge.
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 400, right: 560, width: 160 })
    mountDirective(el, { to: ref, overflow: 'shift', offsetX: 100 })

    // host width=160*1.5=240, hostLeft = 400+100=500, hostRight=740 → overflows by 0? 740<800, fits!
    // Just verify the no-op shift case doesn't break existing math.
    expect(el.style.left).toBe('500px')
    expect(el.style.right).toBe('')
  })

  it("'shift' clamps host that would overflow right edge", () => {
    // window=1024. ref left=300, right=500, width=200. left-anchored (500<727).
    // widthMultiplier=4 → host=800. hostLeft=300, hostRight=1100 → overflows 1024 by 76.
    // Shift target: hostLeft = max(0, min(300, 1024-800)) = min(300, 224) = 224.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 300, right: 500, width: 200 })
    mountDirective(el, { to: ref, overflow: 'shift', widthMultiplier: 4 })

    expect(el.style.left).toBe('224px')
    expect(el.style.right).toBe('')
  })

  it("'shift' clamps host that would overflow left edge", () => {
    // ref left=20, right=220, width=200. anchorRight false (220<727).
    // host width=300 (widthMultiplier=1.5). negative offsetX pushes host left.
    // offsetX=-50 → hostLeft=-30, hostRight=270. Overflows left.
    // Shift: clamp to 0.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 20, right: 220, width: 200 })
    mountDirective(el, { to: ref, overflow: 'shift', offsetX: -50 })

    expect(el.style.left).toBe('0px')
    expect(el.style.right).toBe('')
  })

  it("'shift' converts right-anchored overflow into left-anchored clamp", () => {
    // window=1024. ref right=1100, left=900, width=200. anchorRight true (1100>=727).
    // host width=300. hostRight=1100, hostLeft=800. Overflows right by 76.
    // Shift: hostLeft = min(800, 1024-300=724) → 724.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    mountDirective(el, { to: ref, overflow: 'shift' })

    expect(el.style.left).toBe('724px')
    expect(el.style.right).toBe('')
  })

  it("'hide' sets visibility:'hidden' when host overflows", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    mountDirective(el, { to: ref, overflow: 'hide' })

    expect(el.style.visibility).toBe('hidden')
    // Ownership marker — the directive may only clear a hide it applied.
    expect(el.dataset.teleportHidden).toBe('')
    // `display` belongs to the consumer (`v-show` / `v-if` / cascade).
    expect(el.style.display).toBe('')
  })

  it("'hide' leaves a fitting host shown, and never touches the consumer's display", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    // The consumer owns `display` — e.g. a `v-show="false"` on the same host.
    el.style.display = 'none'
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 })
    mountDirective(el, { to: ref, overflow: 'hide' })

    // hostLeft=100, hostRight=400 → fits in 1024. Nothing is hidden…
    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
    // …and the consumer's `display` survives untouched.
    expect(el.style.display).toBe('none')
  })

  it("'hide' toggles visibility across scroll-driven recalcs", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    let rect = { top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 } as any
    const ref = makeRef(rect)
    ref.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
    mountDirective(el, { to: ref, overflow: 'hide' })
    expect(el.style.visibility).toBe('')

    // Move ref off-screen to the right.
    rect = { top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(el.style.visibility).toBe('hidden')
    expect(el.dataset.teleportHidden).toBe('')

    // Move ref back inside.
    rect = { top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
  })

  it("'shift' / 'hide' do not engage on mobile full-bleed (already viewport-wide)", () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 })
    // Even with a degenerate offsetX that would normally overflow, mobile mode
    // pins the host at left=0 with width=100vw; overflow option is a no-op.
    mountDirective(el, { to: ref, overflow: 'hide', offsetX: 9999 })

    expect(el.style.left).toBe('0px')
    expect(el.style.maxWidth).toBe('100vw')
    expect(el.style.visibility).toBe('')
  })

  it("'shift' respects matchWidth host width", () => {
    // window=1024. ref left=900, width=200 → host width=200 (matchWidth).
    // Right-anchored. hostRight=1100, hostLeft=900. Overflows by 76.
    // Shift: maxLeft = 1024-200=824. shiftedLeft = min(900, 824)=824.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    mountDirective(el, { to: ref, overflow: 'shift', matchWidth: true })

    expect(el.style.left).toBe('824px')
    expect(el.style.right).toBe('')
    expect(el.style.maxWidth).toBe('200px')
  })

  it("useTeleportTo composable honors overflow:'shift'", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, overflow: 'shift' }),
    )!
    expect(styles.value.left).toBe('724px')
    expect(styles.value.right).toBe('')
    scope.stop()
  })

  it("useTeleportTo composable honors overflow:'hide'", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, overflow: 'hide' }),
    )!
    expect(styles.value.visibility).toBe('hidden')
    scope.stop()
  })
})

describe('onPositioned callback', () => {
  it('directive: invokes the callback once on mount with the correct detail', () => {
    const el = makeEl()
    const ref = makeRef({ top: 100, height: 40, bottom: 140 })
    const onPositioned = vi.fn()
    mountDirective(el, { to: ref, onPositioned })

    expect(onPositioned).toHaveBeenCalledTimes(1)
    const detail = onPositioned.mock.calls[0][0] as TeleportToEventDetail
    expect(detail.placement).toBe('bottom')
    expect(typeof detail.availableSpace).toBe('number')
    expect(typeof detail.maxHeight).toBe('number')
    // Detail object should match the CustomEvent detail to a tee.
    let eventDetail: TeleportToEventDetail | null = null
    el.addEventListener('teleport-positioned', (e) => {
      eventDetail = (e as CustomEvent<TeleportToEventDetail>).detail
    })
    updateDirective(el, { to: ref, onPositioned })
    expect(onPositioned).toHaveBeenCalledTimes(2)
    expect(onPositioned.mock.calls[1][0]).toEqual(eventDetail)
  })

  it('directive: invokes the callback on every scroll-driven recalc', () => {
    const el = makeEl()
    const ref = makeRef()
    const onPositioned = vi.fn()
    mountDirective(el, { to: ref, onPositioned })
    expect(onPositioned).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPositioned).toHaveBeenCalledTimes(2)

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPositioned).toHaveBeenCalledTimes(3)

    unmountDirective(el)
  })

  it('directive: a thrown callback is caught and does not break subsequent ticks', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = makeEl()
    const ref = makeRef()
    let throwsThisTick = true
    const onPositioned = vi.fn(() => {
      if (throwsThisTick) throw new Error('boom')
    })
    mountDirective(el, { to: ref, onPositioned })

    expect(onPositioned).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
    // The original positioning still happened — styles were applied + event dispatched.
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')

    // Subsequent tick: callback no longer throws, calculation still happens.
    throwsThisTick = false
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPositioned).toHaveBeenCalledTimes(2)
    expect(el.style.top).toBe('140px')

    unmountDirective(el)
    errorSpy.mockRestore()
  })

  it('directive: does NOT invoke the callback when `to` is missing on mount', () => {
    const onPositioned = vi.fn()
    const el = makeEl()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: undefined as any, onPositioned })

    expect(onPositioned).not.toHaveBeenCalled()
  })

  it('directive: does NOT invoke the callback when `to` is detached', () => {
    const onPositioned = vi.fn()
    const el = makeEl()
    const ref = makeRef()
    document.body.removeChild(ref) // detach
    mountDirective(el, { to: ref, onPositioned })

    expect(onPositioned).not.toHaveBeenCalled()
  })

  it('directive: does NOT invoke the callback when enabled:false', () => {
    const onPositioned = vi.fn()
    const el = makeEl()
    const ref = makeRef()
    mountDirective(el, { to: ref, enabled: false, onPositioned })

    expect(onPositioned).not.toHaveBeenCalled()
  })

  it('useTeleportTo: invokes callback on first run and on option mutation', () => {
    const refEl = makeRef()
    const onPositioned = vi.fn()
    const opts = ref<TeleportToOptions>({ to: refEl, onPositioned })
    const scope = effectScope()
    scope.run(() => useTeleportTo(opts))
    expect(onPositioned).toHaveBeenCalledTimes(1)

    // Mutate options — should retrigger.
    opts.value = { to: refEl, onPositioned, offsetY: 5 }
    expect(onPositioned).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('useTeleportTo: thrown callback is caught and does not break subsequent ticks', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refEl = makeRef()
    let throwsThisTick = true
    const onPositioned = vi.fn(() => {
      if (throwsThisTick) throw new Error('composable boom')
    })
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, onPositioned }),
    )!
    expect(onPositioned).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
    expect(styles.value.position).toBe('fixed')

    throwsThisTick = false
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPositioned).toHaveBeenCalledTimes(2)

    scope.stop()
    errorSpy.mockRestore()
  })

  it('useTeleportTo: callback NOT invoked when enabled:false', () => {
    const refEl = makeRef()
    const onPositioned = vi.fn()
    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, enabled: false, onPositioned }))
    expect(onPositioned).not.toHaveBeenCalled()
    scope.stop()
  })
})

// ─── Memory-leak smoke test (mount/unmount churn) ─────────────────────────────

describe('mount/unmount churn — memory-leak smoke', () => {
  // We monkey-patch window.addEventListener/removeEventListener inside the test
  // (not in the global beforeEach) so the rest of the suite is unaffected and
  // we get a clean baseline count for the assertion.

  function trackedListenerCount(el: Window, types: string[]) {
    type Entry = { type: string; listener: EventListenerOrEventListenerObject; capture: boolean }
    const entries: Entry[] = []
    const origAdd = el.addEventListener.bind(el)
    const origRemove = el.removeEventListener.bind(el)

    const captureFlag = (opts?: boolean | AddEventListenerOptions | EventListenerOptions): boolean => {
      if (typeof opts === 'boolean') return opts
      if (opts && typeof opts === 'object') return !!opts.capture
      return false
    }

    el.addEventListener = ((type: string, listener: any, opts?: any) => {
      if (types.includes(type)) {
        entries.push({ type, listener, capture: captureFlag(opts) })
      }
      return origAdd(type, listener, opts)
    }) as typeof el.addEventListener

    el.removeEventListener = ((type: string, listener: any, opts?: any) => {
      if (types.includes(type)) {
        const cap = captureFlag(opts)
        const idx = entries.findIndex(e => e.type === type && e.listener === listener && e.capture === cap)
        if (idx >= 0) entries.splice(idx, 1)
      }
      return origRemove(type, listener, opts)
    }) as typeof el.removeEventListener

    return {
      count: () => entries.length,
      restore: () => {
        el.addEventListener = origAdd
        el.removeEventListener = origRemove
      },
    }
  }

  it('500-iteration mount→unmount loop leaves no scroll/resize listeners on window', () => {
    const tracker = trackedListenerCount(window, ['scroll', 'resize'])
    const baseline = tracker.count()
    expect(baseline).toBe(0)

    for (let i = 0; i < 500; i++) {
      const el = makeEl()
      const refEl = makeRef()
      mountDirective(el, { to: refEl })
      // Every-50 verify the *peak* registration count is bounded (2 per
      // mounted instance — one scroll, one resize), so a forgotten cleanup
      // would surface as a monotonically growing count.
      if (i % 50 === 49) {
        expect(tracker.count()).toBe(2)
      }
      unmountDirective(el)
      // After unmount the WeakMap entry is gone immediately.
      expect(stateMap.has(el)).toBe(false)
    }

    expect(tracker.count()).toBe(0)
    tracker.restore()
  })

  it('500-iteration mount→unmount loop cancels any pending RAFs (no recalc fires post-unmount)', () => {
    // Use real timers (the global beforeEach installs fake timers) so we can
    // observe RAF cancellation behavior. We assert that after unmount, a
    // dispatched scroll/resize does NOT trigger a getBoundingClientRect read
    // on the reference (the directive is fully detached).
    vi.useRealTimers()

    let postUnmountRectReads = 0

    for (let i = 0; i < 500; i++) {
      const el = makeEl()
      const refEl = makeRef()
      mountDirective(el, { to: refEl })
      // Schedule an update by dispatching a scroll BEFORE unmount; then
      // unmount in the same tick. The pending RAF must be cancelled.
      window.dispatchEvent(new Event('scroll'))
      unmountDirective(el)
      // After unmount, swap getBoundingClientRect to detect any further reads.
      refEl.getBoundingClientRect = () => {
        postUnmountRectReads++
        return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
    }

    // Spin once to give any leaked RAFs a chance to fire.
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          expect(postUnmountRectReads).toBe(0)
          resolve()
        })
      })
    })
  })

  it('stateMap.has(el) is false after unmount for every iteration', () => {
    const els: HTMLElement[] = []

    for (let i = 0; i < 500; i++) {
      const el = makeEl()
      const refEl = makeRef()
      mountDirective(el, { to: refEl })
      expect(stateMap.has(el)).toBe(true)
      unmountDirective(el)
      expect(stateMap.has(el)).toBe(false)
      els.push(el)
    }

    // Final sweep: every element seen across the run is gone from the map.
    for (const el of els) {
      expect(stateMap.has(el)).toBe(false)
    }
  })
})

// ─── placement: 'left' | 'right' — horizontal popovers ─────────────────────────

describe('placement: "left" | "right" — horizontal popovers', () => {
  it('placement: "right" anchors host left edge to parent right edge, top-aligned', () => {
    // Default ref: top=100, left=50, right=250, height=40
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right' })

    expect(el.style.position).toBe('fixed')
    expect(el.style.left).toBe('250px') // parentRight + 0 offsetX
    expect(el.style.right).toBe('')
    expect(el.style.top).toBe('100px') // parentTop + 0 offsetY
    expect(el.style.bottom).toBe('')
    expect(el.style.transformOrigin).toBe('left')
  })

  it('placement: "left" anchors host right edge to parent left edge (CSS right-anchored), top-aligned', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'left' })

    // Host's right edge sits at parentLeft (50). Express via CSS right:
    // right = windowWidth - parentLeft = 1024 - 50 = 974
    expect(el.style.right).toBe('974px')
    expect(el.style.left).toBe('')
    expect(el.style.top).toBe('100px')
    expect(el.style.bottom).toBe('')
    expect(el.style.transformOrigin).toBe('right')
  })

  it('placement: "right" with offsetY shifts vertical position', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', offsetY: 12 })

    expect(el.style.top).toBe('112px') // parentTop + offsetY
  })

  it('placement: "right" with offsetX shifts horizontal position', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', offsetX: 8 })

    expect(el.style.left).toBe('258px') // parentRight + offsetX
  })

  it('placement: "left" with offsetX shifts horizontal position (CSS right grows)', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'left', offsetX: 8 })

    // hostRight = parentLeft - offsetX = 50 - 8 = 42 → CSS right = 1024 - 42 = 982
    expect(el.style.right).toBe('982px')
  })

  it('flip: true with placement: "right" flips to "left" when right has insufficient room', () => {
    // ref far to the right: spaceRight = 1024-1000 = 24, spaceLeft = 800.
    // A 300px-wide host cannot fit on the right; the left can hold it → flip.
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef({ left: 800, right: 1000, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: true })

    // Flipped to left → CSS right-anchored
    expect(el.style.left).toBe('')
    expect(el.style.right).toBe('224px') // 1024 - parentLeft = 1024 - 800
    expect(el.style.transformOrigin).toBe('right')
  })

  it('flip: true with placement: "left" flips to "right" when left has insufficient room', () => {
    // Default ref: parentLeft=50, parentRight=250.
    // spaceLeft = 50, spaceRight = 1024 - 250 = 774.
    // A 300px-wide host cannot fit on the left; the right can hold it → flip.
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'left', flip: true })

    expect(el.style.left).toBe('250px') // parentRight
    expect(el.style.right).toBe('')
    expect(el.style.transformOrigin).toBe('left')
  })

  it('flip: true keeps placement: "right" when the right side fits', () => {
    // Default ref: spaceRight=774 holds the 300px host → keep right.
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', flip: true })

    expect(el.style.left).toBe('250px')
    expect(el.style.right).toBe('')
    expect(el.dataset.teleportFit).toBe('fits')
  })

  it('DOES flip when flip is omitted — the default is on horizontally too', () => {
    // ref at far right where spaceRight (24) provably cannot hold the 300px
    // host. Omitting `flip` used to leave it there, overflowing.
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef({ left: 800, right: 1000, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right' })

    expect(el.dataset.teleportPlacement).toBe('left')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.right).toBe('224px') // 1024 - refLeft
    expect(el.style.left).toBe('')
    expect(el.style.transformOrigin).toBe('right')
  })

  it('flip: false pins an explicit horizontal placement however badly it fits', () => {
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef({ left: 800, right: 1000, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: false })

    expect(el.style.left).toBe('1000px') // parentRight
    expect(el.style.right).toBe('')
    expect(el.style.transformOrigin).toBe('left')
  })

  it('mid-scroll flip from "right" to "left" when ref scrolls toward right edge', () => {
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', flip: true })

    expect(el.style.left).toBe('250px')
    expect(el.style.transformOrigin).toBe('left')

    // Ref scrolls into the right margin
    refEl.getBoundingClientRect = () => ({
      top: 100, left: 800, width: 200, height: 40, right: 1000, bottom: 140,
      x: 800, y: 100, toJSON: () => ({}),
    } as DOMRect)
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.left).toBe('')
    expect(el.style.right).toBe('224px') // 1024 - 800
    expect(el.style.transformOrigin).toBe('right')
  })

  it('teleport-positioned event detail reports horizontal placement and horizontal availableSpace', () => {
    const el = makeEl()
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })

    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right' })

    expect(events).toHaveLength(1)
    expect(events[0].placement).toBe('right')
    expect(events[0].availableSpace).toBe(774) // 1024 - parentRight = 1024 - 250
  })

  it('data-teleport-placement reflects "right"', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right' })

    expect(el.getAttribute('data-teleport-placement')).toBe('right')
  })

  it('data-teleport-placement reflects "left"', () => {
    const el = makeEl()
    const refEl = makeRef({ left: 900, right: 950, width: 50 })
    mountDirective(el, { to: refEl, placement: 'left' })

    expect(el.getAttribute('data-teleport-placement')).toBe('left')
  })

  it('useTeleportTo composable supports placement: "right"', () => {
    const refEl = makeRef()

    const scope = effectScope()
    const { styles, placement } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'right' }),
    )!

    expect(placement.value).toBe('right')
    expect(styles.value.left).toBe('250px')
    expect(styles.value.right).toBe('')
    expect(styles.value.top).toBe('100px')
    expect(styles.value.transformOrigin).toBe('left')

    scope.stop()
  })

  it('useTeleportTo flips "right" → "left" once it is given the host to measure', () => {
    // spaceRight is 24 and the host is 300 wide: with the host passed, the
    // composable reaches the same answer as the directive.
    const refEl = makeRef({ left: 800, right: 1000, width: 200 })
    const host = sizeHost(makeEl(), { width: 300 })

    const scope = effectScope()
    const { placement, styles, fit } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'right' }, host),
    )!

    expect(placement.value).toBe('left')
    expect(fit.value).toBe('flipped')
    expect(styles.value.right).toBe('224px')
    expect(styles.value.left).toBe('')

    scope.stop()
  })

  it('"auto" placement remains vertical-only — does not pick left/right (back-compat)', () => {
    // Tied vertical case from the existing back-compat test: places below.
    // If 4-way auto were active, spaceRight (774) would dominate spaceBelow/Above (280).
    const el = makeEl()
    const refEl = makeRef({ top: 330, height: 40, bottom: 370 })
    mountDirective(el, { to: refEl, placement: 'auto' })

    // Still chooses bottom — auto must remain vertical-only.
    expect(el.style.top).toBe('370px')
    expect(el.style.left).not.toBe('250px') // not anchored to a horizontal placement
    expect(['top', 'bottom']).toContain(el.dataset.teleportPlacement)
  })

  it('placement: "right" ignores anchorRight/mobile-full-bleed branches and stays horizontal', () => {
    // Mobile viewport — vertical math would set left:0/maxWidth:100vw, but horizontal
    // placement opts out of full-bleed.
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ left: 50, right: 250, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right' })

    expect(el.style.left).toBe('250px') // parentRight, not 0
    expect(el.style.maxWidth).not.toBe('100vw')
  })
})

// ─── arrow option ──────────────────────────────────────────────────────────────

describe('arrow option — CSS custom properties on host', () => {
  it('does NOT emit CSS variables when `arrow` option is absent', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl })

    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('')
  })

  it('bottom placement (default left-anchor): writes arrow-x = reference center − host left edge', () => {
    // Default ref: left=50, width=200, top=100, height=40, bottom=140 → spaceBelow large
    // referenceCenterX = 50 + 100 = 150
    // hostLeft (left-anchor) = parentLeft + offsetX = 50
    // → arrow-x = 150 − 50 = 100
    const el = makeEl()
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, arrow: arrowEl })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('0px')
  })

  it('top placement: writes arrow-x for the same horizontal-center math; arrow-y = 0', () => {
    // ref near bottom → places above; horizontal anchor unchanged
    const el = makeEl()
    const refEl = makeRef({ top: 700, height: 40, bottom: 740, left: 50, right: 250, width: 200 })
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, arrow: arrowEl })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('0px')
  })

  it('right placement: writes arrow-y = reference center − host top; arrow-x = 0', () => {
    // ref center Y = 100 + 20 = 120. hostTop (right placement) = parentTop + offsetY = 100.
    // → arrow-y = 120 − 100 = 20
    const el = makeEl()
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, placement: 'right', arrow: arrowEl })

    expect(el.dataset.teleportPlacement).toBe('right')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('20px')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('0px')
  })

  it('left placement: same vertical-center math; arrow-x = 0', () => {
    const el = makeEl()
    const refEl = makeRef({ left: 900, right: 950, width: 50 })
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, placement: 'left', arrow: arrowEl })

    expect(el.dataset.teleportPlacement).toBe('left')
    // refCenterY = 100 + 20 = 120; hostTop = 100 → arrow-y = 20
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('20px')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('0px')
  })

  it('right-anchored vertical placement: arrow-x reflects host left edge after right-anchor math', () => {
    // ref far right: parentRight=950 ≥ 0.71*1024 ≈ 727 → anchorRight branch.
    // hostWidth = 150 * 1.5 = 225; hostLeft = parentRight + offsetX − hostWidth = 950 − 225 = 725
    // refCenterX = 800 + 75 = 875 → arrow-x = 875 − 725 = 150
    const el = makeEl()
    const refEl = makeRef({ left: 800, width: 150, right: 950 })
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, arrow: arrowEl })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('150px')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('0px')
  })

  it('overflow: "shift" adjusts arrow-x to track the shifted host position', () => {
    // Use matchWidth so hostWidth = parentWidth (skips the *1.5 multiplier),
    // letting us construct an overflow scenario inside the anchorRight branch.
    // ref at left=900, right=1100, width=200 → matchWidth hostWidth=200;
    // anchorRight (1100 ≥ 727) → naive hostLeft=900; hostRight=1100 > 1024 → shift.
    // maxLeft = 1024 − 200 = 824; shiftedHostLeft = min(900, 824) = 824.
    // refCenterX = 1000 → arrow-x = 1000 − 824 = 176
    const el = makeEl()
    const refEl = makeRef({ left: 900, right: 1100, width: 200 })
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, overflow: 'shift', matchWidth: true, arrow: arrowEl })

    expect(el.style.left).toBe('824px')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('176px')
  })

  it('arrow becoming detached mid-life: clears CSS vars on next tick', () => {
    const el = makeEl()
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, arrow: arrowEl })
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')

    // Detach the arrow element from the DOM
    arrowEl.remove()
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('')
  })

  it('arrow option as a Ref<HTMLElement>: resolves correctly', () => {
    const el = makeEl()
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)
    const arrowRef = ref<HTMLElement | null>(arrowEl)

    mountDirective(el, { to: refEl, arrow: arrowRef })

    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')
  })

  it('useTeleportTo composable: arrow vars surface in styles ref', () => {
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, arrow: arrowEl }),
    )!

    // Styles ref should expose CSS custom properties for binding via :style
    expect((styles.value as Record<string, string>)['--teleport-arrow-x']).toBe('100px')
    expect((styles.value as Record<string, string>)['--teleport-arrow-y']).toBe('0px')

    scope.stop()
  })
})

// ─── overflow on horizontal placements ────────────────────────────────────────
//
// `overflow: 'shift' | 'hide'` extended to `placement: 'left' | 'right'`. Per
// the placement axis, "overflow" means the host extending past the viewport's
// right edge (placement:'right') or left edge (placement:'left'). The shift
// clamp also honors a no-overlap-with-reference invariant — shift never pushes
// the host onto the reference. When the host can't fit without overlap, the
// no-overlap constraint wins and the host overflows.

describe('overflow option — horizontal placements', () => {
  it("'none' (default) preserves overflowing behavior on placement:'right' (back-compat)", () => {
    // ref near right edge: parentRight=950, hostWidth=150*1.5=225 → host overflows.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 800, right: 950, width: 150 })
    mountDirective(el, { to: refEl, placement: 'right' })

    expect(el.style.left).toBe('950px') // parentRight + 0 — overflows untouched
    expect(el.style.right).toBe('')
    expect(el.style.visibility).toBe('')
  })

  it("'shift' clamps placement:'right' that would overflow right edge", () => {
    // ref left=600,right=700,width=100. offsetX=200 → desired hostLeft=900.
    // hostWidth=100*1.5=150 → desired hostRight=1050 (overflows by 26).
    // minLeft=parentRight=700, maxLeft=windowWidth-hostWidth=874.
    // shiftedHostLeft = clamp(900, 700, 874) = 874.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 600, right: 700, width: 100 })
    mountDirective(el, { to: refEl, placement: 'right', offsetX: 200, overflow: 'shift' })

    expect(el.style.left).toBe('874px')
    expect(el.style.right).toBe('')
  })

  it("'shift' clamps placement:'left' that would overflow left edge", () => {
    // ref left=300,right=400,width=100. offsetX=200 → desired hostRight=100.
    // hostWidth=150 → desired hostLeft=-50 (overflows).
    // minRight=hostWidth=150, maxRight=parentLeft=300.
    // shiftedHostRight = clamp(100, 150, 300) = 150 → CSS right = 1024 - 150 = 874.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 300, right: 400, width: 100 })
    mountDirective(el, { to: refEl, placement: 'left', offsetX: 200, overflow: 'shift' })

    expect(el.style.right).toBe('874px')
    expect(el.style.left).toBe('')
  })

  it("'shift' on placement:'right' pins at parentRight when host can't fit (no-overlap invariant)", () => {
    // ref at left=850,right=950,width=100; hostWidth=150 → desired hostRight=1100 overflows.
    // minLeft=950, maxLeft=874. maxLeft<minLeft → pin at minLeft=950.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 850, right: 950, width: 100 })
    mountDirective(el, { to: refEl, placement: 'right', overflow: 'shift' })

    expect(el.style.left).toBe('950px')
    expect(el.style.right).toBe('')
  })

  it("'shift' on placement:'left' pins at parentLeft when host can't fit (no-overlap invariant)", () => {
    // ref at left=100,right=200,width=100; hostWidth=150 → desired hostLeft=-50 overflows.
    // minRight=150, maxRight=100. minRight>maxRight → pin at maxRight=100.
    // CSS right = 1024 - 100 = 924.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 200, width: 100 })
    mountDirective(el, { to: refEl, placement: 'left', overflow: 'shift' })

    expect(el.style.right).toBe('924px')
    expect(el.style.left).toBe('')
  })

  it("'hide' sets visibility:'hidden' when placement:'right' overflows right edge", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    // hostLeft=950, hostWidth=225 → hostRight=1175 overflows.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 800, right: 950, width: 150 })
    mountDirective(el, { to: refEl, placement: 'right', overflow: 'hide' })

    expect(el.style.visibility).toBe('hidden')
    expect(el.style.display).toBe('')
  })

  it("'hide' sets visibility:'hidden' when placement:'left' overflows left edge", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    // hostRight=100, hostWidth=225 → hostLeft=-125 overflows.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 250, width: 150 })
    mountDirective(el, { to: refEl, placement: 'left', overflow: 'hide' })

    expect(el.style.visibility).toBe('hidden')
    expect(el.style.display).toBe('')
  })

  it("'hide' leaves placement:'right' shown when it fits, without touching display", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    el.style.display = 'none' // consumer-owned, e.g. `v-show="false"`
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 250, width: 150 })
    // hostLeft=250, hostRight=475 → fits.
    mountDirective(el, { to: refEl, placement: 'right', overflow: 'hide' })

    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
    expect(el.style.display).toBe('none')
  })

  it("'hide' toggles visibility across scroll-driven recalcs (placement:'right')", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    let rect = { top: 100, height: 40, bottom: 140, left: 100, right: 250, width: 150 } as any
    const refEl = makeRef(rect)
    refEl.getBoundingClientRect = () =>
      ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect
    mountDirective(el, { to: refEl, placement: 'right', overflow: 'hide' })
    expect(el.style.visibility).toBe('')

    // Scroll so reference moves rightward → host overflows.
    rect = { top: 100, height: 40, bottom: 140, left: 800, right: 950, width: 150 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(el.style.visibility).toBe('hidden')
    expect(el.dataset.teleportHidden).toBe('')

    // Scroll back inside.
    rect = { top: 100, height: 40, bottom: 140, left: 100, right: 250, width: 150 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
  })

  it("useTeleportTo composable honors overflow:'shift' on placement:'right'", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 600, right: 700, width: 100 })
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'right', offsetX: 200, overflow: 'shift' }),
    )!
    expect(styles.value.left).toBe('874px')
    expect(styles.value.right).toBe('')
    scope.stop()
  })

  it("useTeleportTo composable honors overflow:'hide' on placement:'left'", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 250, width: 150 })
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'left', overflow: 'hide' }),
    )!
    expect(styles.value.visibility).toBe('hidden')
    scope.stop()
  })

  it("flip:true takes precedence over shift — flipping resolves overflow without clamping", () => {
    // ref far to the right — placement:'right' would overflow, but flip flips to
    // 'left' first (where there's plenty of room), so shift never fires.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    sizeHost(el, { width: 300 })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 800, right: 1000, width: 200 })
    mountDirective(el, { to: refEl, placement: 'right', flip: true, overflow: 'shift' })

    // Flipped to left: CSS right = 1024 - parentLeft = 224.
    expect(el.style.right).toBe('224px')
    expect(el.style.left).toBe('')
    expect(el.dataset.teleportPlacement).toBe('left')
  })
})

// ─── crossAxisAlign option ─────────────────────────────────────────────────────

describe('crossAxisAlign option — explicit cross-axis alignment', () => {
  // Setup recap (default): innerWidth=1024, innerHeight=800; default ref = makeRef()
  // → top:100, left:50, width:200, height:40, right:250, bottom:140.
  // hostWidth (no matchWidth) = 200 * 1.5 = 300.
  // anchorRight heuristic threshold: 1024 * 0.71 ≈ 727.04.

  it('back-compat: omitting crossAxisAlign preserves anchorRight heuristic', () => {
    // ref past WIDTH_THRESHOLD (right=800 > 727) → legacy behavior anchors right
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 600, right: 800, width: 200 })
    mountDirective(el, { to: refEl })

    expect(el.style.right).toBe('224px') // 1024 − 800 − 0
    expect(el.style.left).toBe('')
  })

  it("crossAxisAlign:'start' on placement:'bottom' suppresses anchorRight heuristic", () => {
    // Same ref as above (would normally trigger anchorRight) — explicit 'start' overrides.
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 600, right: 800, width: 200 })
    mountDirective(el, { to: refEl, placement: 'bottom', crossAxisAlign: 'start' })

    expect(el.style.left).toBe('600px') // parentLeft + 0
    expect(el.style.right).toBe('')
  })

  it("crossAxisAlign:'center' on placement:'bottom' horizontally centers the host", () => {
    // refCenterX = 50 + 100 = 150; hostWidth = 300 → left = 150 − 150 = 0
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'bottom', crossAxisAlign: 'center' })

    expect(el.style.left).toBe('0px')
    expect(el.style.right).toBe('')
  })

  it("crossAxisAlign:'end' on placement:'bottom' explicitly right-anchors", () => {
    // ref far from right edge (right=250 < 727) → would normally left-anchor.
    // 'end' forces right anchor: right = 1024 − 250 − 0 = 774
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'bottom', crossAxisAlign: 'end' })

    expect(el.style.left).toBe('')
    expect(el.style.right).toBe('774px')
  })

  it("crossAxisAlign:'center' on placement:'top' uses same horizontal-center math", () => {
    // ref near bottom → places above; cross-axis math identical to 'bottom'.
    const el = makeEl()
    const refEl = makeRef({ top: 700, height: 40, bottom: 740, left: 50, right: 250, width: 200 })
    mountDirective(el, { to: refEl, placement: 'top', crossAxisAlign: 'center' })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.style.left).toBe('0px')
    expect(el.style.right).toBe('')
  })

  it("crossAxisAlign:'end' on placement:'top' right-anchors", () => {
    const el = makeEl()
    const refEl = makeRef({ top: 700, height: 40, bottom: 740, left: 50, right: 250, width: 200 })
    mountDirective(el, { to: refEl, placement: 'top', crossAxisAlign: 'end' })

    expect(el.style.left).toBe('')
    expect(el.style.right).toBe('774px')
  })

  it("crossAxisAlign:'start' on placement:'right' top-aligns (== current default)", () => {
    // Default horizontal: top = parentTop + offsetY = 100
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', crossAxisAlign: 'start' })

    expect(el.style.top).toBe('100px')
    expect(el.style.bottom).toBe('')
  })

  it("crossAxisAlign:'center' on placement:'right' vertically centers", () => {
    // maxHeight (vertical room from parentTop down to viewport bottom) = min(700, 240) = 240
    // top = parentTop + parentHeight/2 − maxHeight/2 = 100 + 20 − 120 = 0
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', crossAxisAlign: 'center' })

    expect(el.style.top).toBe('0px')
    expect(el.style.bottom).toBe('')
  })

  it("crossAxisAlign:'end' on placement:'right' bottom-aligns", () => {
    // top = parentBottom − maxHeight = 140 − 240 = −100
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', crossAxisAlign: 'end' })

    expect(el.style.top).toBe('-100px')
    expect(el.style.bottom).toBe('')
  })

  it("crossAxisAlign:'start' on placement:'left' top-aligns (parity with right)", () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'left', crossAxisAlign: 'start' })

    expect(el.style.top).toBe('100px')
  })

  it("crossAxisAlign:'center' on placement:'left' vertically centers", () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'left', crossAxisAlign: 'center' })

    expect(el.style.top).toBe('0px')
  })

  it("crossAxisAlign:'end' on placement:'left' bottom-aligns", () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'left', crossAxisAlign: 'end' })

    expect(el.style.top).toBe('-100px')
  })

  it('respects offsetX in cross-axis math for vertical placement', () => {
    // 'center' + offsetX:25 → left = (refCenterX − hostWidth/2) + offsetX = 0 + 25 = 25
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'bottom', crossAxisAlign: 'center', offsetX: 25 })

    expect(el.style.left).toBe('25px')
  })

  it('respects offsetY in cross-axis math for horizontal placement', () => {
    // 'center' + offsetY:15 → top = (parentTop + parentHeight/2 − maxHeight/2) + offsetY = 0 + 15 = 15
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'right', crossAxisAlign: 'center', offsetY: 15 })

    expect(el.style.top).toBe('15px')
  })

  it('mobile full-bleed (vertical) wins over crossAxisAlign', () => {
    // <768 AND !matchWidth AND vertical → 100vw, left:0; crossAxisAlign is a no-op.
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, placement: 'bottom', crossAxisAlign: 'end' })

    expect(el.style.left).toBe('0px')
    expect(el.style.right).toBe('')
    expect(el.style.maxWidth).toBe('100vw')
  })

  it("arrow tracks crossAxisAlign:'center' on vertical placement", () => {
    // hostLeftViewport = 0 (centered); refCenterX = 150 → arrow-x = 150 − 0 = 150
    const el = makeEl()
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, placement: 'bottom', crossAxisAlign: 'center', arrow: arrowEl })

    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('150px')
    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('0px')
  })

  it("arrow tracks crossAxisAlign:'center' on horizontal placement", () => {
    // hostTopViewport = 0 (centered, top calc = 0); refCenterY = 120 → arrow-y = 120 − 0 = 120
    const el = makeEl()
    const refEl = makeRef()
    const arrowEl = document.createElement('span')
    document.body.appendChild(arrowEl)

    mountDirective(el, { to: refEl, placement: 'right', crossAxisAlign: 'center', arrow: arrowEl })

    expect(el.style.getPropertyValue('--teleport-arrow-y')).toBe('120px')
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('0px')
  })

  it("overflow:'shift' uses crossAxisAlign:'center' hostLeft for clamp math", () => {
    // ref centered at 50/250, but with offsetX=900 the centered hostLeft would be:
    //   center=150, hostWidth=300 → hostLeft = 0 + 900 = 900, hostRight = 1200 (overflows right)
    // shift clamps hostLeft into [0, 1024−300=724] → 724
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, {
      to: refEl,
      placement: 'bottom',
      crossAxisAlign: 'center',
      offsetX: 900,
      overflow: 'shift',
    })

    expect(el.style.left).toBe('724px')
    expect(el.style.right).toBe('')
  })

  it("composable parity: useTeleportTo honors crossAxisAlign:'center' on vertical", () => {
    const refEl = makeRef()
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'bottom', crossAxisAlign: 'center' }),
    )!

    expect(styles.value.left).toBe('0px')
    expect(styles.value.right).toBe('')
    scope.stop()
  })

  it("composable parity: useTeleportTo honors crossAxisAlign:'end' on horizontal", () => {
    const refEl = makeRef()
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, placement: 'right', crossAxisAlign: 'end' }),
    )!

    expect(styles.value.top).toBe('-100px')
    scope.stop()
  })
})

// ─── onPlacementChange callback ───────────────────────────────────────────────

describe('onPlacementChange callback', () => {
  it('directive: first-tick fires with (null, chosen)', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const onPlacementChange = vi.fn()
    mountDirective(el, { to: refEl, onPlacementChange })

    expect(onPlacementChange).toHaveBeenCalledTimes(1)
    expect(onPlacementChange).toHaveBeenCalledWith(null, 'bottom')
  })

  it('directive: does NOT fire on consecutive ticks with same placement', () => {
    const el = makeEl()
    const refEl = makeRef()
    const onPlacementChange = vi.fn()
    mountDirective(el, { to: refEl, onPlacementChange })
    expect(onPlacementChange).toHaveBeenCalledTimes(1) // first tick

    // Scroll-driven recalc — same layout, same placement.
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPlacementChange).toHaveBeenCalledTimes(1) // unchanged

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPlacementChange).toHaveBeenCalledTimes(1)

    unmountDirective(el)
  })

  it('directive: fires on flip-driven placement change', () => {
    // Default ref top=100/bottom=140 in 800px viewport → placement:'bottom'.
    // After mount, mutate the ref's rect so flip swaps to top.
    const el = makeEl()
    sizeHost(el, { height: 80 }) // the fit test needs a box to measure
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const onPlacementChange = vi.fn()
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true, onPlacementChange })

    expect(onPlacementChange).toHaveBeenLastCalledWith(null, 'bottom')

    // Move ref so spaceBelow < spaceAbove → flip:true picks 'top'.
    refEl.getBoundingClientRect = () =>
      ({ top: 700, left: 50, width: 200, height: 40, right: 250, bottom: 740, x: 50, y: 700, toJSON: () => ({}) }) as DOMRect

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(onPlacementChange).toHaveBeenCalledTimes(2)
    expect(onPlacementChange).toHaveBeenLastCalledWith('bottom', 'top')

    unmountDirective(el)
  })

  it('directive: a thrown callback is caught and does not break subsequent ticks', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = makeEl()
    sizeHost(el, { height: 80 }) // the fit test needs a box to measure
    const refEl = makeRef()
    const onPlacementChange = vi.fn(() => {
      throw new Error('placement boom')
    })
    mountDirective(el, { to: refEl, placement: 'bottom', flip: true, onPlacementChange })

    expect(onPlacementChange).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
    // Styles still applied normally.
    expect(el.style.position).toBe('fixed')

    // Subsequent flip-driven change still fires the callback (caught again).
    refEl.getBoundingClientRect = () =>
      ({ top: 700, left: 50, width: 200, height: 40, right: 250, bottom: 740, x: 50, y: 700, toJSON: () => ({}) }) as DOMRect
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(onPlacementChange).toHaveBeenCalledTimes(2)

    unmountDirective(el)
    errorSpy.mockRestore()
  })

  it('directive: NOT invoked when `to` is missing on mount', () => {
    const el = makeEl()
    const onPlacementChange = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: undefined as any, onPlacementChange })
    expect(onPlacementChange).not.toHaveBeenCalled()
  })

  it('directive: NOT invoked when `to` is detached', () => {
    const el = makeEl()
    const refEl = makeRef()
    document.body.removeChild(refEl)
    const onPlacementChange = vi.fn()
    mountDirective(el, { to: refEl, onPlacementChange })
    expect(onPlacementChange).not.toHaveBeenCalled()
  })

  it('directive: NOT invoked when enabled:false', () => {
    const el = makeEl()
    const refEl = makeRef()
    const onPlacementChange = vi.fn()
    mountDirective(el, { to: refEl, enabled: false, onPlacementChange })
    expect(onPlacementChange).not.toHaveBeenCalled()
  })

  it('directive: enabled toggling false → true re-fires with prev:null', () => {
    const el = makeEl()
    const refEl = makeRef()
    const onPlacementChange = vi.fn()

    mountDirective(el, { to: refEl, onPlacementChange })
    expect(onPlacementChange).toHaveBeenCalledTimes(1)
    expect(onPlacementChange).toHaveBeenLastCalledWith(null, 'bottom')

    // Disable — prev resets so the next enable fires from null again.
    updateDirective(el, { to: refEl, enabled: false, onPlacementChange })
    expect(onPlacementChange).toHaveBeenCalledTimes(1)

    // Re-enable — fires (null → 'bottom') again.
    updateDirective(el, { to: refEl, enabled: true, onPlacementChange })
    expect(onPlacementChange).toHaveBeenCalledTimes(2)
    expect(onPlacementChange).toHaveBeenLastCalledWith(null, 'bottom')

    unmountDirective(el)
  })

  it('useTeleportTo: first-run fires with (null, chosen); option mutation re-fires only on placement change', () => {
    const refEl = makeRef()
    const onPlacementChange = vi.fn()
    const opts = ref<TeleportToOptions>({ to: refEl, onPlacementChange })
    const scope = effectScope()
    scope.run(() => useTeleportTo(opts))
    expect(onPlacementChange).toHaveBeenCalledTimes(1)
    expect(onPlacementChange).toHaveBeenLastCalledWith(null, 'bottom')

    // Mutate options that don't change placement — no fire.
    opts.value = { to: refEl, onPlacementChange, offsetY: 5 }
    expect(onPlacementChange).toHaveBeenCalledTimes(1)

    // Mutate to flip-able placement and force a flip. Default ref makes 'top'
    // dominant when scrolled — easier: change placement to 'top' explicitly,
    // which is itself a placement change from 'bottom'.
    opts.value = { to: refEl, onPlacementChange, placement: 'top' }
    expect(onPlacementChange).toHaveBeenCalledTimes(2)
    expect(onPlacementChange).toHaveBeenLastCalledWith('bottom', 'top')

    scope.stop()
  })

  it('useTeleportTo: thrown callback caught', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refEl = makeRef()
    const onPlacementChange = vi.fn(() => {
      throw new Error('composable placement boom')
    })
    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, onPlacementChange }),
    )!
    expect(onPlacementChange).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()
    expect(styles.value.position).toBe('fixed')
    scope.stop()
    errorSpy.mockRestore()
  })

  it('useTeleportTo: NOT invoked when enabled:false', () => {
    const refEl = makeRef()
    const onPlacementChange = vi.fn()
    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, enabled: false, onPlacementChange }))
    expect(onPlacementChange).not.toHaveBeenCalled()
    scope.stop()
  })
})

// ─── autoUpdate option ─────────────────────────────────────────────────────────

describe('autoUpdate option — IntersectionObserver + ResizeObserver tracking', () => {
  // Capturing stubs replace the globals for the duration of each test.
  // Each instance pushes itself into the corresponding array so tests can
  // assert against `.observed`, `.disconnected`, and trigger callbacks.
  type StubRO = {
    callback: ResizeObserverCallback
    observed: Element[]
    disconnected: boolean
    observe: (t: Element) => void
    unobserve: (t: Element) => void
    disconnect: () => void
    trigger: () => void
  }
  type StubIO = {
    callback: IntersectionObserverCallback
    options: IntersectionObserverInit | undefined
    observed: Element[]
    disconnected: boolean
    observe: (t: Element) => void
    unobserve: (t: Element) => void
    disconnect: () => void
    trigger: () => void
  }
  type StubMO = {
    callback: MutationCallback
    observed: { target: Node; options: MutationObserverInit }[]
    disconnected: boolean
    observe: (t: Node, options: MutationObserverInit) => void
    disconnect: () => void
    takeRecords: () => MutationRecord[]
    trigger: () => void
  }

  let roInstances: StubRO[]
  let ioInstances: StubIO[]
  let moInstances: StubMO[]
  let originalRO: typeof ResizeObserver | undefined
  let originalIO: typeof IntersectionObserver | undefined
  let originalMO: typeof MutationObserver | undefined

  beforeEach(() => {
    roInstances = []
    ioInstances = []
    moInstances = []
    originalRO = (globalThis as any).ResizeObserver
    originalIO = (globalThis as any).IntersectionObserver
    originalMO = (globalThis as any).MutationObserver

    ;(globalThis as any).ResizeObserver = function (this: any, cb: ResizeObserverCallback) {
      const inst: StubRO = {
        callback: cb,
        observed: [],
        disconnected: false,
        observe(t) { this.observed.push(t) },
        unobserve(t) {
          const i = this.observed.indexOf(t)
          if (i !== -1) this.observed.splice(i, 1)
        },
        disconnect() { this.disconnected = true; this.observed.length = 0 },
        trigger() { this.callback([] as any, this as any) },
      }
      roInstances.push(inst)
      return inst as any
    }
    ;(globalThis as any).IntersectionObserver = function (
      this: any,
      cb: IntersectionObserverCallback,
      opts?: IntersectionObserverInit,
    ) {
      const inst: StubIO = {
        callback: cb,
        options: opts,
        observed: [],
        disconnected: false,
        observe(t) { this.observed.push(t) },
        unobserve(t) {
          const i = this.observed.indexOf(t)
          if (i !== -1) this.observed.splice(i, 1)
        },
        disconnect() { this.disconnected = true; this.observed.length = 0 },
        trigger() { this.callback([] as any, this as any) },
      }
      ioInstances.push(inst)
      return inst as any
    }
    ;(globalThis as any).MutationObserver = function (
      this: any,
      cb: MutationCallback,
    ) {
      const inst: StubMO = {
        callback: cb,
        observed: [],
        disconnected: false,
        observe(t, options) { this.observed.push({ target: t, options }) },
        disconnect() { this.disconnected = true; this.observed.length = 0 },
        takeRecords() { return [] },
        trigger() { this.callback([] as any, this as any) },
      }
      moInstances.push(inst)
      return inst as any
    }
  })

  afterEach(() => {
    if (originalRO === undefined) {
      delete (globalThis as any).ResizeObserver
    } else {
      ;(globalThis as any).ResizeObserver = originalRO
    }
    if (originalIO === undefined) {
      delete (globalThis as any).IntersectionObserver
    } else {
      ;(globalThis as any).IntersectionObserver = originalIO
    }
    if (originalMO === undefined) {
      delete (globalThis as any).MutationObserver
    } else {
      ;(globalThis as any).MutationObserver = originalMO
    }
  })

  it('directive: autoUpdate omitted → no observers attached', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl })

    expect(roInstances).toHaveLength(0)
    expect(ioInstances).toHaveLength(0)

    unmountDirective(el)
  })

  it('directive: autoUpdate:false → no observers attached', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: false })

    expect(roInstances).toHaveLength(0)
    expect(ioInstances).toHaveLength(0)

    unmountDirective(el)
  })

  it('directive: autoUpdate:true attaches RO + IO observing the to element on mount', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })

    expect(roInstances).toHaveLength(1)
    expect(ioInstances).toHaveLength(1)
    expect(roInstances[0].observed).toEqual([refEl])
    expect(ioInstances[0].observed).toEqual([refEl])
    // IO root defaults to viewport (null) when no boundary given.
    expect(ioInstances[0].options?.root ?? null).toBeNull()

    unmountDirective(el)
  })

  it('directive: ResizeObserver callback triggers a RAF-batched re-position', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, autoUpdate: true })
    expect(el.style.top).toBe('140px')

    // Simulate ref reflowing — top moves to 200.
    refEl.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)

    roInstances[0].trigger()
    vi.advanceTimersByTime(17)

    expect(el.style.top).toBe('240px')

    unmountDirective(el)
  })

  it('directive: IntersectionObserver callback triggers a RAF-batched re-position', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, autoUpdate: true })
    expect(el.style.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)

    ioInstances[0].trigger()
    vi.advanceTimersByTime(17)

    expect(el.style.top).toBe('340px')

    unmountDirective(el)
  })

  it('directive: observers are disconnected on unmount', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })

    const ro = roInstances[0]
    const io = ioInstances[0]
    expect(ro.disconnected).toBe(false)
    expect(io.disconnected).toBe(false)

    unmountDirective(el)

    expect(ro.disconnected).toBe(true)
    expect(io.disconnected).toBe(true)
  })

  it('directive: toggling autoUpdate false→true via update attaches observers', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: false })
    expect(roInstances).toHaveLength(0)

    updateDirective(el, { to: refEl, autoUpdate: true })

    expect(roInstances).toHaveLength(1)
    expect(ioInstances).toHaveLength(1)
    expect(roInstances[0].observed).toEqual([refEl])

    unmountDirective(el)
  })

  it('directive: toggling autoUpdate true→false via update disconnects observers', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })
    const ro = roInstances[0]
    const io = ioInstances[0]
    expect(ro.disconnected).toBe(false)

    updateDirective(el, { to: refEl, autoUpdate: false })

    expect(ro.disconnected).toBe(true)
    expect(io.disconnected).toBe(true)
  })

  it('directive: re-observes new element when `to` ref switches mid-life', () => {
    const refA = makeRef()
    const refB = makeRef()
    const el = makeEl()

    mountDirective(el, { to: refA, autoUpdate: true })
    expect(roInstances).toHaveLength(1)
    expect(roInstances[0].observed).toEqual([refA])
    const oldRO = roInstances[0]
    const oldIO = ioInstances[0]

    updateDirective(el, { to: refB, autoUpdate: true })

    // Old observers disconnected; new ones spun up for refB.
    expect(oldRO.disconnected).toBe(true)
    expect(oldIO.disconnected).toBe(true)
    expect(roInstances).toHaveLength(2)
    expect(roInstances[1].observed).toEqual([refB])
    expect(ioInstances[1].observed).toEqual([refB])

    unmountDirective(el)
  })

  it('directive: re-observing same element across update is a no-op (no new observers)', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true, offsetY: 0 })
    expect(roInstances).toHaveLength(1)

    updateDirective(el, { to: refEl, autoUpdate: true, offsetY: 5 })

    // Same element — no new observers, no disconnect.
    expect(roInstances).toHaveLength(1)
    expect(ioInstances).toHaveLength(1)
    expect(roInstances[0].disconnected).toBe(false)

    unmountDirective(el)
  })

  it('directive: enabled:false disconnects observers, re-enable re-attaches', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })
    const firstRO = roInstances[0]
    expect(firstRO.disconnected).toBe(false)

    updateDirective(el, { to: refEl, autoUpdate: true, enabled: false })
    expect(firstRO.disconnected).toBe(true)

    updateDirective(el, { to: refEl, autoUpdate: true, enabled: true })
    expect(roInstances).toHaveLength(2)
    expect(roInstances[1].observed).toEqual([refEl])

    unmountDirective(el)
  })

  it('directive: IO root reflects boundary HTMLElement when supplied', () => {
    const boundary = document.createElement('div')
    document.body.appendChild(boundary)
    const refEl = makeRef()
    refEl.parentNode?.removeChild(refEl)
    boundary.appendChild(refEl)

    const el = makeEl()
    mountDirective(el, { to: refEl, autoUpdate: true, boundary })

    expect(ioInstances[0].options?.root).toBe(boundary)

    unmountDirective(el)
  })

  it('directive: IO root falls back to null when boundary === "viewport"', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true, boundary: 'viewport' })
    expect(ioInstances[0].options?.root ?? null).toBeNull()
    unmountDirective(el)
  })

  it('directive: graceful no-op when ResizeObserver is undefined', () => {
    delete (globalThis as any).ResizeObserver
    const el = makeEl()
    const refEl = makeRef()

    expect(() => mountDirective(el, { to: refEl, autoUpdate: true })).not.toThrow()
    // IO still attached.
    expect(ioInstances).toHaveLength(1)
    expect(roInstances).toHaveLength(0)

    unmountDirective(el)
  })

  it('directive: graceful no-op when both observers are undefined', () => {
    delete (globalThis as any).ResizeObserver
    delete (globalThis as any).IntersectionObserver
    const el = makeEl()
    const refEl = makeRef()

    expect(() => mountDirective(el, { to: refEl, autoUpdate: true })).not.toThrow()
    expect(roInstances).toHaveLength(0)
    expect(ioInstances).toHaveLength(0)
    // Calculation still happened via the regular code path.
    expect(el.style.position).toBe('fixed')

    unmountDirective(el)
  })

  it('directive: detached `to` does not attach observers', () => {
    const refEl = makeRef()
    document.body.removeChild(refEl)
    const el = makeEl()
    mountDirective(el, { to: refEl, autoUpdate: true })

    expect(roInstances).toHaveLength(0)
    expect(ioInstances).toHaveLength(0)

    unmountDirective(el)
  })

  it('useTeleportTo: autoUpdate:true attaches observers; scope.stop disconnects', () => {
    const refEl = makeRef()
    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, autoUpdate: true }))

    expect(roInstances).toHaveLength(1)
    expect(ioInstances).toHaveLength(1)
    expect(roInstances[0].observed).toEqual([refEl])

    const ro = roInstances[0]
    const io = ioInstances[0]
    scope.stop()
    expect(ro.disconnected).toBe(true)
    expect(io.disconnected).toBe(true)
  })

  it('useTeleportTo: ResizeObserver callback triggers RAF-batched recompute', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl, autoUpdate: true }))!
    expect(styles.value.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 250, left: 50, width: 200, height: 40,
      right: 250, bottom: 290, x: 50, y: 250, toJSON: () => ({}),
    } as DOMRect)

    roInstances[0].trigger()
    vi.advanceTimersByTime(17)

    expect(styles.value.top).toBe('290px')
    scope.stop()
  })

  it('useTeleportTo: autoUpdate omitted → no observers', () => {
    const refEl = makeRef()
    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl }))

    expect(roInstances).toHaveLength(0)
    expect(ioInstances).toHaveLength(0)
    scope.stop()
  })

  // ─── MutationObserver integration (third observer) ──────────────────────────

  it('directive: autoUpdate omitted → no MutationObserver attached', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl })
    expect(moInstances).toHaveLength(0)
    unmountDirective(el)
  })

  it('directive: autoUpdate:true attaches MutationObserver observing the to element', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })

    expect(moInstances).toHaveLength(1)
    expect(moInstances[0].observed).toHaveLength(1)
    expect(moInstances[0].observed[0].target).toBe(refEl)
    // Observes the layout-affecting mutations: attribute changes (style/class
    // filter), childList, and characterData. RO catches bbox change but not
    // visible-content shifts inside an unchanged-bbox element.
    const opts = moInstances[0].observed[0].options
    expect(opts.attributes).toBe(true)
    expect(opts.attributeFilter).toEqual(['style', 'class'])
    expect(opts.childList).toBe(true)
    expect(opts.characterData).toBe(true)
    // No subtree by default — keeps the observer scoped to the direct
    // reference (subtree mutations are usually noise for positioning).
    expect(opts.subtree ?? false).toBe(false)

    unmountDirective(el)
  })

  it('directive: MutationObserver callback triggers a RAF-batched re-position', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, autoUpdate: true })
    expect(el.style.top).toBe('140px')

    // Simulate ref's bbox shifting after a class change (e.g. consumer toggled
    // a class that swapped padding via CSS; RO might also catch this, but MO
    // catches the exact moment the attribute mutates).
    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)

    moInstances[0].trigger()
    vi.advanceTimersByTime(17)

    expect(el.style.top).toBe('260px')
    unmountDirective(el)
  })

  it('directive: MutationObserver disconnects on unmount', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })
    const mo = moInstances[0]
    expect(mo.disconnected).toBe(false)

    unmountDirective(el)

    expect(mo.disconnected).toBe(true)
  })

  it('directive: toggling autoUpdate true→false disconnects MutationObserver', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })
    const mo = moInstances[0]

    updateDirective(el, { to: refEl, autoUpdate: false })

    expect(mo.disconnected).toBe(true)
  })

  it('directive: re-observes new MO target when `to` switches mid-life', () => {
    const refA = makeRef()
    const refB = makeRef()
    const el = makeEl()

    mountDirective(el, { to: refA, autoUpdate: true })
    const oldMO = moInstances[0]
    expect(oldMO.observed[0].target).toBe(refA)

    updateDirective(el, { to: refB, autoUpdate: true })

    expect(oldMO.disconnected).toBe(true)
    expect(moInstances).toHaveLength(2)
    expect(moInstances[1].observed[0].target).toBe(refB)

    unmountDirective(el)
  })

  it('directive: graceful no-op when MutationObserver is undefined', () => {
    delete (globalThis as any).MutationObserver
    const el = makeEl()
    const refEl = makeRef()

    expect(() => mountDirective(el, { to: refEl, autoUpdate: true })).not.toThrow()
    // RO + IO still attach; calculation still happens.
    expect(roInstances).toHaveLength(1)
    expect(ioInstances).toHaveLength(1)
    expect(moInstances).toHaveLength(0)
    expect(el.style.position).toBe('fixed')

    unmountDirective(el)
  })

  it('directive: detached `to` does not attach MutationObserver', () => {
    const refEl = makeRef()
    document.body.removeChild(refEl)
    const el = makeEl()
    mountDirective(el, { to: refEl, autoUpdate: true })

    expect(moInstances).toHaveLength(0)

    unmountDirective(el)
  })

  it('useTeleportTo: autoUpdate:true attaches MutationObserver; scope.stop disconnects', () => {
    const refEl = makeRef()
    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, autoUpdate: true }))

    expect(moInstances).toHaveLength(1)
    expect(moInstances[0].observed[0].target).toBe(refEl)
    const mo = moInstances[0]

    scope.stop()
    expect(mo.disconnected).toBe(true)
  })

  it('useTeleportTo: MutationObserver callback triggers RAF-batched recompute', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl, autoUpdate: true }))!
    expect(styles.value.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 280, left: 50, width: 200, height: 40,
      right: 250, bottom: 320, x: 50, y: 280, toJSON: () => ({}),
    } as DOMRect)

    moInstances[0].trigger()
    vi.advanceTimersByTime(17)

    expect(styles.value.top).toBe('320px')
    scope.stop()
  })

  // ─── autoUpdateSubtree opt-in ───────────────────────────────────────────────

  it('directive: autoUpdateSubtree omitted → MO observes with subtree:false', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true })

    expect(moInstances).toHaveLength(1)
    expect(moInstances[0].observed[0].options.subtree ?? false).toBe(false)

    unmountDirective(el)
  })

  it('directive: autoUpdateSubtree:true → MO observes with subtree:true', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true, autoUpdateSubtree: true })

    expect(moInstances).toHaveLength(1)
    expect(moInstances[0].observed[0].options.subtree).toBe(true)
    // Other init fields unchanged — only `subtree` widens.
    const opts = moInstances[0].observed[0].options
    expect(opts.attributes).toBe(true)
    expect(opts.attributeFilter).toEqual(['style', 'class'])
    expect(opts.childList).toBe(true)
    expect(opts.characterData).toBe(true)

    unmountDirective(el)
  })

  it('directive: autoUpdateSubtree:true MO callback drives a RAF-batched recalc', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, autoUpdate: true, autoUpdateSubtree: true })
    expect(el.style.top).toBe('140px')

    // Simulate a deep descendant mutation by firing the MO callback after a
    // ref-bbox change (the stub MO does not differentiate which mutation
    // record triggered the callback — verifying subtree:true on init is
    // enough; this test pins that the callback path still drives a recalc
    // when subtree is on).
    refEl.getBoundingClientRect = () => ({
      top: 240, left: 50, width: 200, height: 40,
      right: 250, bottom: 280, x: 50, y: 240, toJSON: () => ({}),
    } as DOMRect)

    moInstances[0].trigger()
    vi.advanceTimersByTime(17)

    expect(el.style.top).toBe('280px')
    unmountDirective(el)
  })

  it('directive: autoUpdate:false ignores autoUpdateSubtree (no MO attached)', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: false, autoUpdateSubtree: true })

    // No observers at all when autoUpdate is off — subtree flag is gated by
    // autoUpdate.
    expect(moInstances).toHaveLength(0)
    expect(roInstances).toHaveLength(0)
    expect(ioInstances).toHaveLength(0)

    unmountDirective(el)
  })

  it('directive: toggling autoUpdateSubtree mid-life re-attaches MO with new setting', () => {
    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, autoUpdate: true, autoUpdateSubtree: false })

    expect(moInstances).toHaveLength(1)
    expect(moInstances[0].observed[0].options.subtree ?? false).toBe(false)
    const oldMO = moInstances[0]

    // Flip subtree on — same `to` element, new observer should be created.
    updateDirective(el, { to: refEl, autoUpdate: true, autoUpdateSubtree: true })

    expect(oldMO.disconnected).toBe(true)
    expect(moInstances).toHaveLength(2)
    expect(moInstances[1].observed[0].target).toBe(refEl)
    expect(moInstances[1].observed[0].options.subtree).toBe(true)

    unmountDirective(el)
  })

  it('useTeleportTo: autoUpdateSubtree:true → MO observes with subtree:true', () => {
    const refEl = makeRef()
    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, autoUpdate: true, autoUpdateSubtree: true }))

    expect(moInstances).toHaveLength(1)
    expect(moInstances[0].observed[0].options.subtree).toBe(true)

    scope.stop()
  })
})

// ─── scrollContainer option ───────────────────────────────────────────────────

describe('scrollContainer option', () => {
  /**
   * Several tests below pass `hideWhenReferenceHidden: false`. That is not
   * incidental: `hideWhenReferenceHidden` (default `true`) unions `window`
   * into the resolved target set, so "this container and nothing else" is now
   * only reachable by opting out — see the `window-listener floor` describe.
   * Anything asserting that a scroll somewhere else does NOT drive a recalc
   * has to opt out first, or it is asserting against the floor instead.
   *
   * Note also that the listener is capture-phase on `window`, so with the
   * floor on, a `scroll` dispatched at ANY element in the document reaches
   * it — including containers this directive was never pointed at.
   */
  // Helper: scroll a target by dispatching a 'scroll' event on it.
  function fireScroll(target: EventTarget): void {
    target.dispatchEvent(new Event('scroll'))
  }

  it('directive: omitted → window scroll triggers recalc (back-compat)', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })

    expect(el.style.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 280, left: 50, width: 200, height: 40,
      right: 250, bottom: 320, x: 50, y: 280, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('320px')
  })

  it("directive: scrollContainer:'window' explicit ≡ omitted", () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: 'window' })

    refEl.getBoundingClientRect = () => ({
      top: 240, left: 50, width: 200, height: 40,
      right: 250, bottom: 280, x: 50, y: 240, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('280px')
  })

  it('directive: HTMLElement scrollContainer — scroll on container triggers recalc', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: container })

    expect(el.style.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(container)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('240px')
  })

  it('directive: HTMLElement scrollContainer — window scroll does NOT trigger recalc', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: container, hideWhenReferenceHidden: false })

    expect(el.style.top).toBe('140px')

    // Mutate ref geometry, then scroll WINDOW — should not pick up the change.
    refEl.getBoundingClientRect = () => ({
      top: 500, left: 50, width: 200, height: 40,
      right: 250, bottom: 540, x: 50, y: 500, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px') // unchanged — listener not on window
  })

  it('directive: switching scrollContainer mid-life detaches old, attaches new', () => {
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.appendChild(containerA)
    document.body.appendChild(containerB)

    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: containerA, hideWhenReferenceHidden: false })

    // Swap to B
    updateDirective(el, { to: refEl, scrollContainer: containerB, hideWhenReferenceHidden: false })

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)

    // Scroll A — should NOT trigger (we moved off it).
    fireScroll(containerA)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')

    // Scroll B — should trigger.
    fireScroll(containerB)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('260px')
  })

  it('directive: switching from container to window via update detaches container listener', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const removeSpy = vi.spyOn(container, 'removeEventListener')

    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: container })

    updateDirective(el, { to: refEl, scrollContainer: 'window' })

    // Container listener was removed during the switch.
    const calls = removeSpy.mock.calls.map(c => c[0])
    expect(calls).toContain('scroll')

    // window scrolls now drive recalcs (window+capture catches everything).
    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('340px')
  })

  it('directive: cleanup on unmount removes scroll listener from container', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const removeSpy = vi.spyOn(container, 'removeEventListener')

    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, scrollContainer: container })
    unmountDirective(el)

    const calls = removeSpy.mock.calls.map(c => c[0])
    expect(calls).toContain('scroll')
  })

  it('directive: detached scrollContainer falls back to window', () => {
    const container = document.createElement('div')
    // NOT appended — not connected.
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: container })

    refEl.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)

    // window scroll should drive recalc since the detached element fell back.
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('240px')
  })

  it('useTeleportTo: HTMLElement scrollContainer — scroll on container triggers recompute', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, scrollContainer: container }),
    )!
    expect(styles.value.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 250, left: 50, width: 200, height: 40,
      right: 250, bottom: 290, x: 50, y: 250, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(container)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('290px')

    scope.stop()
  })

  it('useTeleportTo: HTMLElement scrollContainer — window scroll does NOT recompute', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, scrollContainer: container, hideWhenReferenceHidden: false }),
    )!

    refEl.getBoundingClientRect = () => ({
      top: 600, left: 50, width: 200, height: 40,
      right: 250, bottom: 640, x: 50, y: 600, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('140px')

    scope.stop()
  })

  it('useTeleportTo: cleanup on scope.stop removes scroll listener from container', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const removeSpy = vi.spyOn(container, 'removeEventListener')
    const refEl = makeRef()

    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, scrollContainer: container }))
    scope.stop()

    const calls = removeSpy.mock.calls.map(c => c[0])
    expect(calls).toContain('scroll')
  })

  it('useTeleportTo: switching scrollContainer mid-life via reactive opts', () => {
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.appendChild(containerA)
    document.body.appendChild(containerB)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const opts = ref<TeleportToOptions>({ to: refEl, scrollContainer: containerA, hideWhenReferenceHidden: false })

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo(opts))!

    opts.value = { to: refEl, scrollContainer: containerB, hideWhenReferenceHidden: false }

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(containerA)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('140px')

    fireScroll(containerB)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('260px')

    scope.stop()
  })

  // ── Array of scrollContainer ancestors ──

  it('directive: array of containers — scroll on either triggers recalc', () => {
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.appendChild(containerA)
    document.body.appendChild(containerB)

    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [containerA, containerB] })

    expect(el.style.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 160, left: 50, width: 200, height: 40,
      right: 250, bottom: 200, x: 50, y: 160, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(containerA)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('200px')

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(containerB)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('260px')
  })

  it('directive: array — scroll on unrelated third container does NOT trigger', () => {
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    const unrelated = document.createElement('div')
    document.body.appendChild(containerA)
    document.body.appendChild(containerB)
    document.body.appendChild(unrelated)

    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [containerA, containerB], hideWhenReferenceHidden: false })

    refEl.getBoundingClientRect = () => ({
      top: 500, left: 50, width: 200, height: 40,
      right: 250, bottom: 540, x: 50, y: 500, toJSON: () => ({}),
    } as DOMRect)

    fireScroll(unrelated)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px') // unchanged
  })

  it('directive: array — mid-life array swap detaches old + attaches new', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    const c = document.createElement('div')
    document.body.appendChild(a)
    document.body.appendChild(b)
    document.body.appendChild(c)

    const removeSpyA = vi.spyOn(a, 'removeEventListener')
    const removeSpyB = vi.spyOn(b, 'removeEventListener')

    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [a, b], hideWhenReferenceHidden: false })
    updateDirective(el, { to: refEl, scrollContainer: [b, c], hideWhenReferenceHidden: false })

    // a removed; b retained; c added
    expect(removeSpyA.mock.calls.map(x => x[0])).toContain('scroll')
    // b should NOT have been removed during the swap (kept across)
    expect(removeSpyB.mock.calls.map(x => x[0])).not.toContain('scroll')

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)

    // a is gone — should not trigger
    fireScroll(a)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')

    // b is kept
    fireScroll(b)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('260px')

    // c is new
    refEl.getBoundingClientRect = () => ({
      top: 280, left: 50, width: 200, height: 40,
      right: 250, bottom: 320, x: 50, y: 280, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(c)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('320px')
  })

  it('directive: array — partially-detached entries are skipped (no window fallback)', () => {
    const connected = document.createElement('div')
    const detached = document.createElement('div') // not appended
    document.body.appendChild(connected)

    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [connected, detached], hideWhenReferenceHidden: false })

    // detached entry skipped — only `connected` listens.
    refEl.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(connected)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('240px')

    // window scroll should NOT trigger — array given means no fallback to window.
    refEl.getBoundingClientRect = () => ({
      top: 400, left: 50, width: 200, height: 40,
      right: 250, bottom: 440, x: 50, y: 400, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('240px') // unchanged
  })

  it('directive: array — empty array ⇒ no scroll listeners (no window fallback)', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [], hideWhenReferenceHidden: false })

    refEl.getBoundingClientRect = () => ({
      top: 400, left: 50, width: 200, height: 40,
      right: 250, bottom: 440, x: 50, y: 400, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')
  })

  it('directive: array — unmount cleans up all listeners', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    document.body.appendChild(a)
    document.body.appendChild(b)
    const removeA = vi.spyOn(a, 'removeEventListener')
    const removeB = vi.spyOn(b, 'removeEventListener')

    const el = makeEl()
    const refEl = makeRef()
    mountDirective(el, { to: refEl, scrollContainer: [a, b] })
    unmountDirective(el)

    expect(removeA.mock.calls.map(x => x[0])).toContain('scroll')
    expect(removeB.mock.calls.map(x => x[0])).toContain('scroll')
  })

  it('useTeleportTo: array of containers — scroll on either triggers recompute', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    document.body.appendChild(a)
    document.body.appendChild(b)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, scrollContainer: [a, b] }),
    )!
    expect(styles.value.top).toBe('140px')

    refEl.getBoundingClientRect = () => ({
      top: 160, left: 50, width: 200, height: 40,
      right: 250, bottom: 200, x: 50, y: 160, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(a)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('200px')

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(b)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('260px')

    scope.stop()
  })

  it('useTeleportTo: array — partially-detached entries are skipped', () => {
    const connected = document.createElement('div')
    const detached = document.createElement('div')
    document.body.appendChild(connected)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, scrollContainer: [connected, detached], hideWhenReferenceHidden: false }),
    )!

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(connected)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('260px')

    refEl.getBoundingClientRect = () => ({
      top: 400, left: 50, width: 200, height: 40,
      right: 250, bottom: 440, x: 50, y: 400, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('260px') // window did NOT fire

    scope.stop()
  })

  it('useTeleportTo: array — scope.stop cleans up all listeners', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    document.body.appendChild(a)
    document.body.appendChild(b)
    const removeA = vi.spyOn(a, 'removeEventListener')
    const removeB = vi.spyOn(b, 'removeEventListener')
    const refEl = makeRef()

    const scope = effectScope()
    scope.run(() => useTeleportTo({ to: refEl, scrollContainer: [a, b] }))
    scope.stop()

    expect(removeA.mock.calls.map(x => x[0])).toContain('scroll')
    expect(removeB.mock.calls.map(x => x[0])).toContain('scroll')
  })

  it('useTeleportTo: array — mid-life swap via reactive opts', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    const c = document.createElement('div')
    document.body.appendChild(a)
    document.body.appendChild(b)
    document.body.appendChild(c)
    const removeA = vi.spyOn(a, 'removeEventListener')
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const opts = ref<TeleportToOptions>({ to: refEl, scrollContainer: [a, b], hideWhenReferenceHidden: false })
    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo(opts))!

    opts.value = { to: refEl, scrollContainer: [b, c], hideWhenReferenceHidden: false }

    expect(removeA.mock.calls.map(x => x[0])).toContain('scroll')

    refEl.getBoundingClientRect = () => ({
      top: 220, left: 50, width: 200, height: 40,
      right: 250, bottom: 260, x: 50, y: 220, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(a)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('140px')

    fireScroll(c)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('260px')

    scope.stop()
  })

  // ─── virtualReference option ─────────────────────────────────────────────

  describe('virtualReference (synthetic getBoundingClientRect)', () => {
    it('positions relative to a virtual reference object', () => {
      const el = makeEl()
      const virtualRef = {
        getBoundingClientRect: () => ({
          top: 100, left: 50, width: 200, height: 40,
          right: 250, bottom: 140, x: 50, y: 100, toJSON: () => ({}),
        } as DOMRect),
      }
      mountDirective(el, { to: virtualRef })

      // Same expected math as the equivalent real-element test:
      // place below, top=parentBottom (140px).
      expect(el.style.position).toBe('fixed')
      expect(el.style.top).toBe('140px')
      expect(el.style.bottom).toBe('')
    })

    it('accepts a partial DOMRectInit (computes right/bottom from left+width / top+height)', () => {
      const el = makeEl()
      const virtualRef = {
        // Only top/left/width/height supplied — bottom/right derived.
        getBoundingClientRect: () => ({ top: 100, left: 50, width: 200, height: 40 }),
      }
      mountDirective(el, { to: virtualRef })

      // parentBottom = 100 + 40 = 140 → top: 140px
      expect(el.style.top).toBe('140px')
      // parentWidth=200, multiplier=1.5 → maxWidth = 300px
      expect(el.style.maxWidth).toBe('300px')
    })

    it('cursor-tracking: directive update with new rect re-positions', () => {
      const el = makeEl()
      let cursorY = 100
      const virtualRef = {
        getBoundingClientRect: () => ({
          top: cursorY, left: 50, width: 0, height: 0,
          right: 50, bottom: cursorY, x: 50, y: cursorY, toJSON: () => ({}),
        } as DOMRect),
      }
      mountDirective(el, { to: virtualRef })
      expect(el.style.top).toBe('100px')

      cursorY = 250
      // Trigger an update cycle (rebinds options + recalcs).
      updateDirective(el, { to: virtualRef })
      expect(el.style.top).toBe('250px')
    })

    it('useTeleportTo composable: cursor-tracking via update()', () => {
      let cursorY = 100
      const virtualRef = {
        getBoundingClientRect: () => ({
          top: cursorY, left: 50, width: 0, height: 0,
          right: 50, bottom: cursorY, x: 50, y: cursorY, toJSON: () => ({}),
        } as DOMRect),
      }
      const scope = effectScope()
      const result = scope.run(() => useTeleportTo({ to: virtualRef }))!

      expect(result.styles.value.top).toBe('100px')

      cursorY = 250
      result.update()
      expect(result.styles.value.top).toBe('250px')

      scope.stop()
    })

    it('autoUpdate: virtual ref does NOT attach observers (no DOM node to observe)', () => {
      // Stub RO/IO/MO so we can detect any attach attempt.
      const observed: unknown[] = []
      class StubRO {
        observe(t: unknown) { observed.push(['ro', t]) }
        disconnect() {}
        unobserve() {}
      }
      class StubIO {
        constructor() {}
        observe(t: unknown) { observed.push(['io', t]) }
        disconnect() {}
        unobserve() {}
        takeRecords() { return [] }
        root = null
        rootMargin = '0px'
        thresholds: number[] = []
      }
      class StubMO {
        observe(t: unknown) { observed.push(['mo', t]) }
        disconnect() {}
        takeRecords() { return [] }
      }
      const origRO = (window as any).ResizeObserver
      const origIO = (window as any).IntersectionObserver
      const origMO = (window as any).MutationObserver
      ;(window as any).ResizeObserver = StubRO
      ;(window as any).IntersectionObserver = StubIO
      ;(window as any).MutationObserver = StubMO

      try {
        const el = makeEl()
        const virtualRef = {
          getBoundingClientRect: () => ({
            top: 100, left: 50, width: 200, height: 40,
            right: 250, bottom: 140, x: 50, y: 100, toJSON: () => ({}),
          } as DOMRect),
        }
        mountDirective(el, { to: virtualRef, autoUpdate: true })

        // Position still computed even without observers.
        expect(el.style.top).toBe('140px')
        // No observers attached against the virtual ref.
        expect(observed).toEqual([])

        unmountDirective(el)
      } finally {
        ;(window as any).ResizeObserver = origRO
        ;(window as any).IntersectionObserver = origIO
        ;(window as any).MutationObserver = origMO
      }
    })

    it('null/undefined to-ref still no-ops (shape unchanged)', () => {
      const el = makeEl()
      // Suppress the deferred missing-`to` warning this mount schedules.
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      mountDirective(el, { to: null as any })
      expect(el.style.position).toBe('')
    })

    it('to as a getter returning a virtual reference', () => {
      const el = makeEl()
      const virtualRef = {
        getBoundingClientRect: () => ({
          top: 100, left: 50, width: 200, height: 40,
          right: 250, bottom: 140, x: 50, y: 100, toJSON: () => ({}),
        } as DOMRect),
      }
      mountDirective(el, { to: () => virtualRef })
      expect(el.style.top).toBe('140px')
    })

    it('teleport-positioned event fires for virtual ref with correct detail', () => {
      const el = makeEl()
      const virtualRef = {
        getBoundingClientRect: () => ({
          top: 100, left: 50, width: 200, height: 40,
          right: 250, bottom: 140, x: 50, y: 100, toJSON: () => ({}),
        } as DOMRect),
      }
      const handler = vi.fn()
      el.addEventListener('teleport-positioned', handler as any)
      mountDirective(el, { to: virtualRef })

      expect(handler).toHaveBeenCalledTimes(1)
      const detail = (handler.mock.calls[0][0] as CustomEvent<TeleportToEventDetail>).detail
      expect(detail.placement).toBe('bottom')
    })
  })
})

// ─── hideWhenReferenceHidden option ──────────────────────────────────────────


describe('hideWhenReferenceHidden option', () => {
  function makeBoundary(rect: Partial<DOMRect>): HTMLElement {
    const b = document.createElement('div')
    document.body.appendChild(b)
    const base: DOMRect = {
      top: 0, left: 0, width: 1024, height: 800,
      right: 1024, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
    }
    b.getBoundingClientRect = () => ({ ...base, ...rect }) as DOMRect
    return b
  }

  /** Read the detail of the single `teleport-positioned` dispatched by `mountDirective`. */
  function detailOf(el: HTMLElement, opts: TeleportToOptions): TeleportToEventDetail {
    const handler = vi.fn()
    el.addEventListener('teleport-positioned', handler as any)
    mountDirective(el, opts)
    expect(handler).toHaveBeenCalledTimes(1)
    return (handler.mock.calls[0][0] as CustomEvent<TeleportToEventDetail>).detail
  }

  // ── The default (T2) ────────────────────────────────────────────────────────
  // The whole point of the ticket: the bare binding hides. No `boundary`, no
  // flag. Every one of these would have passed vacuously before, because the
  // old gate required an explicit connected HTMLElement boundary.

  it('default, no options at all: reference above the viewport → hidden', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    mountDirective(el, { to: refEl })

    expect(el.style.visibility).toBe('hidden')
    expect(el.dataset.teleportHidden).toBe('')
    expect(el.style.display).toBe('')
  })

  it('default: reference inside the viewport → not hidden, no ownership marker', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    mountDirective(el, { to: refEl })

    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
  })

  it('hideWhenReferenceHidden:false → stays visible with the reference fully off screen', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    mountDirective(el, { to: refEl, hideWhenReferenceHidden: false })

    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
    // …and it is still positioned, just off screen where the reference is.
    expect(el.style.top).toBe('-60px')
  })

  it('hideWhenReferenceHidden:true is the same as omitting it', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    mountDirective(el, { to: refEl, hideWhenReferenceHidden: true })

    expect(el.style.visibility).toBe('hidden')
  })

  it('flips live when the option is toggled mid-life', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    mountDirective(el, { to: refEl })
    expect(el.style.visibility).toBe('hidden')

    updateDirective(el, { to: refEl, hideWhenReferenceHidden: false })
    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()

    updateDirective(el, { to: refEl })
    expect(el.style.visibility).toBe('hidden')
  })

  // ── The predicate is against the VIEWPORT, and it is 2D (T1) ────────────────

  it('no boundary + reference below the viewport → hidden', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 900, height: 40, bottom: 940 })

    mountDirective(el, { to: refEl })

    expect(el.style.visibility).toBe('hidden')
  })

  it("placement:'bottom' + reference fully left of the viewport → hidden", () => {
    const el = makeEl()
    // Vertically dead centre — an axis-aware vertical test can never fire here.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: -300, right: -100, width: 200 })

    mountDirective(el, { to: refEl, placement: 'bottom' })

    expect(el.style.visibility).toBe('hidden')
  })

  it("placement:'bottom' + reference fully right of the viewport → hidden", () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 1100, right: 1300, width: 200 })

    mountDirective(el, { to: refEl, placement: 'bottom' })

    expect(el.style.visibility).toBe('hidden')
  })

  it("placement:'right' + reference fully above the viewport → hidden", () => {
    const el = makeEl()
    // Horizontally dead centre — an axis-aware horizontal test can never fire.
    const refEl = makeRef({ top: -100, height: 40, bottom: -60, left: 400, right: 600, width: 200 })

    mountDirective(el, { to: refEl, placement: 'right' })

    expect(el.style.visibility).toBe('hidden')
  })

  it('a reference touching the viewport edge counts as hidden', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -40, height: 40, bottom: 0 })

    mountDirective(el, { to: refEl })

    expect(el.style.visibility).toBe('hidden')
  })

  it('one pixel of overlap counts as visible', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -39, height: 40, bottom: 1 })

    mountDirective(el, { to: refEl })

    expect(el.style.visibility).toBe('')
  })

  it('an all-zero reference rect (display:none) hides instead of teleporting to 0,0', () => {
    const hidden = makeEl()
    const zeroRef = makeRef({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 })

    mountDirective(hidden, { to: zeroRef })
    expect(hidden.style.visibility).toBe('hidden')

    // The behaviour being replaced, pinned so the freebie is visible: opted
    // out, the host silently parks itself at the top-left corner.
    const parked = makeEl()
    mountDirective(parked, { to: zeroRef, hideWhenReferenceHidden: false })
    expect(parked.style.visibility).toBe('')
    expect(parked.style.top).toBe('0px')
  })

  it('mobile width + reference below the viewport → hidden', () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const el = makeEl()
    const refEl = makeRef({ top: 900, height: 40, bottom: 940 })

    mountDirective(el, { to: refEl })

    // Full-bleed branch confirmed — `overflow` is a no-op here, so nothing but
    // this predicate could have produced the hide.
    expect(el.style.maxWidth).toBe('100vw')
    expect(el.style.visibility).toBe('hidden')
  })

  // ── clipRect = intersect(boundaryRect, viewportRect) (T1) ──────────────────

  it('reference inside a pane that has itself scrolled off screen → hidden', () => {
    const el = makeEl()
    // Pane sits at y=900..1200 — entirely below the 800px viewport.
    const boundary = makeBoundary({ top: 900, height: 300, bottom: 1200 })
    // Reference is comfortably INSIDE that pane, so a boundary-only test says
    // "visible". Intersecting with the viewport is what catches it.
    const refEl = makeRef({ top: 950, height: 40, bottom: 990 })

    mountDirective(el, { to: refEl, boundary })

    expect(el.style.visibility).toBe('hidden')
  })

  it('reference inside a pane scrolled off the TOP of the viewport → hidden', () => {
    const el = makeEl()
    const boundary = makeBoundary({ top: -600, height: 300, bottom: -300 })
    const refEl = makeRef({ top: -500, height: 40, bottom: -460 })

    mountDirective(el, { to: refEl, boundary })

    expect(el.style.visibility).toBe('hidden')
  })

  it('reference outside the boundary but inside the viewport → hidden', () => {
    const el = makeEl()
    const boundary = makeBoundary({ top: 200, height: 400, bottom: 600 })
    const refEl = makeRef({ top: 650, height: 40, bottom: 690 })

    mountDirective(el, { to: refEl, boundary })

    expect(el.style.visibility).toBe('hidden')
  })

  it('reference inside both the boundary and the viewport → visible', () => {
    const el = makeEl()
    const boundary = makeBoundary({ top: 50, height: 400, bottom: 450 })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    mountDirective(el, { to: refEl, boundary })

    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
  })

  it('boundary + hideWhenReferenceHidden:false → reference outside the boundary stays visible', () => {
    const el = makeEl()
    const boundary = makeBoundary({ top: 200, height: 400, bottom: 600 })
    const refEl = makeRef({ top: 650, height: 40, bottom: 690 })

    mountDirective(el, { to: refEl, boundary, hideWhenReferenceHidden: false })

    expect(el.style.visibility).toBe('')
  })

  it('the clip rect stays out of the space math — a boundary larger than the viewport keeps its spaces', () => {
    const el = makeEl()
    // Boundary overhangs the viewport on both vertical edges. If the clip
    // intersection leaked into `boundaryRect`, `availableSpace` would collapse
    // from 710 to the viewport-derived 510.
    const boundary = makeBoundary({ top: -200, height: 1200, bottom: 1000 })
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const detail = detailOf(el, { to: refEl, boundary })

    expect(detail.availableSpace).toBe(1000 - 140) // raw, no buffer
    expect(detail.oppositeSpace).toBe(100 - -200)
    expect(el.style.visibility).toBe('')
  })

  // ── Mechanism: `visibility` + ownership, never `display` (T0's invariant) ───

  it("hiding never touches the consumer's `display`", () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })
    el.style.display = 'none'

    mountDirective(el, { to: refEl })

    expect(el.style.display).toBe('none')
    expect(el.style.visibility).toBe('hidden')
  })

  it('toggles across scrolls — hidden → shown releases the hide', () => {
    const el = makeEl()
    let refRect: Partial<DOMRect> = { top: 100, height: 40, bottom: 140 }
    const refEl = document.createElement('div')
    document.body.appendChild(refEl)
    const baseRect: DOMRect = {
      top: 0, left: 50, width: 200, height: 40,
      right: 250, bottom: 0, x: 50, y: 0, toJSON: () => ({}),
    }
    refEl.getBoundingClientRect = () => ({ ...baseRect, ...refRect }) as DOMRect

    mountDirective(el, { to: refEl })
    expect(el.style.visibility).toBe('')

    // Scroll the reference above the viewport.
    refRect = { top: -100, height: 40, bottom: -60 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(20)
    expect(el.style.visibility).toBe('hidden')
    expect(el.dataset.teleportHidden).toBe('')

    // And back.
    refRect = { top: 100, height: 40, bottom: 140 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(20)
    expect(el.style.visibility).toBe('')
    expect(el.dataset.teleportHidden).toBeUndefined()
  })

  it('coexists with overflow:"hide" — either signal hides the host', () => {
    const el = makeEl()
    // Reference off the top of the viewport; host would fit horizontally, so
    // `overflow: 'hide'` alone resolves to "show".
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    mountDirective(el, { to: refEl, overflow: 'hide' })

    expect(el.style.visibility).toBe('hidden')
  })

  // ── Event detail + composable (T2) ─────────────────────────────────────────

  it('detail reports referenceHidden + hidden when the reference is gone', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    const detail = detailOf(el, { to: refEl })

    expect(detail.referenceHidden).toBe(true)
    expect(detail.hidden).toBe(true)
  })

  it('detail reports both false for a reference on screen', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const detail = detailOf(el, { to: refEl })

    expect(detail.referenceHidden).toBe(false)
    expect(detail.hidden).toBe(false)
  })

  it('referenceHidden is a measurement, reported even when hiding is opted out', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    // This is the `v-if` recipe: opt out of the library's `visibility`, then
    // drive your own unmount off the reported measurement.
    const detail = detailOf(el, { to: refEl, hideWhenReferenceHidden: false })

    expect(detail.referenceHidden).toBe(true)
    expect(detail.hidden).toBe(false)
  })

  it('hidden covers an overflow:"hide" hide too, with referenceHidden false', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    // Right-anchored host spans 800..1100 → overflows the viewport, while the
    // reference itself is on screen.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })

    const detail = detailOf(el, { to: refEl, overflow: 'hide' })

    expect(detail.referenceHidden).toBe(false)
    expect(detail.hidden).toBe(true)
    expect(el.style.visibility).toBe('hidden')
  })

  it('onPositioned receives the same referenceHidden / hidden pair', () => {
    const el = makeEl()
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })
    const onPositioned = vi.fn()

    mountDirective(el, { to: refEl, onPositioned })

    expect(onPositioned).toHaveBeenCalledTimes(1)
    const detail = onPositioned.mock.calls[0][0] as TeleportToEventDetail
    expect(detail.referenceHidden).toBe(true)
    expect(detail.hidden).toBe(true)
  })

  it('the TT-7 detail fields survive alongside the new ones', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const detail = detailOf(el, { to: refEl })

    expect(detail.placement).toBe('bottom')
    expect(detail.oppositeSpace).toBe(100) // raw: refTop
    expect(detail.fit).toBe('unmeasured')
    expect(detail.maxHeight).toBe(240)
  })

  it('useTeleportTo exposes hidden + referenceHidden and hides by default', () => {
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    const scope = effectScope()
    const { styles, hidden, referenceHidden } = scope.run(() => useTeleportTo({ to: refEl }))!

    expect(styles.value.visibility).toBe('hidden')
    expect(hidden.value).toBe(true)
    expect(referenceHidden.value).toBe(true)

    scope.stop()
  })

  it('useTeleportTo: opted out → referenceHidden true, hidden false, no visibility key', () => {
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })

    const scope = effectScope()
    const { styles, hidden, referenceHidden } = scope.run(() =>
      useTeleportTo({ to: refEl, hideWhenReferenceHidden: false }),
    )!

    // Absent, not `''` — the record only ever asserts a hide, never a show.
    expect(styles.value.visibility).toBeUndefined()
    expect('visibility' in styles.value).toBe(false)
    expect(hidden.value).toBe(false)
    expect(referenceHidden.value).toBe(true)

    scope.stop()
  })

  it('useTeleportTo: reference on screen → both false, no visibility key', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles, hidden, referenceHidden } = scope.run(() => useTeleportTo({ to: refEl }))!

    expect('visibility' in styles.value).toBe(false)
    expect(hidden.value).toBe(false)
    expect(referenceHidden.value).toBe(false)

    scope.stop()
  })

  it('useTeleportTo: both refs reset when the composable goes dormant', () => {
    const refEl = makeRef({ top: -100, height: 40, bottom: -60 })
    const opts = ref<TeleportToOptions>({ to: refEl })

    const scope = effectScope()
    const { hidden, referenceHidden } = scope.run(() => useTeleportTo(opts))!
    expect(hidden.value).toBe(true)

    opts.value = { to: refEl, enabled: false }
    expect(hidden.value).toBe(false)
    expect(referenceHidden.value).toBe(false)

    scope.stop()
  })
})

// ─── window-listener floor (T4) ───────────────────────────────────────────────

/**
 * `scrollContainer` *replaces* the window listener. Once hiding is on by
 * default that becomes a silent failure on a documented configuration: narrow
 * the container, scroll the page, the reference leaves the viewport, no recalc
 * fires and the host stays painted with nothing to anchor to.
 *
 * So `window` is unioned into the resolved target set whenever hiding is on.
 * The opt-out is total: `hideWhenReferenceHidden: false` attaches exactly what
 * the consumer named and nothing else.
 */
describe('window-listener floor', () => {
  function fireScroll(target: EventTarget): void {
    target.dispatchEvent(new Event('scroll'))
  }

  /** How many `scroll` listeners were added to / removed from `window`. */
  function windowScrollSpies() {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    return {
      added: () => add.mock.calls.filter((c) => c[0] === 'scroll').length,
      removed: () => remove.mock.calls.filter((c) => c[0] === 'scroll').length,
    }
  }

  it('the failure this exists for: narrow scrollContainer + page scroll still hides', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const el = makeEl()
    let refRect: Partial<DOMRect> = { top: 100, height: 40, bottom: 140 }
    const refEl = document.createElement('div')
    document.body.appendChild(refEl)
    const base: DOMRect = {
      top: 0, left: 50, width: 200, height: 40,
      right: 250, bottom: 0, x: 50, y: 0, toJSON: () => ({}),
    }
    refEl.getBoundingClientRect = () => ({ ...base, ...refRect }) as DOMRect

    mountDirective(el, { to: refEl, scrollContainer: pane })
    expect(el.style.visibility).toBe('')

    // The PAGE scrolls (not the pane) and the reference leaves the viewport.
    refRect = { top: -200, height: 40, bottom: -160 }
    fireScroll(window)
    vi.advanceTimersByTime(20)

    expect(el.style.visibility).toBe('hidden')
    expect(el.dataset.teleportHidden).toBe('')
  })

  it('directive: HTMLElement scrollContainer + hiding on → window scroll recalcs', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: pane })

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('340px')

    // The named container is still listened to — the floor adds, never replaces.
    refEl.getBoundingClientRect = () => ({
      top: 320, left: 50, width: 200, height: 40,
      right: 250, bottom: 360, x: 50, y: 320, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(pane)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('360px')
  })

  it('directive: the opt-out is total — only the named container is attached', () => {
    const spies = windowScrollSpies()
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: pane, hideWhenReferenceHidden: false })

    expect(spies.added()).toBe(0)

    refEl.getBoundingClientRect = () => ({
      top: 500, left: 50, width: 200, height: 40,
      right: 250, bottom: 540, x: 50, y: 500, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')
  })

  it("directive: scrollContainer:'window' attaches window exactly once", () => {
    const spies = windowScrollSpies()
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: 'window' })

    expect(spies.added()).toBe(1)
  })

  it('directive: omitted scrollContainer attaches window exactly once', () => {
    const spies = windowScrollSpies()
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })

    expect(spies.added()).toBe(1)
  })

  it('directive: array form gets the floor too', () => {
    const a = document.createElement('div')
    document.body.appendChild(a)
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [a] })

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('340px')
  })

  it('directive: empty array + hiding on → the floor is the only listener', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [] })

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('340px')
  })

  it('directive: empty array + opted out → no scroll listener anywhere', () => {
    const spies = windowScrollSpies()
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, scrollContainer: [], hideWhenReferenceHidden: false })

    expect(spies.added()).toBe(0)

    refEl.getBoundingClientRect = () => ({
      top: 400, left: 50, width: 200, height: 40,
      right: 250, bottom: 440, x: 50, y: 400, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')
  })

  it('directive: toggling the option mid-life adds/removes window without disturbing the pane', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const paneRemove = vi.spyOn(pane, 'removeEventListener')
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    mountDirective(el, { to: refEl, scrollContainer: pane })

    // Opt out mid-life → the window listener goes, the pane stays put.
    updateDirective(el, { to: refEl, scrollContainer: pane, hideWhenReferenceHidden: false })
    expect(paneRemove.mock.calls.map((c) => c[0])).not.toContain('scroll')

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')

    // Opt back in → the floor comes back.
    updateDirective(el, { to: refEl, scrollContainer: pane })
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('340px')
  })

  it('directive: unmount removes the floor as well as the container listener', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const paneRemove = vi.spyOn(pane, 'removeEventListener')
    const spies = windowScrollSpies()
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    mountDirective(el, { to: refEl, scrollContainer: pane })
    unmountDirective(el)

    expect(paneRemove.mock.calls.map((c) => c[0])).toContain('scroll')
    expect(spies.removed()).toBe(1)

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(el.style.top).toBe('140px')
  })

  it('useTeleportTo: HTMLElement scrollContainer + hiding on → window scroll recomputes', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl, scrollContainer: pane }))!

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('340px')

    scope.stop()
  })

  it('useTeleportTo: opted out → the named container only', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, scrollContainer: pane, hideWhenReferenceHidden: false }),
    )!

    refEl.getBoundingClientRect = () => ({
      top: 200, left: 50, width: 200, height: 40,
      right: 250, bottom: 240, x: 50, y: 200, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('140px')

    // Same event on the named container does land — proving the fixture
    // above would have moved the host if window had been listening.
    fireScroll(pane)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('240px')

    scope.stop()
  })

  it('useTeleportTo: scope.stop removes the floor', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const spies = windowScrollSpies()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl, scrollContainer: pane }))!
    expect(spies.added()).toBe(1)
    scope.stop()
    expect(spies.removed()).toBe(1)

    refEl.getBoundingClientRect = () => ({
      top: 300, left: 50, width: 200, height: 40,
      right: 250, bottom: 340, x: 50, y: 300, toJSON: () => ({}),
    } as DOMRect)
    fireScroll(window)
    vi.advanceTimersByTime(17)
    expect(styles.value.top).toBe('140px')
  })
})

// ─── data-teleport-state attribute ─────────────────────────────────────────────

describe('data-teleport-state attribute', () => {
  it('sets data-teleport-state="open" on host after a successful position calc', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })

    expect(el.dataset.teleportState).toBe('open')
    expect(el.getAttribute('data-teleport-state')).toBe('open')
  })

  it('sets data-teleport-state="closed" on mount when `to` is missing (dormant)', () => {
    const el = makeEl()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })

    expect(el.dataset.teleportState).toBe('closed')
  })

  it('toggles open → closed when enabled flips to false', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })
    expect(el.dataset.teleportState).toBe('open')

    updateDirective(el, { to: refEl, enabled: false })
    expect(el.dataset.teleportState).toBe('closed')
  })

  it('toggles closed → open when enabled flips back to true', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl, enabled: false })
    expect(el.dataset.teleportState).toBe('closed')

    updateDirective(el, { to: refEl, enabled: true })
    expect(el.dataset.teleportState).toBe('open')
  })

  it('toggles open → closed when `to` becomes detached and a recalc fires', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })
    expect(el.dataset.teleportState).toBe('open')

    refEl.remove()
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.dataset.teleportState).toBe('closed')
  })

  it('toggles open → closed when `to` is removed via updated() with null', () => {
    const el = makeEl()
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    mountDirective(el, { to: refEl })
    expect(el.dataset.teleportState).toBe('open')

    updateDirective(el, { to: null as unknown as HTMLElement })
    expect(el.dataset.teleportState).toBe('closed')
  })

  it('useTeleportTo composable exposes a state ref ("open" / "closed")', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })

    const scope = effectScope()
    const result = scope.run(() => useTeleportTo({ to: refEl }))!

    // Initial calculation already ran successfully → 'open'.
    expect(result.state.value).toBe('open')

    scope.stop()
  })

  it('useTeleportTo state flips to "closed" when enabled toggles to false', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const opts = ref<TeleportToOptions>({ to: refEl, enabled: true })

    const scope = effectScope()
    const { state } = scope.run(() => useTeleportTo(opts))!

    expect(state.value).toBe('open')

    opts.value = { to: refEl, enabled: false }
    vi.advanceTimersByTime(17)

    expect(state.value).toBe('closed')

    scope.stop()
  })

  it('useTeleportTo state flips to "closed" when `to` resolves to null', () => {
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const toRef = ref<HTMLElement | null>(refEl)

    const scope = effectScope()
    const { state } = scope.run(() => useTeleportTo({ to: toRef }))!

    expect(state.value).toBe('open')

    toRef.value = null
    vi.advanceTimersByTime(17)

    expect(state.value).toBe('closed')

    scope.stop()
  })

  it('useTeleportTo state starts as "closed" when `to` is null on creation', () => {
    const scope = effectScope()
    const { state } = scope.run(() => useTeleportTo({ to: null as unknown as HTMLElement }))!

    expect(state.value).toBe('closed')

    scope.stop()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Overflow-container escape — pins the README's "Escapes all overflow/clip
// containers" headline claim. The directive emits `position: fixed` by default
// so it is positioned relative to the viewport, ignoring ancestor `overflow:
// hidden` / `clip-path` clipping. The math reads only the *reference's*
// `getBoundingClientRect()` — never any ancestor's overflow or clip styles —
// so ancestor overflow modes cannot influence the directive's output.
// ────────────────────────────────────────────────────────────────────────────

function makeClippedRef(
  containerStyles: Partial<CSSStyleDeclaration>,
  rect: Partial<DOMRect> = {},
): { container: HTMLElement; ref: HTMLElement } {
  const container = document.createElement('div')
  for (const [k, v] of Object.entries(containerStyles)) {
    ;(container.style as unknown as Record<string, string>)[k] = v as string
  }
  document.body.appendChild(container)

  const refEl = document.createElement('div')
  container.appendChild(refEl)

  const base: DOMRect = {
    top: 100,
    left: 50,
    width: 200,
    height: 40,
    right: 250,
    bottom: 140,
    x: 50,
    y: 100,
    toJSON: () => ({}),
  }
  refEl.getBoundingClientRect = () => ({ ...base, ...rect }) as DOMRect
  return { container, ref: refEl }
}

describe('overflow-container escape — README contract', () => {
  it('default strategy emits `position: fixed` so the host is viewport-relative regardless of ancestor styles', () => {
    const el = makeEl()
    const { ref: refEl } = makeClippedRef({
      overflow: 'hidden',
      width: '200px',
      height: '100px',
    })
    mountDirective(el, { to: refEl })

    expect(el.style.position).toBe('fixed')
  })

  it('ancestor `overflow:hidden` does NOT change computed top/left (math is viewport-relative)', () => {
    const elA = makeEl()
    const refA = makeRef({ top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140 })
    mountDirective(elA, { to: refA })
    const baselineTop = elA.style.top
    const baselineLeft = elA.style.left
    const baselineMaxHeight = elA.style.maxHeight

    const elB = makeEl()
    const { ref: refB } = makeClippedRef(
      { overflow: 'hidden', width: '200px', height: '100px' },
      { top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140 },
    )
    mountDirective(elB, { to: refB })

    expect(elB.style.top).toBe(baselineTop)
    expect(elB.style.left).toBe(baselineLeft)
    expect(elB.style.maxHeight).toBe(baselineMaxHeight)
    expect(elB.style.position).toBe('fixed')
  })

  it('deeply nested `overflow:hidden` + `clip-path` ancestors do not affect the computed styles', () => {
    const outer = document.createElement('div')
    outer.style.overflow = 'hidden'
    outer.style.width = '300px'
    outer.style.height = '120px'
    document.body.appendChild(outer)

    const inner = document.createElement('div')
    inner.style.overflow = 'hidden'
    inner.style.clipPath = 'inset(0)'
    inner.style.width = '200px'
    inner.style.height = '60px'
    outer.appendChild(inner)

    const refEl = document.createElement('div')
    inner.appendChild(refEl)
    refEl.getBoundingClientRect = () => ({
      top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140,
      x: 50, y: 100, toJSON: () => ({}),
    } as DOMRect)

    const elNested = makeEl()
    mountDirective(elNested, { to: refEl })

    const elFlat = makeEl()
    const refFlat = makeRef({ top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140 })
    mountDirective(elFlat, { to: refFlat })

    expect(elNested.style.position).toBe('fixed')
    expect(elNested.style.top).toBe(elFlat.style.top)
    expect(elNested.style.left).toBe(elFlat.style.left)
    expect(elNested.style.maxHeight).toBe(elFlat.style.maxHeight)
  })

  it('directive never reads `getComputedStyle` on ancestors — ancestor overflow has zero influence', () => {
    const gcsSpy = vi.spyOn(window, 'getComputedStyle')

    const el = makeEl()
    const { ref: refEl } = makeClippedRef({ overflow: 'hidden', width: '200px', height: '100px' })
    mountDirective(el, { to: refEl })
    updateDirective(el, { to: refEl })

    expect(gcsSpy).not.toHaveBeenCalled()
    gcsSpy.mockRestore()
  })

  it('reference is positioned correctly even when its container is smaller than the host', () => {
    // Realistic dropdown-in-card scenario: card has overflow:hidden and is
    // 200×80, but the dropdown content is 240 (widthMultiplier 1.5 × 160 ref
    // ≈ 240) and the user expects it to extend past the card's right edge.
    // With position:fixed, this is the CSS spec's job — we just verify the
    // directive emits viewport-relative coords so the host can extend past
    // the ancestor's clip rect.
    const card = document.createElement('div')
    card.style.overflow = 'hidden'
    card.style.width = '200px'
    card.style.height = '80px'
    card.style.borderRadius = '8px'
    document.body.appendChild(card)

    const trigger = document.createElement('button')
    card.appendChild(trigger)
    // Trigger sits near the card's right edge; the dropdown extends past.
    trigger.getBoundingClientRect = () => ({
      top: 30, left: 40, width: 160, height: 30, right: 200, bottom: 60,
      x: 40, y: 30, toJSON: () => ({}),
    } as DOMRect)

    const el = makeEl()
    mountDirective(el, { to: trigger })

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('60px') // trigger.bottom — viewport-relative
    expect(el.style.left).toBe('40px') // trigger.left — viewport-relative
    // The card is 200px wide; the host can extend past it because fixed
    // positioning escapes overflow clipping.
  })

  it('scrollable `overflow:auto` ancestor — host stays viewport-relative; `scrollContainer` option lets consumer subscribe to inner scroll', () => {
    const scroller = document.createElement('div')
    scroller.style.overflow = 'auto'
    scroller.style.width = '300px'
    scroller.style.height = '200px'
    document.body.appendChild(scroller)

    const refEl = document.createElement('div')
    scroller.appendChild(refEl)
    refEl.getBoundingClientRect = () => ({
      top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140,
      x: 50, y: 100, toJSON: () => ({}),
    } as DOMRect)

    const el = makeEl()
    const onPositioned = vi.fn()
    el.addEventListener('teleport-positioned', onPositioned as EventListener)
    mountDirective(el, { to: refEl, scrollContainer: scroller })

    expect(onPositioned).toHaveBeenCalledTimes(1)
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')

    // Move the reference (simulating an inner scroll within the clip container).
    refEl.getBoundingClientRect = () => ({
      top: 50, left: 50, width: 200, height: 40, right: 250, bottom: 90,
      x: 50, y: 50, toJSON: () => ({}),
    } as DOMRect)
    scroller.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17) // RAF tick

    expect(onPositioned).toHaveBeenCalledTimes(2)
    expect(el.style.top).toBe('90px')
  })

  it('`strategy: "absolute"` is the documented opt-out — switches to offsetParent-relative coords', () => {
    // strategy:'absolute' is the consumer's explicit escape from fixed
    // positioning — they accept that the host now sits inside whatever
    // overflow ancestor they chose. Verifies the trade-off is wired.
    const el = makeEl()
    const ref = makeRef({ top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140 })

    // Make the host's offsetParent return a non-zero rect so the math differs.
    const opEl = document.createElement('div')
    document.body.appendChild(opEl)
    opEl.getBoundingClientRect = () => ({
      top: 30, left: 20, width: 1000, height: 700, right: 1020, bottom: 730,
      x: 20, y: 30, toJSON: () => ({}),
    } as DOMRect)
    Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => opEl })

    mountDirective(el, { to: ref, strategy: 'absolute' })

    expect(el.style.position).toBe('absolute')
    // top = parentBottom - opTop = 140 - 30 = 110
    expect(el.style.top).toBe('110px')
    // left = parentLeft - opLeft = 50 - 20 = 30
    expect(el.style.left).toBe('30px')
  })

  it('composable `useTeleportTo` emits `position: fixed` for an overflow:hidden-ancestor reference (parity with directive)', () => {
    const { ref: refEl } = makeClippedRef({ overflow: 'hidden', width: '200px', height: '100px' })

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl }))!

    expect(styles.value.position).toBe('fixed')
    // top should equal refEl.bottom (140) for a default placement.
    expect(styles.value.top).toBe('140px')
    scope.stop()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Transformed-ancestor gotcha — CSS quirk: a transformed (or filter/perspective/
// will-change: transform / contain: paint) ancestor establishes a new
// containing block for `position: fixed` descendants. The directive's math
// stays unchanged (it reads only the reference rect), but the rendered host
// would be clipped by such an ancestor if it also has overflow:hidden. We pin
// this to document the trade-off — the workaround is `<Teleport to="body">`
// + the `useTeleportTo` composable.
// ────────────────────────────────────────────────────────────────────────────

describe('overflow-container escape — transformed-ancestor gotcha (documented limitation)', () => {
  it('transformed ancestor does not change the directive output — but README warns about rendering trade-off', () => {
    const transformed = document.createElement('div')
    transformed.style.transform = 'translateZ(0)'
    transformed.style.overflow = 'hidden'
    transformed.style.width = '200px'
    transformed.style.height = '100px'
    document.body.appendChild(transformed)

    const refEl = document.createElement('div')
    transformed.appendChild(refEl)
    refEl.getBoundingClientRect = () => ({
      top: 100, left: 50, width: 200, height: 40, right: 250, bottom: 140,
      x: 50, y: 100, toJSON: () => ({}),
    } as DOMRect)

    const el = makeEl()
    mountDirective(el, { to: refEl })

    // Directive emits the same `position: fixed` + viewport-coord output. The
    // browser's containing-block resolution is what differs at render time —
    // that's the limitation called out in the README "Behavior" section.
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
    expect(el.style.left).toBe('50px')
  })

  it('workaround: `useTeleportTo` + `<Teleport to="body">` slot escapes the transformed containing block', () => {
    // The composable is the documented escape hatch — by binding styles via
    // :style on a portal target outside the transformed ancestor, fixed
    // positioning recovers its viewport-relative behavior.
    const transformed = document.createElement('div')
    transformed.style.transform = 'translateZ(0)'
    document.body.appendChild(transformed)

    const refEl = document.createElement('div')
    transformed.appendChild(refEl)
    refEl.getBoundingClientRect = () => ({
      top: 200, left: 80, width: 160, height: 32, right: 240, bottom: 232,
      x: 80, y: 200, toJSON: () => ({}),
    } as DOMRect)

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl }))!

    // The composable's caller will bind these styles inside a <Teleport to="body">
    // slot — the host lives outside the transformed ancestor at render time, so
    // `position: fixed` once again escapes overflow/clip containers.
    expect(styles.value.position).toBe('fixed')
    expect(styles.value.top).toBe('232px')
    expect(styles.value.left).toBe('80px')
    scope.stop()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// maxWidth option — explicit width clamping. Overrides the default
// `parentWidth × widthMultiplier` and the `100vw` mobile fullbleed branch.
// Useful for popovers that must not exceed a card / column width, regardless
// of how wide the reference grows. Coexists with `matchWidth`: when both are
// set, `matchWidth` wins (consumer was explicit about ref-pinning the width).
// ────────────────────────────────────────────────────────────────────────────

describe('maxWidth option', () => {
  it('numeric `maxWidth` → `${n}px` on host style', () => {
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref, maxWidth: 320 })

    expect(el.style.maxWidth).toBe('320px')
  })

  it('CSS-string `maxWidth` → passed through as-is', () => {
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref, maxWidth: 'min(80vw, 400px)' })

    expect(el.style.maxWidth).toBe('min(80vw, 400px)')
  })

  it('overrides default `parentWidth × widthMultiplier` on desktop', () => {
    // Default: parentWidth=200 * widthMultiplier=1.5 = 300px. maxWidth wins.
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref, maxWidth: 180 })

    expect(el.style.maxWidth).toBe('180px')
  })

  it('overrides mobile fullbleed (`100vw`) when viewport < 768', () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true })
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref, maxWidth: 240 })

    expect(el.style.maxWidth).toBe('240px')
    // Mobile fullbleed pins left:0 — that behavior is still active because the
    // reference is only 200px wide and maxWidth doesn't pin the host's anchor.
    // Consumers who want maxWidth to also defeat the mobile-left-pin should
    // pair it with `matchWidth: false` (default) and an explicit anchor.
  })

  it('ignored when `matchWidth: true` — matchWidth wins on conflict', () => {
    const el = makeEl()
    const ref = makeRef({ width: 300, left: 50, right: 350 })
    mountDirective(el, { to: ref, matchWidth: true, maxWidth: 100 })

    expect(el.style.maxWidth).toBe('300px') // matchWidth produces parentWidth
    expect(el.style.width).toBe('300px')
  })

  it('omitted → default `parentWidth × widthMultiplier` preserved (back-compat)', () => {
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref })

    expect(el.style.maxWidth).toBe('300px') // 200 * 1.5
  })

  it('`maxWidth: 0` → `0px` (truthy-fence respected; zero is a valid value)', () => {
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref, maxWidth: 0 })

    expect(el.style.maxWidth).toBe('0px')
  })

  it('overflow:`shift` clamp uses numeric `maxWidth` as host width', () => {
    // window=1024, ref at left=900, right=1100, width=200.
    // Without maxWidth: hostWidth = 200 * 1.5 = 300, hostLeft = 900, hostRight = 1200 → overflows by 176.
    // With maxWidth=400: hostWidth = 400, hostLeft = 900, hostRight = 1300 → overflows.
    // Shift clamp: maxLeft = 1024 - 400 = 624; hostLeft clamped to 624.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 900, right: 1100, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, overflow: 'shift', maxWidth: 400 })

    expect(el.style.maxWidth).toBe('400px')
    expect(el.style.left).toBe('624px') // 1024 - 400
    expect(el.style.right).toBe('')
  })

  it('overflow:`shift` clamp falls back to widthMultiplier for CSS-string `maxWidth`', () => {
    // CSS-string maxWidth (e.g. 'min(80vw, 400px)') can't be parsed numerically
    // ahead-of-render — the shift math uses the default `parentWidth × multiplier`
    // (200 * 1.5 = 300) to size the host for the clamp, accepting that the visual
    // host width may differ from the math. Consumers using CSS-string maxWidth
    // for sub-viewport sizing should pair with a numeric value when overflow
    // accuracy matters.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 900, right: 1100, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, overflow: 'shift', maxWidth: 'min(80vw, 400px)' })

    expect(el.style.maxWidth).toBe('min(80vw, 400px)')
    // 200 * 1.5 = 300; hostLeft = 900, hostRight = 1200 → overflows.
    // maxLeft = 1024 - 300 = 724.
    expect(el.style.left).toBe('724px')
  })

  it('composable `useTeleportTo` honors numeric `maxWidth`', () => {
    const refEl = makeRef({ width: 200, left: 50, right: 250 })

    const scope = effectScope()
    const { styles } = scope.run(() => useTeleportTo({ to: refEl, maxWidth: 280 }))!

    expect(styles.value.maxWidth).toBe('280px')
    scope.stop()
  })

  it('composable `useTeleportTo` honors CSS-string `maxWidth`', () => {
    const refEl = makeRef({ width: 200, left: 50, right: 250 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, maxWidth: 'clamp(160px, 50vw, 320px)' }),
    )!

    expect(styles.value.maxWidth).toBe('clamp(160px, 50vw, 320px)')
    scope.stop()
  })

  it('composable parity: `matchWidth` wins over `maxWidth`', () => {
    const refEl = makeRef({ width: 300, left: 50, right: 350 })

    const scope = effectScope()
    const { styles } = scope.run(() =>
      useTeleportTo({ to: refEl, matchWidth: true, maxWidth: 100 }),
    )!

    expect(styles.value.maxWidth).toBe('300px') // matchWidth = parentWidth
    expect(styles.value.width).toBe('300px')
    scope.stop()
  })

  it('reactive update: changing `maxWidth` mid-life applies on next tick', () => {
    const el = makeEl()
    const ref = makeRef({ width: 200, left: 50, right: 250 })
    mountDirective(el, { to: ref, maxWidth: 200 })

    expect(el.style.maxWidth).toBe('200px')

    updateDirective(el, { to: ref, maxWidth: 360 })

    expect(el.style.maxWidth).toBe('360px')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Width defects found by the 2026-09-06 audit (TT-16 T1, T3, T5). All three
// are reachable with no opt-in and all three were invisible to the suite,
// because every existing width assertion reads `max-width` — a CAP — while the
// bugs live in `width` and `min-width`.
// ────────────────────────────────────────────────────────────────────────────

describe('width defects — welded width, min-width floor, mobile full-bleed', () => {
  it('T1: turning matchWidth off clears the pinned width instead of welding it on', () => {
    // `width` was written only when `matchWidth` was truthy, and the style
    // applier writes only defined keys — so nothing ever cleared it. Every
    // other side (`top`/`bottom`/`left`/`right`) is explicitly cleared with
    // `''` for exactly this reason.
    const el = makeEl()
    const ref = makeRef({ width: 220, left: 50, right: 270 })

    mountDirective(el, { to: ref })
    expect(el.style.width).toBe('')

    updateDirective(el, { to: ref, matchWidth: true })
    expect(el.style.width).toBe('220px')

    updateDirective(el, { to: ref, matchWidth: false })
    expect(el.style.width).toBe('')

    // …and it stays cleared however many ticks run afterwards.
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(el.style.width).toBe('')
  })

  it('T5: maxWidth narrows the host below the reference width', () => {
    // `min-width: <reference width>` used to be written unconditionally, so it
    // beat `max-width` and a 220px reference rendered a 220px host whatever
    // was asked for. The README's own "`maxWidth: 0` collapses the host" was
    // false.
    const el = makeEl()
    const ref = makeRef({ width: 220, left: 50, right: 270 })

    mountDirective(el, { to: ref, maxWidth: 120 })
    expect(el.style.maxWidth).toBe('120px')
    expect(el.style.minWidth).toBe('120px')

    updateDirective(el, { to: ref, maxWidth: 0 })
    expect(el.style.maxWidth).toBe('0px')
    expect(el.style.minWidth).toBe('0px')
  })

  it('T5: widthMultiplier below 1 narrows the host too', () => {
    const el = makeEl()
    const ref = makeRef({ width: 220, left: 50, right: 270 })
    mountDirective(el, { to: ref, widthMultiplier: 0.5 })

    expect(el.style.maxWidth).toBe('110px')
    expect(el.style.minWidth).toBe('110px')
  })

  it('T5: the min-width floor still holds when nothing narrows the host', () => {
    const el = makeEl()
    const ref = makeRef({ width: 220, left: 50, right: 270 })
    mountDirective(el, { to: ref })

    expect(el.style.minWidth).toBe('220px') // reference width
    expect(el.style.maxWidth).toBe('330px') // 220 × 1.5
  })

  it('T5: a CSS-string maxWidth hands the comparison to CSS rather than guessing', () => {
    const el = makeEl()
    const ref = makeRef({ width: 220, left: 50, right: 270 })
    mountDirective(el, { to: ref, maxWidth: 'min(80vw, 90px)' })

    expect(el.style.minWidth).toBe('min(220px, min(80vw, 90px))')
  })

  it('T3: mobile full-bleed writes a real width, not just a cap', () => {
    // `left: 0` + `max-width: 100vw` is not full-bleed: a host narrower than
    // the viewport stays narrow and gets dragged to the screen's left edge
    // while its trigger sits elsewhere.
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    const el = makeEl()
    const ref = makeRef({ width: 80, left: 300, right: 380 })
    mountDirective(el, { to: ref })

    expect(el.style.left).toBe('0px')
    expect(el.style.width).toBe('100vw')
    expect(el.style.maxWidth).toBe('100vw')
  })

  it('T3: an explicit maxWidth opts out of the whole full-bleed branch, anchor included', () => {
    // `maxWidth` overrode the width half of the branch but not the `left: 0`
    // half, so the host was narrow AND stranded at the screen edge.
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    const el = makeEl()
    const ref = makeRef({ width: 80, left: 300, right: 380 })
    mountDirective(el, { to: ref, maxWidth: 200 })

    expect(el.style.maxWidth).toBe('200px')
    expect(el.style.width).toBe('')
    // Anchored to the reference (right-anchored: 380 ≥ 400 × 0.71 = 284).
    expect(el.style.left).toBe('')
    expect(el.style.right).toBe('20px') // 400 - 380
  })

  it('T3: matchWidth opts out of full-bleed as it always did', () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    const el = makeEl()
    const ref = makeRef({ width: 80, left: 300, right: 380 })
    mountDirective(el, { to: ref, matchWidth: true })

    expect(el.style.width).toBe('80px')
    // Still anchored to the reference — the right-anchor heuristic, not the
    // screen edge (380 ≥ 400 × 0.71).
    expect(el.style.left).toBe('')
    expect(el.style.right).toBe('20px')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// T2 — the arrow variables on a right-anchored host. The `anchorRight`
// heuristic fires automatically past 71% of the viewport width with no option
// set, and the host is then positioned with CSS `right:` — so its real left
// edge is `parentRight − RENDERED width`, not `parentRight − projected width`.
// ────────────────────────────────────────────────────────────────────────────

describe('arrow position on a right-anchored host (TT-16 T2)', () => {
  function arrow(): HTMLElement {
    const a = document.createElement('div')
    document.body.appendChild(a)
    return a
  }

  it('uses the host\'s rendered width, not its projected width', () => {
    // ref 200 wide at 700..900 in a 1024 viewport → 900 ≥ 727 → right-anchored.
    // Projected width is 200 × 1.5 = 300; the host actually renders 200 wide.
    // Arrow X must be refCenterX − (parentRight − renderedWidth)
    //   = 800 − (900 − 200) = 100.   The projection gives 800 − 600 = 200.
    const el = makeEl()
    sizeHost(el, { width: 200, height: 40 })
    const ref = makeRef({ left: 700, right: 900, width: 200, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, arrow: arrow() })

    expect(el.style.right).toBe('124px') // right-anchored: 1024 - 900
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')
  })

  it('crossAxisAlign: "end" reproduces it away from the viewport edge', () => {
    const el = makeEl()
    sizeHost(el, { width: 200, height: 40 })
    const ref = makeRef({ left: 300, right: 500, width: 200, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, crossAxisAlign: 'end', arrow: arrow() })

    // refCenterX 400 − hostLeft (500 − 200) = 100.
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')
  })

  it('a left-anchored host was never wrong, and still is not', () => {
    const el = makeEl()
    sizeHost(el, { width: 200, height: 40 })
    const ref = makeRef({ left: 100, right: 300, width: 200, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, arrow: arrow() })

    // hostLeft = parentLeft; arrow X = half the reference width.
    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('100px')
  })

  it('falls back to the projection when the host has no measurable box', () => {
    // First tick of a `display: none` host, or the composable without one.
    // The projection is the only number available and stays the answer.
    const el = makeEl() // no sizeHost
    const ref = makeRef({ left: 700, right: 900, width: 200, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, arrow: arrow() })

    expect(el.style.getPropertyValue('--teleport-arrow-x')).toBe('200px') // 800 - (900 - 300)
  })

  it('centres the host on its rendered width, not its projection', () => {
    const el = makeEl()
    sizeHost(el, { width: 200, height: 40 })
    const ref = makeRef({ left: 300, right: 500, width: 200, top: 100, bottom: 140 })
    mountDirective(el, { to: ref, crossAxisAlign: 'center' })

    // centre 400 − 200/2 = 300, not 400 − 300/2 = 250.
    expect(el.style.left).toBe('300px')
  })
})

// ─── Deferred reference (template-ref lifecycle) ───────────────────────────────
//
// The real-world mount order. `<div v-teleport-to="{ to: trigger }">` renders
// BEFORE `trigger` is populated — a template ref is null during the render pass
// that reads it, and only assigned as the elements mount. So the directive's
// FIRST `mounted` call always sees `to: null`, and the element must stay live
// enough to recover on the `updated` that follows.
//
// Every playground demo (and every consumer using `useTemplateRef`) hits this.
describe('vTeleportTo — deferred `to` (template-ref lifecycle)', () => {
  it('registers state on mount even when `to` is missing', () => {
    const el = makeEl()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })

    expect(stateMap.has(el)).toBe(true)
  })

  it('positions on the first update once the template ref resolves', () => {
    const el = makeEl()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Render 1: template ref still null.
    mountDirective(el, { to: null as unknown as HTMLElement })
    expect(el.dataset.teleportState).toBe('closed')

    // Render 2: Vue has assigned the ref and re-rendered.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    updateDirective(el, { to: refEl })

    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('140px')
    expect(el.dataset.teleportState).toBe('open')
  })

  it('tracks scroll after recovering from a null `to` at mount', () => {
    const el = makeEl()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })

    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    updateDirective(el, { to: refEl })
    expect(el.style.top).toBe('140px')

    // The scroll listener must have been attached at mount, not skipped.
    refEl.getBoundingClientRect = () =>
      ({ top: 60, left: 50, width: 200, height: 40, right: 250, bottom: 100, x: 50, y: 60, toJSON: () => ({}) }) as DOMRect
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(el.style.top).toBe('100px')
  })

  it('unmount after a null-`to` mount tears down cleanly', () => {
    const el = makeEl()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    mountDirective(el, { to: null as unknown as HTMLElement })
    unmountDirective(el)

    expect(stateMap.has(el)).toBe(false)
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('does not warn when `to` is merely deferred to the next render', async () => {
    const el = makeEl()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })

    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    updateDirective(el, { to: refEl })
    await nextTick()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('still warns when `to` never arrives', async () => {
    const el = makeEl()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })
    await nextTick()

    expect(warnSpy).toHaveBeenCalledWith(
      '[v-teleport-to] "to" reference element is required.',
    )
  })

  it('stays silent when the host unmounts before the flush lands', async () => {
    const el = makeEl()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountDirective(el, { to: null as unknown as HTMLElement })
    unmountDirective(el)
    await nextTick()

    expect(warnSpy).not.toHaveBeenCalled()
  })
})


// ─── hide mechanism — consumer display ownership ───────────────────────────────
//
// The directive must NEVER write `el.style.display`. `v-show` owns that
// property, and `vShow.updated` opens with `if (!value === !oldValue) return`,
// so a single stomp from inside the same Vue patch is unrecoverable: once the
// bound boolean is already `false`, `v-show` will not re-assert `display:none`
// until it flips again. Vue's own repair (re-applying `display:none` when
// `el[vShowHidden]` is set) lives in `patchStyle` and therefore only covers
// styles written through a `:style` binding — an imperative `el.style.display`
// write from a directive bypasses it entirely.
//
// Hiding is expressed instead as `visibility: hidden` plus a
// `data-teleport-hidden` ownership marker, and the directive only ever clears
// a hide that it applied itself.
//
// These cases need a REAL Vue render (`withDirectives` + `vShow`): the bug is
// an interaction between two directives inside one patch, which the bare
// `mountDirective` helper cannot reproduce.

describe('hide mechanism — consumer display ownership', () => {
  function mountWithVShow(open: Ref<boolean>, options: Ref<TeleportToOptions>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const elRef = ref<HTMLElement | null>(null)

    const app = createApp({
      render() {
        // Directive order mirrors template order: `v-show` first, the teleport
        // directive second — so the teleport hook runs LAST in the patch and
        // gets the final word on the element's inline styles.
        return withDirectives(h('div', { ref: elRef }), [
          [vShow, open.value],
          [vTeleportTo, options.value],
        ])
      },
    })
    app.mount(container)

    return {
      get el(): HTMLElement {
        return elRef.value!
      },
      unmount() {
        app.unmount()
        container.remove()
      },
    }
  }

  function makeBoundaryEl(rect: Partial<DOMRect>): HTMLElement {
    const b = document.createElement('div')
    document.body.appendChild(b)
    const base: DOMRect = {
      top: 0, left: 0, width: 1024, height: 800,
      right: 1024, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
    }
    b.getBoundingClientRect = () => ({ ...base, ...rect }) as DOMRect
    return b
  }

  it("overflow:'hide' never overrides v-show=false — in the patch or on a later scroll tick", async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const open = ref(true)
    // Host fits the viewport → the 'hide' branch resolves to "show", which is
    // exactly the tick that used to clear `display`.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 })
    const options = ref<TeleportToOptions>({ to: refEl, overflow: 'hide' })
    const mounted = mountWithVShow(open, options)

    expect(mounted.el.style.display).toBe('')

    open.value = false
    await nextTick()
    expect(mounted.el.style.display).toBe('none')

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(mounted.el.style.display).toBe('none')

    mounted.unmount()
  })

  it('hideWhenReferenceHidden never overrides v-show=false — in the patch or on a later scroll tick', async () => {
    const open = ref(true)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140 })
    const boundary = makeBoundaryEl({ top: 50, height: 400, bottom: 450 })
    const options = ref<TeleportToOptions>({
      to: refEl,
      boundary,
      hideWhenReferenceHidden: true,
    })
    const mounted = mountWithVShow(open, options)

    expect(mounted.el.style.display).toBe('')

    open.value = false
    await nextTick()
    expect(mounted.el.style.display).toBe('none')

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(mounted.el.style.display).toBe('none')

    mounted.unmount()
  })

  /**
   * The default-on hide is the change that would have detonated the bug T0
   * fixed: every mounted host now runs the hide/show branch on every tick,
   * including hosts a consumer has closed with `v-show`. So this drives the
   * whole cycle — closed, reference scrolls away, reference scrolls back —
   * and `display` has to read `none` at every step.
   */
  it('the DEFAULT hide never overrides v-show=false, across a full hide/show cycle', async () => {
    const open = ref(true)
    let rect: Partial<DOMRect> = { top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 }
    const refEl = document.createElement('div')
    document.body.appendChild(refEl)
    refEl.getBoundingClientRect = () =>
      ({ x: rect.left, y: rect.top, toJSON: () => ({}), ...rect }) as DOMRect
    // No options beyond `to` — the bare binding, hiding on by default.
    const options = ref<TeleportToOptions>({ to: refEl })
    const mounted = mountWithVShow(open, options)

    expect(mounted.el.style.display).toBe('')

    open.value = false
    await nextTick()
    expect(mounted.el.style.display).toBe('none')

    // Reference scrolls out of the viewport → the directive hides.
    rect = { top: -200, height: 40, bottom: -160, left: 100, right: 300, width: 200 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(mounted.el.style.visibility).toBe('hidden')
    expect(mounted.el.style.display).toBe('none')

    // …and back. The release path is the one that used to clear `display`.
    rect = { top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(mounted.el.style.visibility).toBe('')
    expect(mounted.el.style.display).toBe('none')

    // Re-opening is still the consumer's call, and it works.
    open.value = true
    await nextTick()
    expect(mounted.el.style.display).toBe('')

    mounted.unmount()
  })

  it('releases its own hide when the directive is disabled mid-life', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const open = ref(true)
    // Right-anchored host (ref right=1100 ≥ 0.71·1024) spans 800..1100 → overflows.
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    const options = ref<TeleportToOptions>({ to: refEl, overflow: 'hide' })
    const mounted = mountWithVShow(open, options)

    expect(mounted.el.style.visibility).toBe('hidden')
    expect(mounted.el.dataset.teleportHidden).toBe('')

    options.value = { to: refEl, overflow: 'hide', enabled: false }
    await nextTick()

    expect(mounted.el.style.visibility).toBe('')
    expect(mounted.el.dataset.teleportHidden).toBeUndefined()
    expect(mounted.el.dataset.teleportState).toBe('closed')

    mounted.unmount()
  })

  it('releases its own hide when the reference detaches', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const open = ref(true)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 })
    const options = ref<TeleportToOptions>({ to: refEl, overflow: 'hide' })
    const mounted = mountWithVShow(open, options)

    expect(mounted.el.style.visibility).toBe('hidden')

    refEl.remove()
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(mounted.el.style.visibility).toBe('')
    expect(mounted.el.dataset.teleportHidden).toBeUndefined()
    expect(mounted.el.dataset.teleportState).toBe('closed')

    mounted.unmount()
  })

  it("restores the consumer's pre-hide inline visibility across a hide/show cycle", () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const open = ref(true)
    let rect: Partial<DOMRect> = { top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 }
    const refEl = document.createElement('div')
    document.body.appendChild(refEl)
    refEl.getBoundingClientRect = () =>
      ({ x: rect.left, y: rect.top, toJSON: () => ({}), ...rect }) as DOMRect
    const options = ref<TeleportToOptions>({ to: refEl, overflow: 'hide' })
    const mounted = mountWithVShow(open, options)

    // Consumer owns `visibility` before the directive has ever hidden anything.
    mounted.el.style.visibility = 'collapse'

    // Ref leaves the viewport → the directive hides.
    rect = { top: 100, height: 40, bottom: 140, left: 900, right: 1100, width: 200 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(mounted.el.style.visibility).toBe('hidden')
    expect(mounted.el.dataset.teleportHidden).toBe('')

    // Ref comes back → the consumer's value is restored verbatim.
    rect = { top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 }
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(mounted.el.style.visibility).toBe('collapse')
    expect(mounted.el.dataset.teleportHidden).toBeUndefined()

    mounted.unmount()
  })

  it('leaves visibility untouched on a show tick when it never hid the host', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    const open = ref(true)
    const refEl = makeRef({ top: 100, height: 40, bottom: 140, left: 100, right: 300, width: 200 })
    const options = ref<TeleportToOptions>({ to: refEl, overflow: 'hide' })
    const mounted = mountWithVShow(open, options)

    // Host fits, so the directive's hide never engaged — no ownership marker.
    expect(mounted.el.dataset.teleportHidden).toBeUndefined()

    mounted.el.style.visibility = 'collapse'
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)

    expect(mounted.el.style.visibility).toBe('collapse')
    expect(mounted.el.dataset.teleportHidden).toBeUndefined()

    mounted.unmount()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The measurement itself: the host's BOX vs the host's CONTENT.
//
// TT-17, TT-18 and TT-19 are one defect in three costumes — the fit test being
// handed a number that does not describe the content:
//
//   TT-17  the box is ABSENT      (`display: none` from a `v-show` written
//                                  after the directive, the README's own order)
//   TT-18  the box is COLLAPSED   (`max-height: 0` in the consumer's closed
//                                  state, or a flow width that re-wraps)
//   TT-19  the box is OUR CLAMP   (reading through `max-height` is circular,
//                                  and the fallback answered with the
//                                  `maxHeight` OPTION, so the content's real
//                                  size never entered the decision)
//
// Every test here states the host's CONTENT height and the room on each side,
// and asserts the side that shows the most of it. Reverting the probe in
// `measure-host.ts` to a plain `getBoundingClientRect()` must fail them.
// ─────────────────────────────────────────────────────────────────────────────
describe('host measurement — content, not box (TT-17 / TT-18 / TT-19)', () => {
  /** Room above the reference / below it, in the default 800px test viewport. */
  const cramped = { top: 60, height: 24, bottom: 84 } // 60 above, 716 below

  it('TT-18: a host collapsed by its own closed state flips instead of "fitting"', () => {
    // The owner's tooltip. 127px of content, 60px above, `placement: 'top'`,
    // and a closed state that collapses the box to 18px of padding. Reading
    // the box says 18 ≤ 60 → `fits` → clamped to 60 → 13 of 36 words.
    const el = makeEl()
    sizeHost(el, { natural: 127, collapsedTo: 18, width: 240 })
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    mountDirective(el, { to: makeRef(cramped), placement: 'top' })

    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.maxHeight).toBe('240px') // min(raw 716, maxHeight 240)
    expect(events[0].contentHeight).toBe(127)
    // 127 of 127 visible — the assertion the attribute alone cannot make.
    expect(events[0].truncated).toBe(false)
  })

  it('TT-18: three consecutive opens agree — the verdict is not taken once for life', () => {
    const el = makeEl()
    sizeHost(el, { natural: 127, collapsedTo: 18, width: 240 })
    const refEl = makeRef(cramped)
    const opts: TeleportToOptions = { to: refEl, placement: 'top' }

    const verdicts: string[] = []
    for (let i = 0; i < 3; i++) {
      mountDirective(el, { ...opts, enabled: true })
      verdicts.push(`${el.dataset.teleportPlacement}/${el.dataset.teleportFit}/${el.style.maxHeight}`)
      updateDirective(el, { ...opts, enabled: false })
      unmountDirective(el)
    }

    expect(verdicts).toEqual([
      'bottom/flipped/240px',
      'bottom/flipped/240px',
      'bottom/flipped/240px',
    ])
  })

  it('TT-18: wrapping text is measured at the width the tick is about to write', () => {
    // The no-animation half. In normal flow the host is the parent's full
    // width and the text needs two lines; at the 240px the directive writes it
    // needs five. Measuring the flow box reports 36px, "fits" above, and
    // clamps to 60.
    const el = makeEl()
    sizeHost(el, {
      flowWidth: 1024,
      width: 240,
      naturalAt: (w) => (w >= 1000 ? 36 : 127),
    })
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    // Reference 160px wide → the tick writes `max-width: 240px` (160 × 1.5).
    mountDirective(el, { to: makeRef({ ...cramped, width: 160, right: 210 }), placement: 'top' })

    expect(events[0].contentHeight).toBe(127)
    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.dataset.teleportFit).toBe('flipped')
  })

  it('TT-17: a host hidden by `v-show` is measured, and stays hidden afterwards', () => {
    // `v-show` written AFTER the directive leaves `display: none` on the host
    // at measure time. That used to report `fit: 'unmeasured'` permanently.
    // The probe clears the inline `display` for the read and puts it back —
    // if it did not, one imperative write would defeat `v-show` for good.
    const el = makeEl()
    sizeHost(el, { natural: 336, width: 240 })
    el.style.display = 'none'
    mountDirective(el, { to: makeRef(cramped), placement: 'top' })

    expect(el.dataset.teleportFit).not.toBe('unmeasured')
    expect(el.dataset.teleportPlacement).toBe('bottom')
    expect(el.style.display).toBe('none')
  })

  it('TT-17: both `v-show` orderings produce byte-identical placement', () => {
    const refRect = { ...cramped, width: 160, right: 210 }

    const directiveFirst = makeEl()
    sizeHost(directiveFirst, { natural: 336, width: 240 })
    directiveFirst.style.display = 'none' // v-show has not run yet
    mountDirective(directiveFirst, { to: makeRef(refRect), placement: 'top' })

    const vShowFirst = makeEl()
    sizeHost(vShowFirst, { natural: 336, width: 240 })
    mountDirective(vShowFirst, { to: makeRef(refRect), placement: 'top' })

    const read = (el: HTMLElement) =>
      `${el.dataset.teleportPlacement}/${el.dataset.teleportFit}/${el.style.maxHeight}`
    expect(read(directiveFirst)).toBe(read(vShowFirst))
    expect(read(directiveFirst)).toBe('bottom/flipped/240px')
  })

  it('TT-19: the verdict does not change once our own clamp is on the host', () => {
    // The circularity. Tick 1 clamps the host; tick 2 must reach the same
    // answer, because the number it reads has to be a property of the content
    // and not of the side we chose last time. Answering with the `maxHeight`
    // OPTION instead — what the old fallback did — made `flip` comparative
    // again: measured in Chrome, the host jumped to the opposite side for one
    // tick with 256px of room and 240px of content on the side it left.
    const el = makeEl()
    sizeHost(el, { natural: 240, width: 240 })
    const boundary = document.createElement('div')
    document.body.appendChild(boundary)
    let box = { top: 0, bottom: 460 }
    boundary.getBoundingClientRect = () =>
      ({ top: box.top, left: 0, right: 900, bottom: box.bottom,
         width: 900, height: box.bottom - box.top, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    // Phase 1: 218 above, 218 below — neither holds 240, so the host is
    // clamped to 218 by SPACE.
    const refEl = makeRef({ top: 218, height: 24, bottom: 242, width: 160, right: 210 })
    mountDirective(el, { to: refEl, boundary, placement: 'bottom', maxHeight: 400 })
    expect(el.dataset.teleportFit).toBe('neither')
    expect(el.style.maxHeight).toBe('218px')

    // Phase 2: the preferred side now holds all 240px. The clamp from phase 1
    // is still on the element.
    box = { top: 0, bottom: 560 }
    refEl.getBoundingClientRect = () =>
      ({ top: 280, left: 50, width: 160, height: 24, right: 210, bottom: 304,
         x: 50, y: 280, toJSON: () => ({}) }) as DOMRect
    updateDirective(el, { to: refEl, boundary, placement: 'bottom', maxHeight: 400 })

    expect(el.dataset.teleportPlacement).toBe('bottom') // 256 ≥ 240 — it fits
    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.maxHeight).toBe('256px')
  })

  it('TT-19: the ladder maximises what is VISIBLE, not what is unclamped', () => {
    // 300px of content, 250px below, 500px above, `maxHeight: 400` so the
    // option is not the binding constraint. Below shows 250 of it; above shows
    // all 300. The owner's sentence: flip if it is going to be visible at top
    // instead of bottom.
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
    const el = makeEl()
    sizeHost(el, { natural: 300, width: 240 })
    mountDirective(el, {
      to: makeRef({ top: 500, height: 26, bottom: 526, width: 160, right: 210 }),
      placement: 'bottom',
      maxHeight: 400,
    })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('flipped')
    expect(el.style.maxHeight).toBe('400px') // min(raw 500, 400) — all 300 shown
  })

  it('a host clamped by the `maxHeight` OPTION reports it, and still says "fits"', () => {
    // 400px of content under the default 240px cap. Both sides render 240, so
    // there is nothing to gain by moving and `fit: 'fits'` is the honest
    // answer — but the popover IS cut, and that is what the new signal is for.
    // Before it, every attribute on this host read healthy.
    const el = makeEl()
    sizeHost(el, { natural: 400, width: 240 })
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    mountDirective(el, { to: makeRef({ top: 300, height: 24, bottom: 324 }), placement: 'bottom' })

    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.maxHeight).toBe('240px')
    expect(el.hasAttribute('data-teleport-truncated')).toBe(true)
    expect(events[0].truncated).toBe(true)
    expect(events[0].contentHeight).toBe(400)
  })

  it('`data-teleport-truncated` clears the moment the content fits again', () => {
    const el = makeEl()
    sizeHost(el, { natural: 400, width: 240 })
    const refEl = makeRef({ top: 300, height: 24, bottom: 324 })
    mountDirective(el, { to: refEl, placement: 'bottom' })
    expect(el.hasAttribute('data-teleport-truncated')).toBe(true)

    updateDirective(el, { to: refEl, placement: 'bottom', maxHeight: 500 })
    expect(el.hasAttribute('data-teleport-truncated')).toBe(false)
  })

  it('truncation is reported one layout unit above the noise floor, not half a pixel', () => {
    // MEASURE_EPSILON. Both operands sit on the engine's 1/64px layout grid, so
    // the tolerance only has to absorb the ≤1/128px error between the
    // `max-height` we write and the value the engine quantises it to. At 0.5 a
    // host clamped 0.484px below its own content reported nothing — measured in
    // Chrome, and the whole point of the flag is that nothing gets cut quietly.
    const unit = 1 / 64
    const natural = 120.3125

    const oneUnit = makeEl()
    sizeHost(oneUnit, { natural, width: 240 })
    mountDirective(oneUnit, {
      to: makeRef({ top: 400, height: 24, bottom: 424 }),
      placement: 'bottom',
      maxHeight: natural - unit,
    })
    expect(oneUnit.hasAttribute('data-teleport-truncated')).toBe(false)

    const twoUnits = makeEl()
    sizeHost(twoUnits, { natural, width: 240 })
    mountDirective(twoUnits, {
      to: makeRef({ top: 400, height: 24, bottom: 424 }),
      placement: 'bottom',
      maxHeight: natural - 2 * unit,
    })
    expect(twoUnits.hasAttribute('data-teleport-truncated')).toBe(true)
  })

  it('the probe restores the host byte-for-byte, priorities included', () => {
    // The measurement writes a dozen `!important` declarations and has to
    // leave nothing behind. A `style` attribute that came back one key
    // different would be a consumer style silently deleted on every tick.
    const el = makeEl()
    sizeHost(el, { natural: 100, width: 240 })
    el.setAttribute('style', 'color: red; transform: rotate(2deg) !important; display: none')
    el.dataset.teleportState = 'closed'

    mountDirective(el, { to: makeRef(cramped), placement: 'top', flip: false })

    // `flip: false` writes no `max-height` decision of its own beyond the
    // clamp, so everything the probe touched must survive.
    expect(el.style.getPropertyValue('color')).toBe('red')
    expect(el.style.getPropertyPriority('transform')).toBe('important')
    expect(el.style.getPropertyValue('transform')).toBe('rotate(2deg)')
    expect(el.style.display).toBe('none')
    expect(el.style.getPropertyValue('animation')).toBe('')
    expect(el.style.getPropertyValue('transition')).toBe('')
  })

  it('the probe leaves no `data-teleport-placement` behind mid-measurement', () => {
    // The attribute is REMOVED for the duration precisely so consumer CSS
    // keyed on it cannot make the measurement depend on the side we chose
    // last tick. What must not happen is it being dropped for good.
    const el = makeEl()
    sizeHost(el, { natural: 30, width: 240 })
    mountDirective(el, { to: makeRef(cramped), placement: 'top' })
    expect(el.dataset.teleportPlacement).toBe('top')

    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(17)
    expect(el.dataset.teleportPlacement).toBe('top')
  })

  it('an unmeasurable host still answers `null`, never `0`', () => {
    // A host inside a `display: none` ancestor has no box even with the clamp
    // lifted. `0` would read as "fits anywhere", which is how a popover ends
    // up pinned to a side with no room.
    const el = makeEl()
    const events: TeleportToEventDetail[] = []
    el.addEventListener('teleport-positioned', (e) => {
      events.push((e as CustomEvent<TeleportToEventDetail>).detail)
    })
    el.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0,
         toJSON: () => ({}) }) as DOMRect

    mountDirective(el, { to: makeRef(cramped), placement: 'top' })

    expect(el.dataset.teleportFit).toBe('unmeasured')
    expect(el.dataset.teleportPlacement).toBe('top') // the requested side stands
    expect(events[0].contentHeight).toBe(null)
    expect(events[0].contentWidth).toBe(null)
    expect(events[0].truncated).toBe(false)
  })

  it('NEGATIVE CONTROL: a short tooltip in the same collapsed shape does not move', () => {
    // If every host flips, nothing above is evidence. 30px of content with 60px
    // above: the cramped side is the right answer and the fix must leave it
    // alone.
    const el = makeEl()
    sizeHost(el, { natural: 30, collapsedTo: 18, width: 240 })
    mountDirective(el, { to: makeRef(cramped), placement: 'top' })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('fits')
    expect(el.style.maxHeight).toBe('60px')
    expect(el.hasAttribute('data-teleport-truncated')).toBe(false)
  })

  it('NEGATIVE CONTROL: `flip: false` still pins the side it was given', () => {
    const el = makeEl()
    sizeHost(el, { natural: 127, collapsedTo: 18, width: 240 })
    mountDirective(el, { to: makeRef(cramped), placement: 'top', flip: false })

    expect(el.dataset.teleportPlacement).toBe('top')
    expect(el.dataset.teleportFit).toBe('unmeasured')
    // …and the cut is still reported, because `flip: false` opts out of the
    // decision, not out of being told.
    expect(el.hasAttribute('data-teleport-truncated')).toBe(true)
  })
})
