/**
 * Shared helper for invoking the optional `onPlacementChange` callback.
 *
 * Centralises the diff-and-fire-and-catch logic so the directive lifecycle
 * hooks, the RAF-batched scheduler, and the `useTeleportTo` composable all
 * agree on when (and how safely) the callback runs.
 *
 * The function is a no-op when:
 *   - no callback is configured, OR
 *   - the new placement is identical to the previous one (so consumers only
 *     hear about actual transitions, never about same-side re-positions
 *     driven by scroll/resize within the chosen side).
 *
 * A throwing callback is caught and logged via `console.error` so a
 * misbehaving consumer cannot break the directive's RAF loop or the
 * composable's reactive update path.
 */

import type { TeleportToOptions } from './types'

export function invokePlacementChange(
  opts: TeleportToOptions,
  prev: 'top' | 'bottom' | 'left' | 'right' | null,
  next: 'top' | 'bottom' | 'left' | 'right',
): void {
  if (!opts.onPlacementChange) return
  if (prev === next) return
  try {
    opts.onPlacementChange(prev, next)
  } catch (err) {
    console.error('[v-teleport-to] onPlacementChange callback threw:', err)
  }
}
