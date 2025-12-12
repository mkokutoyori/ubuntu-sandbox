/**
 * BaseDevice - Abstract base class for all network devices
 */

import { DeviceConfig, CommandResult, NetworkInterfaceConfig, PacketSender, DeviceType, DeviceOSType } from './types';
import { NetworkStack } from './NetworkStack';
import { Packet } from '../../core/network/packet';

export abstract class BaseDevice {
  protected id: string;
  protected name: string;
  protected hostname: string;
  protected deviceType: DeviceType;
  protected osType: DeviceOSType;
  protected isPoweredOn: boolean;
  protected networkStack: NetworkStack;
  protected packetSender: PacketSender | null = null;
  protected positionX: number;
  protected positionY: number;

  constructor(config: DeviceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.hostname = config.hostname;
    this.deviceType = config.type;
    this.osType = config.osType;
    this.isPoweredOn = config.isPoweredOn;
    this.positionX = config.x || 0;
    this.positionY = config.y || 0;

    this.networkStack = new NetworkStack({
      interfaces: config.interfaces,
      hostname: config.hostname,
      arpTimeout: 300,
      defaultTTL: 64
    });
  }

  // Abstract methods that must be implemented by subclasses
  abstract executeCommand(command: string): CommandResult;
  abstract getPrompt(): string;
  abstract getOSType(): string;

  // Get device info
  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  setName(name: string): void {
    this.name = name;
  }

  getHostname(): string {
    return this.hostname;
  }

  setHostname(hostname: string): void {
    this.hostname = hostname;
  }

  getDeviceType(): DeviceType {
    return this.deviceType;
  }

  // Position management for UI
  getPosition(): { x: number; y: number } {
    return { x: this.positionX, y: this.positionY };
  }

  setPosition(x: number, y: number): void {
    this.positionX = x;
    this.positionY = y;
  }

  // Power management
  powerOn(): void {
    this.isPoweredOn = true;
  }

  powerOff(): void {
    this.isPoweredOn = false;
  }

  getIsPoweredOn(): boolean {
    return this.isPoweredOn;
  }

  togglePower(): void {
    this.isPoweredOn = !this.isPoweredOn;
  }

  // Network stack access
  getNetworkStack(): NetworkStack {
    return this.networkStack;
  }

  // Set the packet sender callback
  setPacketSender(sender: PacketSender): void {
    this.packetSender = sender;
    this.networkStack.setPacketSender(sender);
  }

  // Process incoming packet
  processPacket(packet: Packet, interfaceId: string): Packet | null {
    if (!this.isPoweredOn) {
      return null;
    }
    return this.networkStack.processIncomingPacket(packet, interfaceId);
  }

  // Get all interfaces
  getInterfaces(): NetworkInterfaceConfig[] {
    return this.networkStack.getInterfaces();
  }

  // Get specific interface
  getInterface(interfaceId: string): NetworkInterfaceConfig | undefined {
    return this.networkStack.getInterface(interfaceId);
  }

  // Configure an interface
  configureInterface(interfaceId: string, config: Partial<NetworkInterfaceConfig>): boolean {
    return this.networkStack.configureInterface(interfaceId, config);
  }

  // Bring interface up
  interfaceUp(interfaceId: string): boolean {
    return this.networkStack.configureInterface(interfaceId, { isUp: true });
  }

  // Bring interface down
  interfaceDown(interfaceId: string): boolean {
    return this.networkStack.configureInterface(interfaceId, { isUp: false });
  }

  // Serialize device state for saving
  serialize(): DeviceConfig {
    return {
      id: this.id,
      name: this.name,
      hostname: this.hostname,
      type: this.deviceType,
      osType: this.osType,
      interfaces: this.getInterfaces(),
      isPoweredOn: this.isPoweredOn,
      x: this.positionX,
      y: this.positionY
    };
  }
}
