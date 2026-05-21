/**
 * Host system identity — public surface.
 *
 * A faithful, OS-agnostic model of a host's identity & configuration:
 * OS release, kernel, machine-id, time zone and locale. See
 * `SystemIdentity` for the aggregate root.
 */

export { OsRelease, type OsReleaseInit } from './OsRelease';
export { KernelInfo, type KernelInfoInit } from './KernelInfo';
export {
  SystemIdentity,
  type SystemIdentityInit,
  type ChassisClass,
} from './SystemIdentity';
