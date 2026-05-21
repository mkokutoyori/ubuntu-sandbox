/**
 * Host lifecycle — public surface.
 *
 * The power & boot state machine shared by Linux and Windows hosts. See
 * `HostLifecycle` for the model and `HostPowerState` for the state set.
 */

export { HostLifecycle, type HostPowerState } from './HostLifecycle';
