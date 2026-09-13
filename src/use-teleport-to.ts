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
 * phase) and re-computes styles when the supplied options change.
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
  onScopeDispose,
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

export type UseTeleportToReturn = {
  /** Inline styles to bind via `:style="styles"`. Empty object until the first
   *  successful calculation (or after `enabled: false` is applied). */
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

  const update = (): void => {
    const opts = toValue(options)
    if (!opts) return

    // Sync the scroll listener targets FIRST so an early return (disabled,
    // missing/detached `to`) still keeps the listeners live and ready to
    // recompute when the upstream option flips back.
    syncScrollTargets(opts)

    if (opts.enabled === false) {
      styles.value = {}
      placement.value = null
      availableSpace.value = 0
      oppositeSpace.value = 0
      fit.value = 'unmeasured'
      maxHeight.value = 0
      collapsed.value = false
      referenceHidden.value = false
      hidden.value = false
      state.value = 'closed'
      prevPlacement = null
      // Drop any auto-update observers while disabled.
      disconnectObservers(observers)
      return
    }

    // `toValue` here is what makes a template ref that is null on the first
    // render pass — the normal path — re-run this effect once Vue populates it.
    const result = computePositionStyles(opts, toValue(host))
    if (!result) {
      // No reference means no measurement — and the directive's matching
      // branch releases any hide it applied, so the composable reports the
      // same "not hidden by us" answer rather than a stale `true`.
      collapsed.value = false
      referenceHidden.value = false
      hidden.value = false
      state.value = 'closed'
      prevPlacement = null
      // `to` is missing/detached — drop observers so we don't keep a stale
      // subscription on an element no longer in play.
      disconnectObservers(observers)
      return
    }

    styles.value = result.styles
    placement.value = result.detail.placement
    availableSpace.value = result.detail.availableSpace
    oppositeSpace.value = result.detail.oppositeSpace
    fit.value = result.detail.fit
    maxHeight.value = result.detail.maxHeight
    collapsed.value = result.detail.collapsed
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

  // First run + reactivity to option changes. Sync flush so consumers see
  // updated styles immediately when they mutate the options ref — there's no
  // separate render step to wait for here.
  watchEffect(
    () => {
      toValue(options) // collect deps
      toValue(host) // …and the host, so a late template ref re-runs the calc
      update()
    },
    { flush: 'sync' },
  )

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
    referenceHidden,
    hidden,
    state,
    update,
  }
}
