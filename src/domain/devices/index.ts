/**
 * Domain Devices - Unified export
 *
 * Exports all device classes, types, and utilities
 * for both network simulation and UI
 */

// Base classes
export { BaseDevice } from './BaseDevice';
export type { DeviceType, DeviceStatus, DeviceJSON } from './BaseDevice';

// Core network devices
export { PC } from './PC';
export { Switch } from './Switch';
export { Router } from './Router';
export { Hub } from './Hub';
export { NetworkInterface } from './NetworkInterface';

// OS-specific devices
export { LinuxPC } from './LinuxPC';
export { WindowsPC } from './WindowsPC';

// Cisco devices
export { CiscoRouter } from './CiscoRouter';
export { CiscoSwitch } from './CiscoSwitch';
export { CiscoL3Switch } from './CiscoL3Switch';

// Cisco device union type (for backwards compatibility with UI)
import type { CiscoRouter } from './CiscoRouter';
import type { CiscoSwitch } from './CiscoSwitch';
import type { CiscoL3Switch } from './CiscoL3Switch';
export type CiscoDevice = CiscoRouter | CiscoSwitch | CiscoL3Switch;

// Factory
export { DeviceFactory } from './DeviceFactory';

// Types and utilities
export type {
  DeviceConfig,
  NetworkInterfaceConfig,
  Connection,
  ConnectionType,
  OSType,
  DeviceCategory
} from './types';

export {
  generateId,
  generateDeviceId,
  generateInterfaceName,
  resetDeviceCounters,
  DEVICE_CATEGORIES
} from './types';
