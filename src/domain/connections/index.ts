/**
 * Domain Connections - Unified export
 *
 * Exports all connection classes, types, and utilities
 * for network link simulation
 */

// Base class
export { BaseConnection } from './BaseConnection';
export type {
  ConnectionStatus,
  ConnectionEndpoint,
  ConnectionStatistics,
  FrameDeliveryCallback,
  ConnectionConfig
} from './BaseConnection';

// Connection implementations
export { EthernetConnection } from './EthernetConnection';
export type { EthernetStandard, DuplexMode, CableType } from './EthernetConnection';

export { SerialConnection } from './SerialConnection';
export type { SerialEncapsulation, SerialRole } from './SerialConnection';
export { COMMON_CLOCK_RATES } from './SerialConnection';

export { ConsoleConnection } from './ConsoleConnection';
export type { BaudRate } from './ConsoleConnection';
export { COMMON_BAUD_RATES } from './ConsoleConnection';

// Factory
export { ConnectionFactory } from './ConnectionFactory';
