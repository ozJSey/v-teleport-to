/**
 * Composable form of the teleport-to behavior.
 *
 * Use this when the directive is impractical — for example, when the host
 * element lives inside a `<Teleport to="body">` slot or is otherwise rendered
 * outside the component's own template, where binding `v-teleport-to` directly
 * is awkward.
 *
 * The composable exposes a reactive `styles` ref that the consumer applies via
 * `:style="styles"`. It listens to `scroll` / `resize` (RAF-batched, capture
 * phase) and re-computes styles when the supplied options change — and again
 * after the render step those option changes caused, because the measurement
 * has to be taken against the DOM Vue has already patched. See "When the
 * recalc runs" further down for why there are three triggers and not one.
 *
 * ## Pass the host
 *
 * The second argument is the host element — a template ref is the usual shape.
 * The directive always knows its host; this composable did not, and two
 * documented behaviours quietly degraded because of it:
 *
 *   - the fit test had nothing to measure, so `fit` was always `'unmeasured'`
 *     and placement fell back to the comparative rule;
 *   - `strategy: 'absolute'` had no `offsetParent` to resolve against, so it
 *     emitted viewport coordinates which the browser then resolved against the
 *     offsetParent anyway — landing the host hundreds of px from the reference.
 *
 * Both work once the host is passed. Omitting it is still supported and still
 * degrades the same way; the degradation is now opt-in rather than structural.
 *
 * Cleanup is handled automatically via `onScopeDispose` — the composable can
 * be called inside a Vue component or any explicit `effectScope`.
 */

import {
  getCurrentInstance,
  onScopeDispose,
  onUpdated,
  toValue,
  watchEffect,
  ref,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'
import { createObservers, disconnectObservers, syncObservers } from './auto-update'
import { computePositionStyles, type TeleportToStyles } from './calculate-position'
import { invokePlacementChange } from './placement-change'
import {
  diffScrollTargets,
  resolveScrollTargets,
  SCROLL_LISTENER_OPTIONS,
  SCROLL_REMOVE_OPTIONS,
} from './scroll-target'
import type { TeleportToFit, TeleportToOptions, TeleportToSide } from './types'

/**
 * Shallow equality over two style records.
 *
 * Every calculation builds a FRESH record, and a ref assigned a new object
 * triggers whatever its contents are — so the post-render re-measure below
 * would re-render the component, which would re-run the re-measure, which
 * would re-render it again. Comparing before assigning is what closes that
 * loop: the second pass over an unchanged DOM produces an equal record,
 * assigns nothing, and the cycle ends after one correction. It also makes a
 * scroll or resize that does not move the host cost zero re-renders, which the
 * directive got for free by writing `el.style` directly.
 */
const sameStyles = (a: TeleportToStyles, b: TeleportToStyles): boolean => {
  const keys = Object.keys(a) as (keyof TeleportToStyles)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

export type UseTeleportToReturn = {
  /** Inline styles to bind via `:style="styles"`. Empty object until the first
   *  successful calculation, and again whenever the composable goes dormant —
   *  `enabled: false`, or a `to` that resolves to null/detached. */
  styles: Ref<TeleportToStyles>
  /** Chosen placement after the most recent calculation, or `null` if disabled
   *  or if the reference element is missing/detached. */
  placement: Ref<TeleportToSide | null>
  /** Available space (px) on the chosen side. `0` until the first calculation. */
  availableSpace: Ref<number>
  /** Available space (px) on the other side of the same axis — the one that
   *  was not chosen. `0` until the first calculation. */
  oppositeSpace: Ref<number>
  /**
   * Outcome of the fit test on the most recent calculation.
   *
   * `'unmeasured'` unless you passed the host element as the composable's
   * second argument: the fit test needs the host's extent along the placement
   * axis, and without it placement falls back to the comparative rule (the
   * same reason `strategy: 'absolute'` degrades without a host).
   */
  fit: Ref<TeleportToFit>
  /** Effective `maxHeight` (px) — clamped by the available space. */
  maxHeight: Ref<number>
  /**
   * Whether `maxHeight` came out at `0` — the chosen side has no room at all
   * and the host would paint as nothing but its own padding. Mirrors the
   * directive's `data-teleport-collapsed`.
   */
  collapsed: Ref<boolean>
  /**
   * Whether the host's content is taller than the `maxHeight` being applied —
   * the host is not short, it is cut. Mirrors the directive's
   * `data-teleport-truncated`.
   *
   * Separate from `fit` because `fit` cannot carry it: a host clamped by your
   * own `maxHeight` fits on both sides and is cut on both, so `'fits'` is the
   * correct answer and a useless one. Always `false` without a host argument —
   * there is nothing to measure.
   */
  truncated: Ref<boolean>
  /**
   * The host's own width (px) under this tick's width constraints, with no
   * side coordinate squeezing it — the number the horizontal fit test used.
   * `null` when there is no host to measure, or when it has no box even with
   * the clamp lifted.
   */
  contentWidth: Ref<number | null>
  /**
   * The host's own height (px) at `contentWidth`, with no `max-height` in the
   * way — the number the vertical fit test used. `contentHeight > maxHeight`
   * is exactly `truncated`. `null` on the same terms as `contentWidth`.
   */
  contentHeight: Ref<number | null>
  /**
   * Whether the reference element was fully out of view on the most recent
   * calculation — the raw measurement, reported whether or not
   * `hideWhenReferenceHidden` is on. Bind a `v-if` to this when you want the
   * host unmounted rather than merely invisible. `false` while disabled or
   * while `to` resolves to null/detached.
   */
  referenceHidden: Ref<boolean>
  /**
   * Whether `styles` carries `visibility: 'hidden'` on the most recent
   * calculation — from EITHER `hideWhenReferenceHidden` or `overflow: 'hide'`.
   * Read alongside `referenceHidden` to tell the two apart.
   */
  hidden: Ref<boolean>
  /**
   * Lifecycle state mirror of the directive's `data-teleport-state` attribute:
   * `'open'` after a successful position calc; `'closed'` while disabled or
   * while `to` resolves to null/detached. Bind via
   * `:data-teleport-state="state"` (or any attr name) to enable
   * `[data-teleport-state="open"]`-style CSS open/close animations on the
   * host. Initial value is `'closed'`.
   */
  state: Ref<'open' | 'closed'>
  /** Force an immediate re-calculation, e.g. after a manual layout change. */
  update: () => void
}

export function useTeleportTo(
  options: MaybeRefOrGetter<TeleportToOptions>,
  host?: MaybeRefOrGetter<HTMLElement | null | undefined>,
): UseTeleportToReturn {
  const styles = ref<TeleportToStyles>({}) as Ref<TeleportToStyles>
  const placement = ref<TeleportToSide | null>(null)
  const availableSpace = ref(0)
  const oppositeSpace = ref(0)
  const fit = ref<TeleportToFit>('unmeasured')
  const maxHeight = ref(0)
  const collapsed = ref(false)
  const truncated = ref(false)
  const contentWidth = ref<number | null>(null)
  const contentHeight = ref<number | null>(null)
  const referenceHidden = ref(false)
  const hidden = ref(false)
  // Mirrors the directive's `data-teleport-state`. Initial 'closed' so a
  // consumer's CSS `[data-teleport-state="open"]` rule is inert until the
  // first successful calc fires.
  const state = ref<'open' | 'closed'>('closed')

  let rafId: number | null = null
  // Closure-local previous-placement cache mirrors the directive's
  // `DirectiveState.prevPlacement`. Reset to `null` when the composable enters
  // a no-calc branch (`enabled: false` or `to` resolves to null/detached) so
  // the next successful tick re-fires `onPlacementChange` with `prev: null`.
  let prevPlacement: TeleportToSide | null = null
  // `autoUpdate` observer bag. Mirrors the directive's per-element fields —
  // here it lives in the closure for the duration of the effect scope.
  const observers = createObservers()
  // Currently-attached scroll targets (mirrors `DirectiveState.scrollTargets`).
  // Tracked so that mutating `opts.scrollContainer` mid-life can diff against
  // the next resolved set and only detach removed targets / attach added ones,
  // without disturbing listeners on retained targets.
  let scrollTargets: EventTarget[] = []

  const syncScrollTargets = (opts: TeleportToOptions): void => {
    if (typeof window === 'undefined') return
    const next = resolveScrollTargets(opts)
    const { toAdd, toRemove } = diffScrollTargets(scrollTargets, next)
    for (const t of toRemove) {
      t.removeEventListener('scroll', schedule, SCROLL_REMOVE_OPTIONS)
    }
    for (const t of toAdd) {
      t.addEventListener('scroll', schedule, SCROLL_LISTENER_OPTIONS)
    }
    scrollTargets = next
  }

  /**
   * Every output back to its dormant value — the composable's whole answer to
   * "this host is not being positioned right now".
   *
   * ONE function for BOTH dormant branches (`enabled: false` and a `to` that
   * resolves to null/detached), because they are the same state and listing
   * them twice is how they drifted: the detached branch reset seven of the
   * thirteen and left `styles` untouched, so a host hidden by
   * `hideWhenReferenceHidden` on the previous tick stayed `visibility: hidden`
   * in the record the consumer binds while `hidden` reported `false` — an
   * invisible popover with every signal saying it was fine. It is the
   * composable's equivalent of the directive's `releaseHide` +
   * `clearPositionAttributes`, and the reason it can go further than the
   * directive (which leaves `el.style.top` where it was) is that the record IS
   * ours: `{}` is the honest way to say we are asserting nothing.
   *
   * `styles` is compared before assigning — `{}` is a fresh object every time,
   * and a ref handed a new object always triggers. Assigning unconditionally
   * is enough on its own to make the post-render re-measure recurse forever on
   * a host that is merely disabled.
   */
  const goDormant = (): void => {
    if (Object.keys(styles.value).length > 0) styles.value = {}
    placement.value = null
    availableSpace.value = 0
    oppositeSpace.value = 0
    fit.value = 'unmeasured'
    maxHeight.value = 0
    collapsed.value = false
    truncated.value = false
    contentWidth.value = null
    contentHeight.value = null
    referenceHidden.value = false
    hidden.value = false
    state.value = 'closed'
    prevPlacement = null
    // Drop any auto-update observers: a dormant host keeps no subscription on
    // an element it is no longer tracking.
    disconnectObservers(observers)
  }

  const update = (): void => {
    const opts = toValue(options)
    if (!opts) return

    // Sync the scroll listener targets FIRST so an early return (disabled,
    // missing/detached `to`) still keeps the listeners live and ready to
    // recompute when the upstream option flips back.
    syncScrollTargets(opts)

    if (opts.enabled === false) {
      goDormant()
      return
    }

    // `toValue` here is what makes a template ref that is null on the first
    // render pass — the normal path — re-run this effect once Vue populates it.
    const result = computePositionStyles(opts, toValue(host))
    if (!result) {
      goDormant()
      return
    }

    // Compared, not merely assigned — see `sameStyles`. The post-render
    // re-measure below only terminates because an unchanged answer is silent.
    if (!sameStyles(styles.value, result.styles)) styles.value = result.styles
    placement.value = result.detail.placement
    availableSpace.value = result.detail.availableSpace
    oppositeSpace.value = result.detail.oppositeSpace
    fit.value = result.detail.fit
    maxHeight.value = result.detail.maxHeight
    collapsed.value = result.detail.collapsed
    truncated.value = result.detail.truncated
    contentWidth.value = result.detail.contentWidth
    contentHeight.value = result.detail.contentHeight
    referenceHidden.value = result.detail.referenceHidden
    hidden.value = result.detail.hidden
    state.value = 'open'

    // Optional consumer callback — same try/catch posture as the directive
    // so a misbehaving callback cannot break the reactive update path.
    if (opts.onPositioned) {
      try {
        opts.onPositioned(result.detail)
      } catch (err) {
        console.error('[useTeleportTo] onPositioned callback threw:', err)
      }
    }

    // Placement-change callback — fires only on actual transitions.
    invokePlacementChange(opts, prevPlacement, result.detail.placement)
    prevPlacement = result.detail.placement

    // Sync auto-update observers — picks up `autoUpdate` toggles and `to`
    // changes between option mutations. No-op when the resolved element is
    // the same as the currently observed one.
    syncObservers(observers, opts, schedule)
  }

  const schedule = (): void => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      update()
    })
  }

  // ── When the recalc runs ───────────────────────────────────────────────────
  //
  // Three triggers, because the composable has three ways to go stale and no
  // one of them subsumes the others. The directive needs only `updated`; it is
  // handed its host by Vue and writes `el.style` directly, so it never has to
  // ask when the DOM is ready or worry about feeding its own output back in.
  //
  // 1. SYNC, on the options/host dependencies.
  //    A consumer mutating an options ref sees `styles` updated in the same
  //    tick, with no render step in between. That property is real and worth
  //    keeping — a `maxHeight` bumped in an event handler should be readable on
  //    the next line.
  //
  // 2. POST, on the same dependencies.
  //    …because (1) alone is measured against the PREVIOUS frame's DOM, and
  //    that was a P0. `enabled: open` paired with `v-if` on the host's contents
  //    — the shape this README recommends — changes an option and the host's
  //    content in ONE reactive tick: the sync pass measures the host before Vue
  //    has patched the contents in, finds 10px of padding, decides the cramped
  //    side "fits", and writes a `max-height` sliver that never self-corrects.
  //    Every signal it hands you reads healthy while it does. The post pass
  //    re-reads the same dependencies after the patch and overwrites the
  //    answer; `sameStyles` makes it silent whenever the sync pass was already
  //    right (a plain option mutation with no DOM change).
  //
  // 3. `onUpdated`, i.e. every re-render of the owning component.
  //    The other face of the same defect: a reference that MOVES through
  //    reactive state the options getter never reads — a spacer's height, a
  //    sibling's `v-if` — changes no dependency of (1) or (2), so neither of
  //    them re-runs and the host stays where it was indefinitely. This is
  //    exactly the directive's `updated` hook, and it is what makes the
  //    composable track a moving reference the way the directive does.
  //    Registered only inside a component; an `effectScope` with no instance
  //    has no render step to hook, and keeps (1) + (2).
  //
  // `autoUpdate: true` incidentally papered over both faces, because its
  // observer callbacks land after the patch. It is off by default and is
  // documented as covering what scroll/resize miss — never as the price of the
  // composable seeing its own host.
  //
  // WHY (2) AND (3) TERMINATE. Both write `styles`, which the consumer binds,
  // which renders, which runs (3) again — so this only converges because the
  // second pass over an unchanged DOM produces an equal record and `sameStyles`
  // swallows it. That in turn rests on the measurement being a property of the
  // CONTENT and not of the answer: `measure-host.ts` lifts our own `max-height`
  // and deletes `data-teleport-placement` before it reads, so the host cannot
  // report a different size because of where we just put it. If that invariant
  // is ever weakened, this stops being a one-frame correction and becomes a
  // render loop — Vue bails out with "Maximum recursive updates exceeded", and
  // a browser check on playground card 11 exists to catch it.
  const recalc = (): void => {
    toValue(options) // collect deps
    toValue(host) // …and the host, so a late template ref re-runs the calc
    update()
  }
  watchEffect(recalc, { flush: 'sync' })
  watchEffect(recalc, { flush: 'post' })
  if (getCurrentInstance()) onUpdated(update)

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', schedule, { passive: true })
  }

  onScopeDispose(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', schedule)
    }
    for (const t of scrollTargets) {
      t.removeEventListener('scroll', schedule, SCROLL_REMOVE_OPTIONS)
    }
    scrollTargets = []
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    // Disconnect any auto-update observers attached during the scope's life.
    disconnectObservers(observers)
  })

  return {
    styles,
    placement,
    availableSpace,
    oppositeSpace,
    fit,
    maxHeight,
    collapsed,
    truncated,
    contentWidth,
    contentHeight,
    referenceHidden,
    hidden,
    state,
    update,
  }
}
