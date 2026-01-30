/**
 * EthernetConnection Unit Tests (TDD)
 *
 * Tests for the EthernetConnection class that manages
 * bidirectional frame transfer between two connected devices.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EthernetConnection, ConnectionEvent } from '@/domain/network/EthernetConnection';
import { Connection, ConnectionType } from '@/domain/devices/types';
import { EthernetFrame, EtherType } from '@/domain/network/entities/EthernetFrame';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';
import { NetworkInterface } from '@/domain/devices/NetworkInterface';
import { Switch } from '@/domain/devices/Switch';

// Helper to create a test frame with proper payload size
function createTestFrame(srcMAC: string, dstMAC: string): EthernetFrame {
  const payload = Buffer.alloc(46); // Minimum payload size
  payload.fill(0x42); // Fill with test data
  
  return new EthernetFrame({
    sourceMAC: new MACAddress(srcMAC),
    destinationMAC: new MACAddress(dstMAC),
    etherType: EtherType.IPv4,
    payload
  });
}

// Mock device with NetworkInterface for testing
class MockPCDevice {
  public readonly id: string;
  public readonly name: string;
  private interfaces: Map<string, NetworkInterface> = new Map();
  
  constructor(id: string, name: string, macAddress: string) {
    this.id = id;
    this.name = name;
    const nic = new NetworkInterface('eth0', new MACAddress(macAddress));
    nic.up();
    this.interfaces.set('eth0', nic);
  }
  
  getInterface(name: string): NetworkInterface | undefined {
    return this.interfaces.get(name);
  }
  
  getInterfaces(): NetworkInterface[] {
    return Array.from(this.interfaces.values());
  }
}

describe('EthernetConnection', () => {
  describe('Creation', () => {
    it('should create connection with valid parameters', () => {
      const sourceDevice = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const targetDevice = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, sourceDevice, targetDevice);
      
      expect(connection.id).toBe('conn-1');
      expect(connection.type).toBe('ethernet');
      expect(connection.sourceDeviceId).toBe('pc1');
      expect(connection.targetDeviceId).toBe('pc2');
      expect(connection.isActive).toBe(true);
    });

    it('should implement Connection interface', () => {
      const sourceDevice = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const targetDevice = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection: Connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, sourceDevice, targetDevice);
      
      // TypeScript compilation verifies interface implementation
      expect(connection.id).toBeDefined();
      expect(connection.type).toBeDefined();
      expect(connection.sourceDeviceId).toBeDefined();
      expect(connection.sourceInterfaceId).toBeDefined();
      expect(connection.targetDeviceId).toBeDefined();
      expect(connection.targetInterfaceId).toBeDefined();
      expect(connection.isActive).toBeDefined();
    });
  });

  describe('Frame Transfer (PC to PC)', () => {
    let pc1: MockPCDevice;
    let pc2: MockPCDevice;
    let connection: EthernetConnection;
    
    beforeEach(() => {
      pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      connection.wireUp();
    });

    it('should transfer frame from source to target', () => {
      const receivedFrames: EthernetFrame[] = [];
      const targetInterface = pc2.getInterface('eth0')!;
      targetInterface.onReceive((frame) => receivedFrames.push(frame));
      
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.transmit(frame);
      
      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].getSourceMAC().toString()).toBe('AA:BB:CC:DD:EE:01');
    });

    it('should transfer frame from target to source (bidirectional)', () => {
      const receivedFrames: EthernetFrame[] = [];
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.onReceive((frame) => receivedFrames.push(frame));
      
      const frame = createTestFrame('AA:BB:CC:DD:EE:02', 'AA:BB:CC:DD:EE:01');
      const targetInterface = pc2.getInterface('eth0')!;
      targetInterface.transmit(frame);
      
      expect(receivedFrames).toHaveLength(1);
      expect(receivedFrames[0].getSourceMAC().toString()).toBe('AA:BB:CC:DD:EE:02');
    });

    it('should not transfer frames when connection is inactive', () => {
      connection.deactivate();
      
      const receivedFrames: EthernetFrame[] = [];
      const targetInterface = pc2.getInterface('eth0')!;
      targetInterface.onReceive((frame) => receivedFrames.push(frame));
      
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.transmit(frame);
      
      expect(receivedFrames).toHaveLength(0);
    });

    it('should resume transferring after reactivation', () => {
      connection.deactivate();
      connection.activate();
      
      const receivedFrames: EthernetFrame[] = [];
      const targetInterface = pc2.getInterface('eth0')!;
      targetInterface.onReceive((frame) => receivedFrames.push(frame));
      
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.transmit(frame);
      
      expect(receivedFrames).toHaveLength(1);
    });
  });

  describe('Frame Transfer (PC to Switch)', () => {
    let pc1: MockPCDevice;
    let sw1: Switch;
    let connection: EthernetConnection;
    
    beforeEach(() => {
      pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      sw1 = new Switch('sw1', 'Switch1', 4);
      sw1.powerOn();
      
      connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'sw1',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, sw1);
      
      connection.wireUp();
    });

    it('should transfer frame from PC to Switch', () => {
      // Switch should learn MAC when receiving frame
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'FF:FF:FF:FF:FF:FF');
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.transmit(frame);
      
      // Check MAC was learned on the correct port
      const macTable = sw1.getMACTable();
      const port = macTable.lookup(new MACAddress('AA:BB:CC:DD:EE:01'));
      expect(port).toBe('eth0');
    });

    it('should transfer frame from Switch to PC', () => {
      const receivedFrames: EthernetFrame[] = [];
      const pcInterface = pc1.getInterface('eth0')!;
      pcInterface.onReceive((frame) => receivedFrames.push(frame));
      
      // When switch forwards a frame
      const frame = createTestFrame('AA:BB:CC:DD:EE:99', 'AA:BB:CC:DD:EE:01');
      sw1.receiveFrame('eth1', frame); // Frame arrives on different port
      
      // Switch will forward to eth0 and connection should deliver to PC
      // Note: Switch floods to all ports except source since MAC is unknown
      expect(receivedFrames.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Events', () => {
    it('should emit events when frames are transferred', () => {
      const pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      const events: ConnectionEvent[] = [];
      connection.addEventListener((event) => events.push(event));
      connection.wireUp();
      
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.transmit(frame);
      
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('frame_transferred');
      expect(events[0].connectionId).toBe('conn-1');
      expect(events[0].sourceDeviceId).toBe('pc1');
      expect(events[0].targetDeviceId).toBe('pc2');
    });

    it('should support multiple event listeners', () => {
      const pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      const events1: ConnectionEvent[] = [];
      const events2: ConnectionEvent[] = [];
      connection.addEventListener((event) => events1.push(event));
      connection.addEventListener((event) => events2.push(event));
      connection.wireUp();
      
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      const sourceInterface = pc1.getInterface('eth0')!;
      sourceInterface.transmit(frame);
      
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it('should allow removing event listeners', () => {
      const pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      const events: ConnectionEvent[] = [];
      const listener = (event: ConnectionEvent) => events.push(event);
      connection.addEventListener(listener);
      connection.wireUp();
      
      // First frame should trigger event
      const frame1 = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      pc1.getInterface('eth0')!.transmit(frame1);
      expect(events).toHaveLength(1);
      
      // Remove listener
      connection.removeEventListener(listener);
      
      // Second frame should not trigger event
      const frame2 = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      pc1.getInterface('eth0')!.transmit(frame2);
      expect(events).toHaveLength(1); // Still 1
    });
  });

  describe('Cleanup', () => {
    it('should unwire when requested', () => {
      const pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      connection.wireUp();
      
      const receivedFrames: EthernetFrame[] = [];
      pc2.getInterface('eth0')!.onReceive((frame) => receivedFrames.push(frame));
      
      // Unwire
      connection.unwire();
      
      // Transmit should no longer forward
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      pc1.getInterface('eth0')!.transmit(frame);
      
      // No frames should be received (the receive callback won't be triggered)
      // After unwire, the connection's transmit callback is removed
      expect(receivedFrames).toHaveLength(0);
    });

    it('should clear event listeners on unwire', () => {
      const pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      const events: ConnectionEvent[] = [];
      connection.addEventListener((event) => events.push(event));
      connection.wireUp();
      
      // Unwire clears callbacks
      connection.unwire();
      
      // No events after unwire
      const frame = createTestFrame('AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02');
      pc1.getInterface('eth0')!.transmit(frame);
      
      expect(events).toHaveLength(0);
    });
  });

  describe('toJSON', () => {
    it('should export connection as plain Connection object', () => {
      const pc1 = new MockPCDevice('pc1', 'PC1', 'AA:BB:CC:DD:EE:01');
      const pc2 = new MockPCDevice('pc2', 'PC2', 'AA:BB:CC:DD:EE:02');
      
      const connection = new EthernetConnection({
        id: 'conn-1',
        type: 'ethernet' as ConnectionType,
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      }, pc1, pc2);
      
      const json = connection.toJSON();
      
      expect(json).toEqual({
        id: 'conn-1',
        type: 'ethernet',
        sourceDeviceId: 'pc1',
        sourceInterfaceId: 'eth0',
        targetDeviceId: 'pc2',
        targetInterfaceId: 'eth0',
        isActive: true
      });
    });
  });
});
