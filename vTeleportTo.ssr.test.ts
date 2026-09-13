/**
 * SSR safety smoke suite.
 *
 * Runs in vitest's `environment: 'node'` (no jsdom, no `window`, no
 * `document`) to prove the library:
 *   - imports cleanly with no top-level DOM access,
 *   - the composable runs inside an `effectScope` without throwing when
 *     the reference is null or a `Ref<HTMLElement | null>` whose value
 *     is server-side `null`,
 *   - the plugin's `install` registers the directive without touching
 *     the DOM,
 *   - the directive object exposes the lifecycle hooks (Vue 3's SSR
 *     renderer never invokes them server-side, but consumers may import
 *     the symbol from a universal module).
 *
 * No jsdom: any accidental top-level `window.foo` would throw at import
 * time and fail every test in this project.
 */

import { describe, it, expect } from 'vitest'
import { effectScope, ref } from 'vue'
import {
  vTeleportTo,
  TeleportToPlugin,
  DIRECTIVE_NAME,
  useTeleportTo,
  default as defaultExport,
} from './vTeleportTo'

describe('SSR safety — node environment', () => {
  it('imports cleanly with no DOM globals', () => {
    // `globalThis.window` and `globalThis.document` should be undefined under
    // the node test environment. If any module had performed a top-level
    // `window.foo` during evaluation, the import above would have thrown
    // before this test ever ran.
    expect(typeof (globalThis as any).window).toBe('undefined')
    expect(typeof (globalThis as any).document).toBe('undefined')
    expect(vTeleportTo).toBeDefined()
    expect(useTeleportTo).toBeDefined()
    expect(TeleportToPlugin).toBeDefined()
    expect(DIRECTIVE_NAME).toBe('teleport-to')
    expect(defaultExport).toBe(vTeleportTo)
  })

  it('exposes directive lifecycle hooks without invoking them', () => {
    // Vue 3's SSR renderer does NOT call directive lifecycle hooks server-side
    // (only `getSSRProps` if defined). The hooks must still be present on the
    // object so universal modules can re-export the directive.
    expect(typeof vTeleportTo.mounted).toBe('function')
    expect(typeof vTeleportTo.updated).toBe('function')
    expect(typeof vTeleportTo.unmounted).toBe('function')
    // `getSSRProps` is intentionally not implemented — the directive renders
    // no SSR props since positioning math is meaningless server-side.
    expect((vTeleportTo as any).getSSRProps).toBeUndefined()
  })

  it('useTeleportTo does not throw with `to: null` (no DOM access)', () => {
    const scope = effectScope()
    let api: ReturnType<typeof useTeleportTo> | undefined
    expect(() => {
      scope.run(() => {
        api = useTeleportTo({ to: null })
      })
    }).not.toThrow()

    expect(api).toBeDefined()
    expect(api!.styles.value).toEqual({})
    expect(api!.placement.value).toBeNull()
    expect(api!.availableSpace.value).toBe(0)
    expect(api!.maxHeight.value).toBe(0)

    // Manual update with null `to` must remain a no-op (bails on the
    // `!parentEl || !parentEl.isConnected` guard before any window access).
    expect(() => api!.update()).not.toThrow()

    scope.stop()
  })

  it('useTeleportTo handles `to: ref(null)` server-side and disposes cleanly', () => {
    const scope = effectScope()
    const toRef = ref<HTMLElement | null>(null)
    let api: ReturnType<typeof useTeleportTo> | undefined
    expect(() => {
      scope.run(() => {
        api = useTeleportTo({ to: toRef })
      })
    }).not.toThrow()

    expect(api).toBeDefined()
    expect(api!.styles.value).toEqual({})

    // Mutating the ref should not crash either — value stays null, math bails.
    expect(() => {
      toRef.value = null
      api!.update()
    }).not.toThrow()

    // Scope disposal must not throw — the `onScopeDispose` handler also
    // guards `typeof window !== 'undefined'` before calling
    // `removeEventListener`.
    expect(() => scope.stop()).not.toThrow()
  })

  it('useTeleportTo with `enabled: false` server-side does not throw', () => {
    const scope = effectScope()
    expect(() => {
      scope.run(() => {
        const api = useTeleportTo({ to: null, enabled: false })
        api.update()
        expect(api.styles.value).toEqual({})
        expect(api.placement.value).toBeNull()
      })
    }).not.toThrow()
    scope.stop()
  })

  it('useTeleportTo with a getter resolving to null does not throw', () => {
    const scope = effectScope()
    let api: ReturnType<typeof useTeleportTo> | undefined
    expect(() => {
      scope.run(() => {
        api = useTeleportTo({ to: () => null })
      })
    }).not.toThrow()
    expect(api!.placement.value).toBeNull()
    scope.stop()
  })

  it('TeleportToPlugin.install registers the directive without DOM access', () => {
    let registeredName: string | undefined
    let registeredDirective: unknown
    const stubApp = {
      directive(name: string, dir: unknown) {
        registeredName = name
        registeredDirective = dir
        return this
      },
    }

    expect(() => TeleportToPlugin.install!(stubApp as any)).not.toThrow()
    expect(registeredName).toBe(DIRECTIVE_NAME)
    expect(registeredDirective).toBe(vTeleportTo)
  })

  it('public type-shape exports are functions/objects (no top-level evaluation crash)', () => {
    expect(typeof useTeleportTo).toBe('function')
    expect(typeof TeleportToPlugin).toBe('object')
    expect(typeof TeleportToPlugin.install).toBe('function')
    expect(typeof vTeleportTo).toBe('object')
  })
})
