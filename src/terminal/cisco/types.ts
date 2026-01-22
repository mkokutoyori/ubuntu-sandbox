/**
 * STUB FILE - will be rebuilt with TDD
 * Cisco terminal types
 */

export type CiscoMode = 'user' | 'privileged' | 'config' | 'interface' | 'line' | 'router';

export interface CiscoOutputLine {
  id: string;
  text: string;
  type?: 'normal' | 'error' | 'success' | 'warning';
  timestamp?: number;
}

export interface CiscoTerminalState {
  mode: CiscoMode;
  output: CiscoOutputLine[];
  commandHistory: string[];
  historyIndex: number;
  configContext?: string; // e.g., "interface GigabitEthernet0/0"
  runningConfig: Record<string, any>;
  startupConfig: Record<string, any>;
}

export interface CiscoConfig {
  hostname: string;
  interfaces: Record<string, InterfaceConfig>;
  routes: RouteEntry[];
  [key: string]: any;
}

export interface InterfaceConfig {
  name: string;
  ipAddress?: string;
  subnetMask?: string;
  status: 'up' | 'down' | 'administratively down';
  protocol: 'up' | 'down';
  description?: string;
}

export interface RouteEntry {
  network: string;
  mask: string;
  nextHop: string;
  metric?: number;
  interface?: string;
}

export type CiscoDeviceType = 'router' | 'switch' | 'l3-switch';

export interface RealDeviceData {
  hostname: string;
  deviceType: CiscoDeviceType;
  interfaces: Record<string, InterfaceConfig>;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
