/**
 * NetworkSimulator - Central network simulation engine
 *
 * Design Pattern: Mediator
 * - Acts as the central hub for all network communications
 * - Devices don't communicate directly; they send frames through the simulator
 * - The simulator routes frames based on connections and device behavior
 *
 * Responsibilities:
 * - Register devices and their packet handlers
 * - Route frames through physical connections
 * - Handle Layer 2 switching (MAC learning, forwarding, flooding)
 * - Simulate network latency and packet loss (future)
 * - Emit events for packet visualization (future)
 */

import { EthernetFrame, Packet, generatePacketId, BROADCAST_MAC } from './packet';
import { BaseDevice } from '../../devices/common/BaseDevice';
import { Connection, NetworkInterfaceConfig } from '../../devices/common/types';

// Event types for observers
export type NetworkEventType =
  | 'frame_sent'
  | 'frame_received'
  | 'frame_dropped'
  | 'mac_learned'
  | 'arp_request'
  | 'arp_reply';

export interface NetworkEvent {
  type: NetworkEventType;
  timestamp: number;
  sourceDeviceId: string;
  sourceInterfaceId?: string;
  destinationDeviceId?: string;
  destinationInterfaceId?: string;
  frame?: EthernetFrame;
  packet?: Packet;
  details?: Record<string, any>;
}

export type NetworkEventListener = (event: NetworkEvent) => void;

/**
 * Switch MAC address table entry
 */
interface MACTableEntry {
  macAddress: string;
  interfaceId: string;
  vlan: number;
  timestamp: number;
  type: 'dynamic' | 'static';
}

/**
 * Device registration info
 */
interface RegisteredDevice {
  device: BaseDevice;
  type: 'host' | 'switch' | 'router';
  macTable?: Map<string, MACTableEntry>; // For switches
}

/**
 * NetworkSimulator - Singleton pattern for global access
 */
class NetworkSimulatorClass {
  private devices: Map<string, RegisteredDevice> = new Map();
  private connections: Connection[] = [];
  private eventListeners: Set<NetworkEventListener> = new Set();
  private macTableAgingTime: number = 300000; // 5 minutes in ms
  private isInitialized: boolean = false;

  /**
   * Initialize the simulator with the current network state
   */
  initialize(devices: Map<string, BaseDevice>, connections: Connection[]): void {
    this.devices.clear();
    this.connections = connections;

    // Register all devices
    devices.forEach((device, id) => {
      this.registerDevice(device);
    });

    this.isInitialized = true;
    console.log(`[NetworkSimulator] Initialized with ${this.devices.size} devices and ${this.connections.length} connections`);
  }

  /**
   * Update connections (called when topology changes)
   */
  updateConnections(connections: Connection[]): void {
    this.connections = connections;
  }

  /**
   * Register a device with the simulator
   */
  registerDevice(device: BaseDevice): void {
    const deviceType = device.getDeviceType();
    const isSwitch = deviceType.includes('switch');
    const isRouter = deviceType.includes('router');

    const registered: RegisteredDevice = {
      device,
      type: isSwitch ? 'switch' : isRouter ? 'router' : 'host',
      macTable: isSwitch ? new Map() : undefined
    };

    this.devices.set(device.getId(), registered);

    // Set up the packet sender callback
    device.setPacketSender((packet: Packet, interfaceId: string) => {
      this.handleFrameFromDevice(device.getId(), interfaceId, packet);
    });
  }

  /**
   * Unregister a device
   */
  unregisterDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  /**
   * Handle a frame sent from a device
   */
  private handleFrameFromDevice(
    sourceDeviceId: string,
    sourceInterfaceId: string,
    packet: Packet
  ): void {
    const registered = this.devices.get(sourceDeviceId);
    if (!registered) {
      console.warn(`[NetworkSimulator] Unknown source device: ${sourceDeviceId}`);
      return;
    }

    // Emit frame sent event
    this.emitEvent({
      type: 'frame_sent',
      timestamp: Date.now(),
      sourceDeviceId,
      sourceInterfaceId,
      frame: packet.frame,
      packet
    });

    // Find the connection for this interface
    const connection = this.findConnection(sourceDeviceId, sourceInterfaceId);
    if (!connection) {
      console.log(`[NetworkSimulator] No connection on ${sourceDeviceId}:${sourceInterfaceId}`);
      this.emitEvent({
        type: 'frame_dropped',
        timestamp: Date.now(),
        sourceDeviceId,
        sourceInterfaceId,
        frame: packet.frame,
        details: { reason: 'no_connection' }
      });
      return;
    }

    // Determine the target device and interface
    const isSource = connection.sourceDeviceId === sourceDeviceId &&
                     connection.sourceInterfaceId === sourceInterfaceId;

    const targetDeviceId = isSource ? connection.targetDeviceId : connection.sourceDeviceId;
    const targetInterfaceId = isSource ? connection.targetInterfaceId : connection.sourceInterfaceId;

    // Deliver the frame to the target device
    this.deliverFrame(targetDeviceId, targetInterfaceId, packet, sourceDeviceId);
  }

  /**
   * Deliver a frame to a device's interface
   */
  private deliverFrame(
    targetDeviceId: string,
    targetInterfaceId: string,
    packet: Packet,
    originalSourceDeviceId: string
  ): void {
    const registered = this.devices.get(targetDeviceId);
    if (!registered) {
      console.warn(`[NetworkSimulator] Unknown target device: ${targetDeviceId}`);
      return;
    }

    const { device, type, macTable } = registered;

    // Check if device is powered on
    if (!device.getIsPoweredOn()) {
      this.emitEvent({
        type: 'frame_dropped',
        timestamp: Date.now(),
        sourceDeviceId: originalSourceDeviceId,
        destinationDeviceId: targetDeviceId,
        destinationInterfaceId: targetInterfaceId,
        frame: packet.frame,
        details: { reason: 'device_powered_off' }
      });
      return;
    }

    // Check if interface is up
    const iface = device.getInterface(targetInterfaceId);
    if (!iface || !iface.isUp) {
      this.emitEvent({
        type: 'frame_dropped',
        timestamp: Date.now(),
        sourceDeviceId: originalSourceDeviceId,
        destinationDeviceId: targetDeviceId,
        destinationInterfaceId: targetInterfaceId,
        frame: packet.frame,
        details: { reason: 'interface_down' }
      });
      return;
    }

    // For switches, handle MAC learning and forwarding
    if (type === 'switch' && macTable) {
      this.handleSwitchFrame(registered, targetInterfaceId, packet, originalSourceDeviceId);
      return;
    }

    // For hosts and routers, deliver directly to the network stack
    this.emitEvent({
      type: 'frame_received',
      timestamp: Date.now(),
      sourceDeviceId: originalSourceDeviceId,
      destinationDeviceId: targetDeviceId,
      destinationInterfaceId: targetInterfaceId,
      frame: packet.frame,
      packet
    });

    // Add hop tracking
    packet.hops.push(targetDeviceId);

    // Process the packet through the device's network stack
    const response = device.processPacket(packet, targetInterfaceId);

    // If the device generates a response packet, it will use the packet sender callback
  }

  /**
   * Handle frame processing for a switch (MAC learning + forwarding)
   */
  private handleSwitchFrame(
    registered: RegisteredDevice,
    ingressInterfaceId: string,
    packet: Packet,
    originalSourceDeviceId: string
  ): void {
    const { device, macTable } = registered;
    const frame = packet.frame;
    const switchId = device.getId();

    // Get VLAN for the ingress port (default to 1)
    const ingressIface = device.getInterface(ingressInterfaceId);
    const vlan = ingressIface?.vlan || 1;

    // MAC Learning: Learn source MAC on ingress port
    if (frame.sourceMAC && frame.sourceMAC !== BROADCAST_MAC) {
      const existingEntry = macTable!.get(frame.sourceMAC);
      const isNew = !existingEntry || existingEntry.interfaceId !== ingressInterfaceId;

      macTable!.set(frame.sourceMAC, {
        macAddress: frame.sourceMAC,
        interfaceId: ingressInterfaceId,
        vlan,
        timestamp: Date.now(),
        type: 'dynamic'
      });

      if (isNew) {
        this.emitEvent({
          type: 'mac_learned',
          timestamp: Date.now(),
          sourceDeviceId: switchId,
          sourceInterfaceId: ingressInterfaceId,
          details: {
            macAddress: frame.sourceMAC,
            vlan,
            interfaceId: ingressInterfaceId
          }
        });
      }
    }

    // Add switch to hop tracking
    packet.hops.push(switchId);

    // MAC Lookup: Determine where to forward
    const destMac = frame.destinationMAC;

    if (destMac === BROADCAST_MAC || destMac.toUpperCase() === 'FF:FF:FF:FF:FF:FF') {
      // Broadcast: Flood to all ports except ingress
      this.floodFrame(registered, ingressInterfaceId, packet, vlan, originalSourceDeviceId);
    } else {
      // Unicast: Lookup MAC table
      const entry = macTable!.get(destMac) || macTable!.get(destMac.toUpperCase());

      if (entry && entry.vlan === vlan) {
        // Known destination: Forward to specific port
        this.forwardToPort(registered, entry.interfaceId, packet, originalSourceDeviceId);
      } else {
        // Unknown destination: Flood
        this.floodFrame(registered, ingressInterfaceId, packet, vlan, originalSourceDeviceId);
      }
    }
  }

  /**
   * Flood a frame to all ports except the ingress port
   */
  private floodFrame(
    registered: RegisteredDevice,
    ingressInterfaceId: string,
    packet: Packet,
    vlan: number,
    originalSourceDeviceId: string
  ): void {
    const { device } = registered;
    const interfaces = device.getInterfaces();
    const switchId = device.getId();

    for (const iface of interfaces) {
      // Skip ingress port and loopback
      if (iface.id === ingressInterfaceId || iface.type === 'loopback') continue;

      // Skip ports not in the same VLAN (simplified - access ports only)
      const portVlan = iface.vlan || 1;
      if (portVlan !== vlan && iface.portMode !== 'trunk') continue;

      // Skip interfaces that are down
      if (!iface.isUp) continue;

      // Find connection on this port
      const connection = this.findConnection(switchId, iface.id);
      if (!connection) continue;

      // Create a copy of the packet for this port
      const packetCopy: Packet = {
        ...packet,
        id: generatePacketId(),
        hops: [...packet.hops]
      };

      // Forward through the connection
      const isSource = connection.sourceDeviceId === switchId &&
                       connection.sourceInterfaceId === iface.id;

      const targetDeviceId = isSource ? connection.targetDeviceId : connection.sourceDeviceId;
      const targetInterfaceId = isSource ? connection.targetInterfaceId : connection.sourceInterfaceId;

      this.deliverFrame(targetDeviceId, targetInterfaceId, packetCopy, originalSourceDeviceId);
    }
  }

  /**
   * Forward a frame to a specific port
   */
  private forwardToPort(
    registered: RegisteredDevice,
    egressInterfaceId: string,
    packet: Packet,
    originalSourceDeviceId: string
  ): void {
    const { device } = registered;
    const switchId = device.getId();

    // Find connection on this port
    const connection = this.findConnection(switchId, egressInterfaceId);
    if (!connection) {
      console.log(`[NetworkSimulator] No connection on egress port ${switchId}:${egressInterfaceId}`);
      return;
    }

    // Forward through the connection
    const isSource = connection.sourceDeviceId === switchId &&
                     connection.sourceInterfaceId === egressInterfaceId;

    const targetDeviceId = isSource ? connection.targetDeviceId : connection.sourceDeviceId;
    const targetInterfaceId = isSource ? connection.targetInterfaceId : connection.sourceInterfaceId;

    this.deliverFrame(targetDeviceId, targetInterfaceId, packet, originalSourceDeviceId);
  }

  /**
   * Find a connection for a given device and interface
   */
  private findConnection(deviceId: string, interfaceId: string): Connection | undefined {
    return this.connections.find(c =>
      (c.sourceDeviceId === deviceId && c.sourceInterfaceId === interfaceId) ||
      (c.targetDeviceId === deviceId && c.targetInterfaceId === interfaceId)
    );
  }

  /**
   * Get the MAC table for a switch device
   */
  getMACTable(deviceId: string): MACTableEntry[] | null {
    const registered = this.devices.get(deviceId);
    if (!registered || !registered.macTable) return null;
    return Array.from(registered.macTable.values());
  }

  /**
   * Clear the MAC table for a switch device
   */
  clearMACTable(deviceId: string): void {
    const registered = this.devices.get(deviceId);
    if (registered?.macTable) {
      registered.macTable.clear();
    }
  }

  /**
   * Add event listener
   */
  addEventListener(listener: NetworkEventListener): void {
    this.eventListeners.add(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: NetworkEventListener): void {
    this.eventListeners.delete(listener);
  }

  /**
   * Emit an event to all listeners
   */
  private emitEvent(event: NetworkEvent): void {
    this.eventListeners.forEach(listener => {
      try {
        listener(event);
      } catch (e) {
        console.error('[NetworkSimulator] Event listener error:', e);
      }
    });
  }

  /**
   * Send a raw frame from a device (for testing or direct injection)
   */
  sendFrame(
    sourceDeviceId: string,
    sourceInterfaceId: string,
    frame: EthernetFrame
  ): void {
    const packet: Packet = {
      id: generatePacketId(),
      timestamp: Date.now(),
      frame,
      sourceDeviceId,
      hops: [sourceDeviceId],
      status: 'in_transit'
    };

    this.handleFrameFromDevice(sourceDeviceId, sourceInterfaceId, packet);
  }

  /**
   * Check if simulator is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get all registered devices
   */
  getDevices(): Map<string, RegisteredDevice> {
    return this.devices;
  }

  /**
   * Debug: Get connection info
   */
  getConnectionInfo(): string[] {
    return this.connections.map(c =>
      `${c.sourceDeviceId}:${c.sourceInterfaceId} <-> ${c.targetDeviceId}:${c.targetInterfaceId}`
    );
  }
}

// Singleton instance
export const NetworkSimulator = new NetworkSimulatorClass();
