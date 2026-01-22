/**
 * STUB FILE - BaseDevice for UI compatibility
 * This file contains minimal implementation to keep the UI functional
 * Real implementation will be rebuilt with TDD
 */

import { DeviceType, DeviceConfig, NetworkInterfaceConfig, generateDeviceId, generateInterfaceName } from './types';

export abstract class BaseDevice {
  protected id: string;
  protected type: DeviceType;
  protected name: string;
  protected hostname: string;
  protected x: number;
  protected y: number;
  protected interfaces: NetworkInterfaceConfig[];
  protected isPoweredOn: boolean;

  constructor(config: DeviceConfig) {
    this.id = config.id || generateDeviceId(config.type);
    this.type = config.type;
    this.name = config.name || this.id;
    this.hostname = config.hostname || this.id;
    this.x = config.x || 0;
    this.y = config.y || 0;
    this.interfaces = config.interfaces || this.createDefaultInterfaces();
    this.isPoweredOn = config.isPoweredOn !== undefined ? config.isPoweredOn : true;
  }

  protected createDefaultInterfaces(): NetworkInterfaceConfig[] {
    const interfaceCount = this.type.includes('switch') ? 8 : 4;
    return Array.from({ length: interfaceCount }, (_, i) => ({
      id: `${this.id}-if${i}`,
      name: generateInterfaceName(this.type, i),
      type: 'ethernet' as const,
      isUp: true
    }));
  }

  // Getters
  getId(): string { return this.id; }
  getDeviceType(): DeviceType { return this.type; }
  getName(): string { return this.name; }
  getHostname(): string { return this.hostname; }
  getPosition(): { x: number; y: number } { return { x: this.x, y: this.y }; }
  getInterfaces(): NetworkInterfaceConfig[] { return this.interfaces; }
  getIsPoweredOn(): boolean { return this.isPoweredOn; }

  // Setters
  setName(name: string): void { this.name = name; }
  setHostname(hostname: string): void { this.hostname = hostname; }
  setPosition(x: number, y: number): void { this.x = x; this.y = y; }
  powerOn(): void { this.isPoweredOn = true; }
  powerOff(): void { this.isPoweredOn = false; }
  togglePower(): void { this.isPoweredOn = !this.isPoweredOn; }

  // Stub methods - to be implemented with TDD
  abstract executeCommand(command: string): Promise<string>;
  abstract getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown';
}
