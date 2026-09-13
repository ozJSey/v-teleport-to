/**
 * Build entry point — re-exports the public surface from `src/`.
 *
 * Splitting kept the module structure honest (constants/types/calc/scheduler/
 * directive) without changing the bundle output: tsup follows this single
 * entry, tree-shakes, and emits one minified ESM file.
 */

export {
  vTeleportTo,
  default,
  TeleportToPlugin,
  DIRECTIVE_NAME,
  useTeleportTo,
} from './src'
export type {
  TeleportToOptions,
  TeleportToEventDetail,
  TeleportToFit,
  TeleportToSide,
  UseTeleportToReturn,
  TeleportToStyles,
  VirtualReference,
} from './src'
