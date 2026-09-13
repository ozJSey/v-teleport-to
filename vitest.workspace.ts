import { defineWorkspace } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest projects:
 *
 *   - `vue-3.5` / `vue-3.3` — same `vTeleportTo.test.ts` run against two
 *     Vue minor versions (default `^3.5.0` and the aliased `vue3_3@3.3.13`)
 *     to prove the directive's public API surface is portable across the
 *     supported peer-dependency range (`vue: ^3.0.0`). Both run in jsdom.
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
      include: ['vTeleportTo.test.ts', 'playground.smoke.test.ts'],
    },
  },
  {
    resolve: {
      alias: {
        vue: fileURLToPath(new URL('./node_modules/vue3_3/dist/vue.esm-bundler.js', import.meta.url)),
      },
    },
    test: {
      name: 'vue-3.3',
      environment: 'jsdom',
      include: ['vTeleportTo.test.ts', 'playground.smoke.test.ts'],
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
