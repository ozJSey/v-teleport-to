import { defineWorkspace } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest projects:
 *
 *   - `vue-3.5` / `vue-floor-3.3.0` — same `vTeleportTo.test.ts` and
 *     `playground.smoke.test.ts` run against both ends of the declared peer
 *     range: the default `^3.5.0` and the aliased `vue_floor`, pinned to the
 *     exact floor `vue@3.3.0`. The alias is pinned, not a caret: `^3.3.0`
 *     resolves to 3.5.x on a fresh install, which would make the low rung a
 *     copy of the high one.
 *
 *     3.3.0 is the floor because `toValue` is — `calculate-position.ts`,
 *     `auto-update.ts` and `use-teleport-to.ts` all import it, and it does not
 *     exist before 3.3.0. Measured, not assumed: aliased to 3.2.47, the last
 *     3.2, this rung fails 403 of its 423 tests — 386 of the 403 in
 *     `vTeleportTo.test.ts`, 17 of the 20 in `playground.smoke.test.ts`; 392 of
 *     them on `TypeError: toValue is not a function` and the rest downstream of
 *     a position that never computed.
 *
 *     What it does NOT prove, and what PEER-1 corrected the range over: that a
 *     consumer can IMPORT the package on a given Vue. Vitest's SSR transform
 *     rewrites named imports to property reads, so an export the linked Vue
 *     lacks arrives as `undefined` instead of throwing at link time. Only
 *     installing the packed tarball against a floor-version Vue tests that, and
 *     no unit run here can stand in for it.
 *
 *   - `ssr-node` — runs `vTeleportTo.ssr.test.ts` in `environment: 'node'`
 *     (no jsdom, no `window`, no `document`) to prove the library imports
 *     cleanly server-side and the composable / plugin handle the no-DOM
 *     case without throwing.
 */
export default defineWorkspace([
  {
    test: {
      name: 'vue-3.5',
      environment: 'jsdom',
      include: ['vTeleportTo.test.ts', 'vTeleportTo.convergence.test.ts', 'playground.smoke.test.ts'],
    },
  },
  {
    resolve: {
      alias: {
        vue: fileURLToPath(new URL('./node_modules/vue_floor/dist/vue.esm-bundler.js', import.meta.url)),
      },
    },
    test: {
      name: 'vue-floor-3.3.0',
      environment: 'jsdom',
      include: ['vTeleportTo.test.ts', 'vTeleportTo.convergence.test.ts', 'playground.smoke.test.ts'],
    },
  },
  {
    test: {
      name: 'ssr-node',
      environment: 'node',
      include: ['vTeleportTo.ssr.test.ts'],
    },
  },
])
