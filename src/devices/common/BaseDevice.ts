/**
 * BaseDevice - Abstract base class for all network devices
 */

import { DeviceConfig, CommandResult, NetworkInterfaceConfig, PacketSender } from './types';
import { NetworkStack } from './NetworkStack';
import { Packet } from '../../core/network/packet';

export abstract class BaseDevice {
  protected id: string;
  protected name: string;
  protected hostname: string;
  protected isPoweredOn: boolean;
  protected networkStack: NetworkStack;
  protected packetSender: PacketSender | null = null;

  constructor(config: DeviceConfig) {
    this.id = config.id;
    this.name = config.name;
    this.hostname = config.hostname;
    this.isPoweredOn = config.isPoweredOn;

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

  getHostname(): string {
    return this.hostname;
  }

  setHostname(hostname: string): void {
    this.hostname = hostname;
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
      osType: this.getOSType() as any,
      interfaces: this.getInterfaces(),
      isPoweredOn: this.isPoweredOn
    };
  }
}
