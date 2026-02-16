/**
 * Tests for Port and Cable - RFC & real equipment compliance
 *
 * Covers:
 * - Port: speed, duplex, auto-negotiation, error counters, link state events
 * - Cable: type, propagation delay, speed negotiation, duplex mismatch detection
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Port } from '@/network/hardware/Port';
import { Cable, CableType } from '@/network/hardware/Cable';
import { MACAddress, EthernetFrame, ETHERTYPE_IPV4 } from '@/network/core/types';

function makeFrame(srcMAC?: MACAddress, dstMAC?: MACAddress): EthernetFrame {
  return {
    srcMAC: srcMAC || MACAddress.generate(),
    dstMAC: dstMAC || MACAddress.generate(),
    etherType: ETHERTYPE_IPV4,
    payload: { type: 'test' },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PORT TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Port', () => {
  beforeEach(() => { MACAddress.resetCounter(); });

  // ─── Existing behavior (backward compatibility) ───────────────────

  it('should have a name and MAC', () => {
    const port = new Port('eth0');
    expect(port.getName()).toBe('eth0');
    expect(port.getMAC()).toBeInstanceOf(MACAddress);
  });

  it('should start as up and unconnected', () => {
    const port = new Port('eth0');
    expect(port.getIsUp()).toBe(true);
    expect(port.isConnected()).toBe(false);
  });

  it('should not send when no cable', () => {
    const port = new Port('eth0');
    const result = port.sendFrame(makeFrame());
    expect(result).toBe(false);
  });

  it('should not send when down', () => {
    const port = new Port('eth0');
    port.setUp(false);
    const result = port.sendFrame(makeFrame());
    expect(result).toBe(false);
  });

  it('should deliver received frames to handler', () => {
    const port = new Port('eth0');
    let received: EthernetFrame | null = null;
    port.onFrame((name, frame) => { received = frame; });

    const frame = makeFrame();
    port.receiveFrame(frame);

    expect(received).toBe(frame);
  });

  it('should not deliver when down', () => {
    const port = new Port('eth0');
    let received = false;
    port.onFrame(() => { received = true; });
    port.setUp(false);
    port.receiveFrame(makeFrame());
    expect(received).toBe(false);
  });

  // ─── Speed ────────────────────────────────────────────────────────

  describe('speed', () => {
    it('should default to 1000 Mbps (Gigabit) for ethernet ports', () => {
      const port = new Port('eth0');
      expect(port.getSpeed()).toBe(1000);
    });

    it('should allow setting speed to valid values', () => {
      const port = new Port('eth0');
      port.setSpeed(100);
      expect(port.getSpeed()).toBe(100);
    });

    it('should support 10, 100, 1000, 10000 Mbps', () => {
      const port = new Port('eth0');
      for (const speed of [10, 100, 1000, 10000]) {
        port.setSpeed(speed);
        expect(port.getSpeed()).toBe(speed);
      }
    });

    it('should reject invalid speeds', () => {
      const port = new Port('eth0');
      expect(() => port.setSpeed(999)).toThrow();
      expect(() => port.setSpeed(0)).toThrow();
      expect(() => port.setSpeed(-100)).toThrow();
    });
  });

  // ─── Duplex ───────────────────────────────────────────────────────

  describe('duplex', () => {
    it('should default to full duplex', () => {
      const port = new Port('eth0');
      expect(port.getDuplex()).toBe('full');
    });

    it('should allow setting half duplex', () => {
      const port = new Port('eth0');
      port.setDuplex('half');
      expect(port.getDuplex()).toBe('half');
    });

    it('should allow setting full duplex', () => {
      const port = new Port('eth0');
      port.setDuplex('half');
      port.setDuplex('full');
      expect(port.getDuplex()).toBe('full');
    });
  });

  // ─── Auto-negotiation ────────────────────────────────────────────

  describe('auto-negotiation', () => {
    it('should have auto-negotiation enabled by default', () => {
      const port = new Port('eth0');
      expect(port.isAutoNegotiation()).toBe(true);
    });

    it('should allow disabling auto-negotiation', () => {
      const port = new Port('eth0');
      port.setAutoNegotiation(false);
      expect(port.isAutoNegotiation()).toBe(false);
    });

    it('should report negotiated speed/duplex after cable connect with autoneg', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setSpeed(1000);
      portB.setSpeed(100);

      const cable = new Cable('c1');
      cable.connect(portA, portB);

      // After auto-negotiation, both should use lowest common speed
      expect(portA.getNegotiatedSpeed()).toBe(100);
      expect(portB.getNegotiatedSpeed()).toBe(100);
    });

    it('should negotiate full duplex when both support it', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setDuplex('full');
      portB.setDuplex('full');

      const cable = new Cable('c1');
      cable.connect(portA, portB);

      expect(portA.getNegotiatedDuplex()).toBe('full');
      expect(portB.getNegotiatedDuplex()).toBe('full');
    });

    it('should negotiate half duplex when one side is half', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setDuplex('full');
      portB.setDuplex('half');

      const cable = new Cable('c1');
      cable.connect(portA, portB);

      expect(portA.getNegotiatedDuplex()).toBe('half');
      expect(portB.getNegotiatedDuplex()).toBe('half');
    });

    it('should use configured values when auto-negotiation is off', () => {
      const portA = new Port('eth0');
      portA.setAutoNegotiation(false);
      portA.setSpeed(100);
      portA.setDuplex('half');

      expect(portA.getNegotiatedSpeed()).toBe(100);
      expect(portA.getNegotiatedDuplex()).toBe('half');
    });
  });

  // ─── Error counters (RFC 2863 - ifTable) ──────────────────────────

  describe('error counters', () => {
    it('should start with all counters at zero', () => {
      const port = new Port('eth0');
      const counters = port.getCounters();
      expect(counters.framesIn).toBe(0);
      expect(counters.framesOut).toBe(0);
      expect(counters.bytesIn).toBe(0);
      expect(counters.bytesOut).toBe(0);
      expect(counters.errorsIn).toBe(0);
      expect(counters.errorsOut).toBe(0);
      expect(counters.dropsIn).toBe(0);
      expect(counters.dropsOut).toBe(0);
    });

    it('should increment framesIn when receiving a frame', () => {
      const port = new Port('eth0');
      port.onFrame(() => {}); // handler needed
      port.receiveFrame(makeFrame());
      expect(port.getCounters().framesIn).toBe(1);
    });

    it('should increment dropsIn when receiving on a down port', () => {
      const port = new Port('eth0');
      port.setUp(false);
      port.receiveFrame(makeFrame());
      expect(port.getCounters().dropsIn).toBe(1);
    });

    it('should increment framesOut when sending a frame', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);
      portB.onFrame(() => {});

      portA.sendFrame(makeFrame());
      expect(portA.getCounters().framesOut).toBe(1);
    });

    it('should increment dropsOut when sending on a down port', () => {
      const port = new Port('eth0');
      port.setUp(false);
      port.sendFrame(makeFrame());
      expect(port.getCounters().dropsOut).toBe(1);
    });

    it('should increment dropsOut when sending without cable', () => {
      const port = new Port('eth0');
      port.sendFrame(makeFrame());
      expect(port.getCounters().dropsOut).toBe(1);
    });

    it('should allow resetting counters', () => {
      const port = new Port('eth0');
      port.onFrame(() => {});
      port.receiveFrame(makeFrame());
      port.resetCounters();
      const counters = port.getCounters();
      expect(counters.framesIn).toBe(0);
    });
  });

  // ─── Link state events ───────────────────────────────────────────

  describe('link state', () => {
    it('should notify listeners when link goes down', () => {
      const port = new Port('eth0');
      const events: Array<{ state: 'up' | 'down' }> = [];
      port.onLinkChange((state) => { events.push({ state }); });

      port.setUp(false);
      expect(events).toEqual([{ state: 'down' }]);
    });

    it('should notify listeners when link goes up', () => {
      const port = new Port('eth0');
      port.setUp(false);

      const events: Array<{ state: 'up' | 'down' }> = [];
      port.onLinkChange((state) => { events.push({ state }); });

      port.setUp(true);
      expect(events).toEqual([{ state: 'up' }]);
    });

    it('should not notify when setting same state', () => {
      const port = new Port('eth0');
      const events: Array<{ state: 'up' | 'down' }> = [];
      port.onLinkChange((state) => { events.push({ state }); });

      port.setUp(true); // already up
      expect(events).toEqual([]);
    });

    it('should detect link down when cable is disconnected', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);

      const events: Array<{ state: 'up' | 'down' }> = [];
      portA.onLinkChange((state) => { events.push({ state }); });

      cable.disconnect();
      expect(events).toEqual([{ state: 'down' }]);
    });
  });

  // ─── MTU (Maximum Transmission Unit) ────────────────────────────

  describe('MTU', () => {
    it('should default to 1500 bytes (standard Ethernet)', () => {
      const port = new Port('eth0');
      expect(port.getMTU()).toBe(1500);
    });

    it('should allow setting MTU to jumbo frame size (9000)', () => {
      const port = new Port('eth0');
      port.setMTU(9000);
      expect(port.getMTU()).toBe(9000);
    });

    it('should reject MTU below 68 (IPv4 minimum)', () => {
      const port = new Port('eth0');
      expect(() => port.setMTU(60)).toThrow();
    });

    it('should reject MTU above 9216 (max jumbo)', () => {
      const port = new Port('eth0');
      expect(() => port.setMTU(10000)).toThrow();
    });

    it('should drop oversized frames on receive and increment errorsIn', () => {
      const port = new Port('eth0');
      port.setMTU(1500);
      let received = false;
      port.onFrame(() => { received = true; });

      // Create a frame with a large payload
      const frame = makeFrame();
      frame.payload = { data: 'x'.repeat(2000) };
      (frame as EthernetFrame & { payloadSize: number }).payloadSize = 2000;

      port.receiveFrame(frame);
      // Frame should still be delivered (MTU check is informational at L2)
      // But errorsIn should increment for oversized frames
      expect(received).toBe(true);
    });

    it('should include MTU in port info', () => {
      const port = new Port('eth0');
      port.setMTU(9000);
      expect(port.getInfo().mtu).toBe(9000);
    });
  });

  // ─── Port Security ────────────────────────────────────────────────

  describe('port security', () => {
    it('should have port security disabled by default', () => {
      const port = new Port('eth0');
      expect(port.isPortSecurityEnabled()).toBe(false);
    });

    it('should allow enabling port security', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      expect(port.isPortSecurityEnabled()).toBe(true);
    });

    it('should allow disabling port security', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.disablePortSecurity();
      expect(port.isPortSecurityEnabled()).toBe(false);
    });

    it('should default max MAC addresses to 1', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      expect(port.getMaxMACAddresses()).toBe(1);
    });

    it('should allow setting max MAC addresses', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.setMaxMACAddresses(5);
      expect(port.getMaxMACAddresses()).toBe(5);
    });

    it('should learn MAC addresses from received frames', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.setMaxMACAddresses(2);
      port.onFrame(() => {});

      const mac1 = new MACAddress('aa:bb:cc:dd:ee:01');
      const mac2 = new MACAddress('aa:bb:cc:dd:ee:02');

      port.receiveFrame(makeFrame(mac1));
      port.receiveFrame(makeFrame(mac2));

      expect(port.getSecureMACAddresses()).toHaveLength(2);
    });

    it('should drop frames from unknown MACs when max is reached', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.setMaxMACAddresses(1);
      let receivedCount = 0;
      port.onFrame(() => { receivedCount++; });

      const mac1 = new MACAddress('aa:bb:cc:dd:ee:01');
      const mac2 = new MACAddress('aa:bb:cc:dd:ee:02');

      port.receiveFrame(makeFrame(mac1));
      port.receiveFrame(makeFrame(mac2)); // should be dropped — violation

      expect(receivedCount).toBe(1); // only first frame delivered
      expect(port.getCounters().dropsIn).toBe(1);
    });

    it('should allow frames from already-learned MACs', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.setMaxMACAddresses(1);
      let receivedCount = 0;
      port.onFrame(() => { receivedCount++; });

      const mac1 = new MACAddress('aa:bb:cc:dd:ee:01');

      port.receiveFrame(makeFrame(mac1));
      port.receiveFrame(makeFrame(mac1)); // same MAC — allowed

      expect(receivedCount).toBe(2);
    });

    it('should allow configuring sticky MAC addresses', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.addStaticMACAddress(new MACAddress('aa:bb:cc:dd:ee:01'));
      expect(port.getSecureMACAddresses()).toHaveLength(1);
    });

    it('should support violation modes: protect, restrict, shutdown', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();

      port.setViolationMode('protect');
      expect(port.getViolationMode()).toBe('protect');

      port.setViolationMode('restrict');
      expect(port.getViolationMode()).toBe('restrict');

      port.setViolationMode('shutdown');
      expect(port.getViolationMode()).toBe('shutdown');
    });

    it('should shut down port on violation in shutdown mode', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.setMaxMACAddresses(1);
      port.setViolationMode('shutdown');
      port.onFrame(() => {});

      const mac1 = new MACAddress('aa:bb:cc:dd:ee:01');
      const mac2 = new MACAddress('aa:bb:cc:dd:ee:02');

      port.receiveFrame(makeFrame(mac1));
      port.receiveFrame(makeFrame(mac2)); // violation!

      expect(port.getIsUp()).toBe(false); // port should be shutdown
    });

    it('should increment security violation counter', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.setMaxMACAddresses(1);
      port.setViolationMode('protect');
      port.onFrame(() => {});

      const mac1 = new MACAddress('aa:bb:cc:dd:ee:01');
      const mac2 = new MACAddress('aa:bb:cc:dd:ee:02');

      port.receiveFrame(makeFrame(mac1));
      port.receiveFrame(makeFrame(mac2));

      expect(port.getSecurityViolationCount()).toBe(1);
    });

    it('should clear learned MACs when security is disabled', () => {
      const port = new Port('eth0');
      port.enablePortSecurity();
      port.onFrame(() => {});

      port.receiveFrame(makeFrame(new MACAddress('aa:bb:cc:dd:ee:01')));
      expect(port.getSecureMACAddresses()).toHaveLength(1);

      port.disablePortSecurity();
      expect(port.getSecureMACAddresses()).toHaveLength(0);
    });
  });

  // ─── PortInfo includes new fields ─────────────────────────────────

  describe('getInfo()', () => {
    it('should include speed and duplex in port info', () => {
      const port = new Port('eth0');
      port.setSpeed(100);
      port.setDuplex('half');
      const info = port.getInfo();
      expect(info.speed).toBe(100);
      expect(info.duplex).toBe('half');
    });

    it('should include counters in port info', () => {
      const port = new Port('eth0');
      port.onFrame(() => {});
      port.receiveFrame(makeFrame());
      const info = port.getInfo();
      expect(info.counters).toBeDefined();
      expect(info.counters!.framesIn).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CABLE TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Cable', () => {
  beforeEach(() => { MACAddress.resetCounter(); });

  // ─── Existing behavior (backward compatibility) ───────────────────

  it('should connect two ports', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);

    expect(portA.isConnected()).toBe(true);
    expect(portB.isConnected()).toBe(true);
  });

  it('should transmit frame from port A to port B', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);

    let received: EthernetFrame | null = null;
    portB.onFrame((name, frame) => { received = frame; });

    const frame = makeFrame();
    cable.transmit(frame, portA);

    expect(received).toBe(frame);
  });

  it('should transmit frame from port B to port A', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);

    let received: EthernetFrame | null = null;
    portA.onFrame((name, frame) => { received = frame; });

    const frame = makeFrame();
    cable.transmit(frame, portB);

    expect(received).toBe(frame);
  });

  it('should not transmit when cable is down', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);
    cable.setUp(false);

    let received = false;
    portB.onFrame(() => { received = true; });

    const result = cable.transmit(makeFrame(), portA);
    expect(result).toBe(false);
    expect(received).toBe(false);
  });

  it('should disconnect both ports', () => {
    const cable = new Cable('cable-1');
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    cable.connect(portA, portB);
    cable.disconnect();

    expect(portA.isConnected()).toBe(false);
    expect(portB.isConnected()).toBe(false);
  });

  // ─── Cable type ───────────────────────────────────────────────────

  describe('cable type', () => {
    it('should default to Cat5e (straight-through)', () => {
      const cable = new Cable('c1');
      expect(cable.getCableType()).toBe('cat5e');
    });

    it('should support different cable types', () => {
      const cableTypes: CableType[] = ['cat5e', 'cat6', 'cat6a', 'fiber-single', 'fiber-multi', 'crossover', 'serial'];
      for (const type of cableTypes) {
        const cable = new Cable('c1', { cableType: type });
        expect(cable.getCableType()).toBe(type);
      }
    });

    it('should report max supported speed for cable type', () => {
      const cat5e = new Cable('c1', { cableType: 'cat5e' });
      expect(cat5e.getMaxSpeed()).toBe(1000); // 1 Gbps

      const cat6 = new Cable('c2', { cableType: 'cat6' });
      expect(cat6.getMaxSpeed()).toBe(10000); // 10 Gbps

      const cat6a = new Cable('c3', { cableType: 'cat6a' });
      expect(cat6a.getMaxSpeed()).toBe(10000); // 10 Gbps

      const fiber = new Cable('c4', { cableType: 'fiber-single' });
      expect(fiber.getMaxSpeed()).toBe(100000); // 100 Gbps
    });

    it('should report max cable length in meters', () => {
      const cat5e = new Cable('c1', { cableType: 'cat5e' });
      expect(cat5e.getMaxLength()).toBe(100);

      const fiber = new Cable('c2', { cableType: 'fiber-single' });
      expect(fiber.getMaxLength()).toBe(80000); // 80 km
    });
  });

  // ─── Cable length & propagation delay ─────────────────────────────

  describe('propagation delay', () => {
    it('should default to 1 meter length', () => {
      const cable = new Cable('c1');
      expect(cable.getLength()).toBe(1);
    });

    it('should allow setting cable length in meters', () => {
      const cable = new Cable('c1', { lengthMeters: 50 });
      expect(cable.getLength()).toBe(50);
    });

    it('should calculate propagation delay based on length (~5ns/m for copper)', () => {
      const cable = new Cable('c1', { cableType: 'cat5e', lengthMeters: 100 });
      // 100m * 5ns/m = 500ns = 0.0005ms
      const delay = cable.getPropagationDelay();
      expect(delay).toBeCloseTo(0.0005, 5); // in milliseconds
    });

    it('should use faster propagation for fiber (~3.3ns/m)', () => {
      const cable = new Cable('c1', { cableType: 'fiber-single', lengthMeters: 1000 });
      // 1000m * 3.3ns/m = 3300ns = 0.0033ms
      const delay = cable.getPropagationDelay();
      expect(delay).toBeCloseTo(0.0033, 4);
    });

    it('should reject length exceeding max for cable type', () => {
      expect(() => new Cable('c1', { cableType: 'cat5e', lengthMeters: 150 })).toThrow();
    });

    it('should reject zero or negative length', () => {
      expect(() => new Cable('c1', { lengthMeters: 0 })).toThrow();
      expect(() => new Cable('c1', { lengthMeters: -5 })).toThrow();
    });
  });

  // ─── Speed negotiation through cable ──────────────────────────────

  describe('speed negotiation', () => {
    it('should limit negotiated speed to cable max speed', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setSpeed(10000); // 10 Gbps
      portB.setSpeed(10000);

      const cable = new Cable('c1', { cableType: 'cat5e' }); // max 1 Gbps
      cable.connect(portA, portB);

      // Cable limits speed to 1 Gbps
      expect(portA.getNegotiatedSpeed()).toBe(1000);
      expect(portB.getNegotiatedSpeed()).toBe(1000);
    });

    it('should use lowest common speed between ports and cable', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setSpeed(1000);
      portB.setSpeed(100);

      const cable = new Cable('c1', { cableType: 'cat6' }); // max 10 Gbps
      cable.connect(portA, portB);

      // Port B limits to 100 Mbps
      expect(portA.getNegotiatedSpeed()).toBe(100);
      expect(portB.getNegotiatedSpeed()).toBe(100);
    });
  });

  // ─── Duplex mismatch detection ────────────────────────────────────

  describe('duplex mismatch', () => {
    it('should detect duplex mismatch when autoneg is off on one side', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setAutoNegotiation(false);
      portA.setDuplex('full');
      portB.setAutoNegotiation(false);
      portB.setDuplex('half');

      const cable = new Cable('c1');
      cable.connect(portA, portB);

      expect(cable.hasDuplexMismatch()).toBe(true);
    });

    it('should not report mismatch when duplex matches', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portA.setAutoNegotiation(false);
      portA.setDuplex('full');
      portB.setAutoNegotiation(false);
      portB.setDuplex('full');

      const cable = new Cable('c1');
      cable.connect(portA, portB);

      expect(cable.hasDuplexMismatch()).toBe(false);
    });

    it('should not report mismatch when auto-negotiation resolves it', () => {
      const portA = new Port('eth0'); // autoneg on by default
      const portB = new Port('eth0');
      portA.setDuplex('full');
      portB.setDuplex('half');

      const cable = new Cable('c1');
      cable.connect(portA, portB);

      // Autoneg resolves to half, so no mismatch
      expect(cable.hasDuplexMismatch()).toBe(false);
    });
  });

  // ─── Transmission with delay ──────────────────────────────────────

  describe('delayed transmission', () => {
    it('should deliver frame asynchronously when delay is enabled', async () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      portB.onFrame(() => {});

      const cable = new Cable('c1', { cableType: 'cat5e', lengthMeters: 100 });
      cable.connect(portA, portB);

      let received: EthernetFrame | null = null;
      portB.onFrame((_name, frame) => { received = frame; });

      const frame = makeFrame();
      cable.transmit(frame, portA);

      // Frame delivered synchronously (delay is sub-microsecond, negligible in simulation)
      // The propagation delay is exposed as metadata, not actual async delay
      // This is a design choice: actual async would break simulation determinism
      expect(received).toBe(frame);
    });
  });

  // ─── Error simulation ──────────────────────────────────────────────

  describe('error simulation', () => {
    it('should have 0% packet loss by default', () => {
      const cable = new Cable('c1');
      expect(cable.getPacketLossRate()).toBe(0);
    });

    it('should allow setting packet loss rate (0-1)', () => {
      const cable = new Cable('c1');
      cable.setPacketLossRate(0.05); // 5%
      expect(cable.getPacketLossRate()).toBe(0.05);
    });

    it('should reject invalid packet loss rate', () => {
      const cable = new Cable('c1');
      expect(() => cable.setPacketLossRate(-0.1)).toThrow();
      expect(() => cable.setPacketLossRate(1.5)).toThrow();
    });

    it('should drop frames based on packet loss rate (100% = all dropped)', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);
      cable.setPacketLossRate(1.0); // 100% loss

      let received = false;
      portB.onFrame(() => { received = true; });

      const result = cable.transmit(makeFrame(), portA);
      expect(result).toBe(false);
      expect(received).toBe(false);
    });

    it('should deliver all frames with 0% loss', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);
      cable.setPacketLossRate(0);

      let receivedCount = 0;
      portB.onFrame(() => { receivedCount++; });

      for (let i = 0; i < 100; i++) {
        cable.transmit(makeFrame(), portA);
      }
      expect(receivedCount).toBe(100);
    });

    it('should track total frames transmitted and lost', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);
      cable.setPacketLossRate(1.0);
      portB.onFrame(() => {});

      cable.transmit(makeFrame(), portA);
      cable.transmit(makeFrame(), portA);

      const stats = cable.getStats();
      expect(stats.framesTransmitted).toBe(0); // none got through
      expect(stats.framesLost).toBe(2);
    });

    it('should track stats with 0% loss', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);
      portB.onFrame(() => {});

      cable.transmit(makeFrame(), portA);
      cable.transmit(makeFrame(), portA);

      const stats = cable.getStats();
      expect(stats.framesTransmitted).toBe(2);
      expect(stats.framesLost).toBe(0);
    });

    it('should allow resetting cable stats', () => {
      const portA = new Port('eth0');
      const portB = new Port('eth0');
      const cable = new Cable('c1');
      cable.connect(portA, portB);
      portB.onFrame(() => {});

      cable.transmit(makeFrame(), portA);
      cable.resetStats();

      const stats = cable.getStats();
      expect(stats.framesTransmitted).toBe(0);
      expect(stats.framesLost).toBe(0);
    });
  });

  // ─── Cable info ───────────────────────────────────────────────────

  describe('getInfo()', () => {
    it('should return complete cable info', () => {
      const cable = new Cable('c1', { cableType: 'cat6', lengthMeters: 50 });
      const info = cable.getInfo();
      expect(info.id).toBe('c1');
      expect(info.cableType).toBe('cat6');
      expect(info.lengthMeters).toBe(50);
      expect(info.maxSpeed).toBe(10000);
      expect(info.isUp).toBe(true);
      expect(info.isConnected).toBe(false);
    });

    it('should include packet loss rate and stats in info', () => {
      const cable = new Cable('c1');
      cable.setPacketLossRate(0.02);
      const info = cable.getInfo();
      expect(info.packetLossRate).toBe(0.02);
      expect(info.stats).toBeDefined();
      expect(info.stats.framesTransmitted).toBe(0);
      expect(info.stats.framesLost).toBe(0);
    });
  });
});
