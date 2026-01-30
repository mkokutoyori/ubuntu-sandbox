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

// Servers
export { LinuxServer } from './LinuxServer';
export { WindowsServer } from './WindowsServer';

// Cisco devices
export { CiscoRouter } from './CiscoRouter';
export { CiscoSwitch } from './CiscoSwitch';
export { CiscoL3Switch } from './CiscoL3Switch';
export { CiscoASA } from './CiscoASA';

// Security devices
export { Firewall } from './Firewall';

// Wireless devices
export { AccessPoint } from './AccessPoint';
export { WirelessController } from './WirelessController';

// Infrastructure
export { Cloud } from './Cloud';
export { MultilayerSwitch } from './MultilayerSwitch';

// End devices
export { IPPhone } from './IPPhone';
export { Printer } from './Printer';

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

// EthernetConnection - Active connection class
export { EthernetConnection } from '../network/EthernetConnection';
export type { ConnectionEvent, ConnectionEventListener, EthernetConnectionConfig } from '../network/EthernetConnection';

export {
  generateId,
  generateDeviceId,
  generateInterfaceName,
  resetDeviceCounters,
  DEVICE_CATEGORIES
} from './types';
