/**
 * Port-number domain — barrel export.
 *
 * The cross-OS model of transport-layer port numbers: the {@link PortNumber}
 * value object, the IANA service-name registry ({@link IanaServiceRegistry})
 * that backs `/etc/services`, and the privileged-port {@link PortBindingPolicy}.
 * Shared by the Linux and Windows device stacks.
 */

export {
  PortNumber,
  PortClass,
  MIN_PORT,
  MAX_PORT,
  PRIVILEGED_PORT_CEILING,
  FIRST_DYNAMIC_PORT,
} from './PortNumber';
export type { TransportProtocol, PortSpec } from './PortNumber';

export { IanaServiceRegistry } from './IanaServiceRegistry';
export type { ServicePortDefinition } from './IanaServiceRegistry';

export { PortBindingPolicy } from './PortBindingPolicy';
export type {
  BindingPlatform,
  BindActor,
  BindVerdict,
  PortBindingPolicyInit,
} from './PortBindingPolicy';
