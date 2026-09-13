/**
 * v-teleport-to — public entry point.
 *
 * Vue 3 directive for viewport-aware fixed positioning relative to a
 * reference element. Escapes overflow/clip containers — useful for
 * dropdowns, popovers, and autocomplete panels.
 */

export { vTeleportTo } from './directive'
export { vTeleportTo as default } from './directive'
export { TeleportToPlugin, DIRECTIVE_NAME } from './plugin'
export { useTeleportTo, type UseTeleportToReturn } from './use-teleport-to'
export { type TeleportToStyles } from './calculate-position'
export type {
  TeleportToOptions,
  TeleportToEventDetail,
  TeleportToFit,
  TeleportToSide,
  VirtualReference,
} from './types'
