/**
 * Vue 3 plugin wrapper for v-teleport-to.
 *
 * Lets consumers register the directive globally with one line:
 *
 *   import { TeleportToPlugin } from 'v-teleport-to'
 *   app.use(TeleportToPlugin)
 *
 * The directive is registered under the kebab-case name `teleport-to`, so
 * templates use it as `v-teleport-to="..."` (Vue prepends the `v-` prefix).
 *
 * `install` is idempotent — re-registering the same directive on the same
 * App instance is a no-op for Vue, so calling `app.use(TeleportToPlugin)`
 * twice will not throw.
 */

import type { App, Plugin } from 'vue'
import { vTeleportTo } from './directive'

export const DIRECTIVE_NAME = 'teleport-to'

export const TeleportToPlugin: Plugin = {
  install(app: App) {
    app.directive(DIRECTIVE_NAME, vTeleportTo)
  },
}
