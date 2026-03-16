/**
 * TDD Tests for DHCP Bug Fixes & Missing Features
 *
 * Group 1: Bug Fixes — Timers, stats, APIPA
 * Group 2: DHCPPacket — Structure, serialization, deserialization
 * Group 3: DHCPINFORM — Server-side processInform
 * Group 4: Static Reservations — Manual bindings (host statement)
 * Group 5: Lease Cleanup — Expired leases & conflict TTL
 * Group 6: Pool Selection by giaddr
 * Group 7: DHCP Relay via giaddr
 * Group 8: Explicit DHCPNAK
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPClient } from '@/network/dhcp/DHCPClient';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Bug Fixes
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Bug Fixes', () => {

  // BUG-01: RENEWING should restart timers after successful renewal
  describe('BUG-01: RENEWING should restart timers', () => {
    it('should call setupLeaseTimers after successful T1 renewal', () => {
      vi.useFakeTimers();

      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.createPool('TEST');
      server.configurePoolNetwork('TEST', '10.0.0.0', '255.255.255.0');
      server.configurePoolLease('TEST', 100); // 100 second lease

      let configuredIP: string | null = null;
      const client = new DHCPClient(
        () => 'AA:BB:CC:DD:EE:01',
        (_iface, ip) => { configuredIP = ip; },
        () => { configuredIP = null; },
      );
      client.registerServer(server, '10.0.0.1');

      // Get initial lease
      client.requestLease('eth0');
      const state = client.getState('eth0');
      expect(state.state).toBe('BOUND');
      expect(configuredIP).not.toBeNull();

      // Advance to T1 (50s)
      vi.advanceTimersByTime(50_000);

      // Should have renewed and be back in BOUND
      expect(state.state).toBe('BOUND');
      expect(state.logs.some(l => l.includes('DHCPACK - lease renewed'))).toBe(true);

      // Now advance another 50s (T1 of the NEW lease) — should renew again
      vi.advanceTimersByTime(50_000);
      const renewCount = state.logs.filter(l => l.includes('DHCPACK - lease renewed')).length;
      expect(renewCount).toBe(2);

      vi.useRealTimers();
    });
  });

  // BUG-02: stats.requests-- hack should be removed
  describe('BUG-02: stats.requests should not be decremented', () => {
    it('should not count requests destined for other servers', () => {
      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.createPool('TEST');
      server.configurePoolNetwork('TEST', '10.0.0.0', '255.255.255.0');

      // Send a request with a different server identifier
      const result = server.processRequest({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1234,
        requestedIP: '10.0.0.50',
        serverIdentifier: '10.0.0.99', // Different server
        clientIdentifier: '01aabbccddee01',
      });

      expect(result).toBeNull();
      // The request should NOT be counted at all
      const stats = server.getStats();
      expect(stats.requests).toBe(0);
    });
  });

  // BUG-03: APIPA instead of autoAssignLease
  describe('BUG-03: APIPA when no server responds', () => {
    it('should assign 169.254.x.x when no DHCP server is available', () => {
      const client = new DHCPClient(
        () => 'AA:BB:CC:DD:EE:01',
        () => {},
        () => {},
      );
      // No servers registered

      client.requestLease('eth0');
      const state = client.getState('eth0');

      expect(state.state).toBe('BOUND');
      expect(state.lease).not.toBeNull();
      expect(state.lease!.ipAddress).toMatch(/^169\.254\./);
      expect(state.lease!.subnetMask).toBe('255.255.0.0');
      expect(state.lease!.defaultGateway).toBeNull();
    });

    it('should derive APIPA address deterministically from MAC', () => {
      const client1 = new DHCPClient(() => 'AA:BB:CC:DD:EE:01', () => {}, () => {});
      const client2 = new DHCPClient(() => 'AA:BB:CC:DD:EE:01', () => {}, () => {});

      client1.requestLease('eth0');
      client2.requestLease('eth0');

      expect(client1.getState('eth0').lease!.ipAddress).toBe(
        client2.getState('eth0').lease!.ipAddress,
      );
    });

    it('APIPA address should be in valid range (169.254.1.0 - 169.254.254.255)', () => {
      const client = new DHCPClient(() => 'FF:FF:FF:FF:FF:FF', () => {}, () => {});
      client.requestLease('eth0');

      const ip = client.getState('eth0').lease!.ipAddress;
      const parts = ip.split('.').map(Number);
      expect(parts[0]).toBe(169);
      expect(parts[1]).toBe(254);
      expect(parts[2]).toBeGreaterThanOrEqual(1);
      expect(parts[2]).toBeLessThanOrEqual(254);
    });
  });

  // BUG-04: Expiration timer
  describe('BUG-04: Lease expiration', () => {
    it('should expire and return to INIT when server unavailable for renewal', () => {
      vi.useFakeTimers();

      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.createPool('TEST');
      server.configurePoolNetwork('TEST', '10.0.0.0', '255.255.255.0');
      server.configurePoolLease('TEST', 60); // 60s lease

      let configuredIP: string | null = null;
      const client = new DHCPClient(
        () => 'AA:BB:CC:DD:EE:02',
        (_iface, ip) => { configuredIP = ip; },
        () => { configuredIP = null; },
      );
      client.registerServer(server, '10.0.0.1');

      client.requestLease('eth0');
      const state = client.getState('eth0');
      expect(state.state).toBe('BOUND');

      // Disable server so renewal fails at T1
      server.disable();

      // Advance past full lease expiration (T1 at 30s will fail, then expiration at 60s)
      vi.advanceTimersByTime(61_000);
      expect(state.state).toBe('INIT');
      expect(state.lease).toBeNull();

      vi.useRealTimers();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: DHCPPacket Structure
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: DHCPPacket Structure', () => {

  describe('DHCPPacket creation and field access', () => {
    it('should create a DHCPDISCOVER packet with correct fields', () => {
      const pkt = DHCPPacket.createDiscover('AA:BB:CC:DD:EE:01', 0x12345678);

      expect(pkt.op).toBe(1); // BOOTREQUEST
      expect(pkt.htype).toBe(1); // Ethernet
      expect(pkt.hlen).toBe(6);
      expect(pkt.hops).toBe(0);
      expect(pkt.xid).toBe(0x12345678);
      expect(pkt.secs).toBe(0);
      expect(pkt.flags).toBe(0x8000); // Broadcast
      expect(pkt.ciaddr).toBe('0.0.0.0');
      expect(pkt.yiaddr).toBe('0.0.0.0');
      expect(pkt.siaddr).toBe('0.0.0.0');
      expect(pkt.giaddr).toBe('0.0.0.0');
      expect(pkt.chaddr).toBe('AA:BB:CC:DD:EE:01');
      expect(pkt.getOption(53)).toBe(1); // DHCPDISCOVER
    });

    it('should create a DHCPOFFER packet with correct fields', () => {
      const pkt = DHCPPacket.createOffer(
        'AA:BB:CC:DD:EE:01', 0x12345678,
        '192.168.1.100', '192.168.1.1',
        { mask: '255.255.255.0', router: '192.168.1.1', dns: ['8.8.8.8'], leaseDuration: 86400 },
      );

      expect(pkt.op).toBe(2); // BOOTREPLY
      expect(pkt.yiaddr).toBe('192.168.1.100');
      expect(pkt.siaddr).toBe('192.168.1.1');
      expect(pkt.getOption(53)).toBe(2); // DHCPOFFER
      expect(pkt.getOption(54)).toBe('192.168.1.1'); // Server Identifier
      expect(pkt.getOption(1)).toBe('255.255.255.0'); // Subnet Mask
      expect(pkt.getOption(51)).toBe(86400); // Lease Time
    });

    it('should create a DHCPREQUEST packet', () => {
      const pkt = DHCPPacket.createRequest(
        'AA:BB:CC:DD:EE:01', 0x12345678,
        '192.168.1.100', '192.168.1.1',
      );

      expect(pkt.op).toBe(1); // BOOTREQUEST
      expect(pkt.getOption(53)).toBe(3); // DHCPREQUEST
      expect(pkt.getOption(50)).toBe('192.168.1.100'); // Requested IP
      expect(pkt.getOption(54)).toBe('192.168.1.1'); // Server Identifier
    });

    it('should create a DHCPACK packet', () => {
      const pkt = DHCPPacket.createAck(
        'AA:BB:CC:DD:EE:01', 0x12345678,
        '192.168.1.100', '192.168.1.1',
        { mask: '255.255.255.0', router: '192.168.1.1', dns: ['8.8.8.8'], leaseDuration: 86400 },
      );

      expect(pkt.op).toBe(2); // BOOTREPLY
      expect(pkt.yiaddr).toBe('192.168.1.100');
      expect(pkt.getOption(53)).toBe(5); // DHCPACK
    });

    it('should create a DHCPNAK packet', () => {
      const pkt = DHCPPacket.createNak(
        'AA:BB:CC:DD:EE:01', 0x12345678, '192.168.1.1', 'Requested address not available',
      );

      expect(pkt.op).toBe(2);
      expect(pkt.getOption(53)).toBe(6); // DHCPNAK
      expect(pkt.getOption(54)).toBe('192.168.1.1');
      expect(pkt.getOption(56)).toBe('Requested address not available'); // Message
    });

    it('should create a DHCPDECLINE packet', () => {
      const pkt = DHCPPacket.createDecline(
        'AA:BB:CC:DD:EE:01', 0x12345678,
        '192.168.1.100', '192.168.1.1',
      );

      expect(pkt.op).toBe(1);
      expect(pkt.getOption(53)).toBe(4); // DHCPDECLINE
      expect(pkt.getOption(50)).toBe('192.168.1.100');
    });

    it('should create a DHCPRELEASE packet', () => {
      const pkt = DHCPPacket.createRelease(
        'AA:BB:CC:DD:EE:01', 0x12345678,
        '192.168.1.100', '192.168.1.1',
      );

      expect(pkt.op).toBe(1);
      expect(pkt.ciaddr).toBe('192.168.1.100');
      expect(pkt.getOption(53)).toBe(7); // DHCPRELEASE
      expect(pkt.getOption(54)).toBe('192.168.1.1');
    });

    it('should create a DHCPINFORM packet', () => {
      const pkt = DHCPPacket.createInform(
        'AA:BB:CC:DD:EE:01', 0x12345678, '192.168.1.100',
      );

      expect(pkt.op).toBe(1);
      expect(pkt.ciaddr).toBe('192.168.1.100');
      expect(pkt.getOption(53)).toBe(8); // DHCPINFORM
    });
  });

  describe('DHCPPacket serialization/deserialization', () => {
    it('should serialize and deserialize a DISCOVER packet', () => {
      const original = DHCPPacket.createDiscover('AA:BB:CC:DD:EE:01', 0x12345678);
      original.setOption(55, [1, 3, 6, 15, 51, 58, 59]); // Parameter Request List

      const bytes = original.serialize();
      const restored = DHCPPacket.deserialize(bytes);

      expect(restored.op).toBe(original.op);
      expect(restored.xid).toBe(original.xid);
      expect(restored.chaddr).toBe(original.chaddr);
      expect(restored.getOption(53)).toBe(1); // DHCPDISCOVER
      expect(restored.getOption(55)).toEqual([1, 3, 6, 15, 51, 58, 59]);
    });

    it('should serialize and deserialize an OFFER packet with all options', () => {
      const original = DHCPPacket.createOffer(
        'AA:BB:CC:DD:EE:01', 0xABCD1234,
        '10.0.0.50', '10.0.0.1',
        {
          mask: '255.255.255.0',
          router: '10.0.0.1',
          dns: ['8.8.8.8', '8.8.4.4'],
          leaseDuration: 3600,
          renewalTime: 1800,
          rebindingTime: 3150,
          domainName: 'example.com',
        },
      );

      const bytes = original.serialize();
      const restored = DHCPPacket.deserialize(bytes);

      expect(restored.op).toBe(2);
      expect(restored.yiaddr).toBe('10.0.0.50');
      expect(restored.getOption(1)).toBe('255.255.255.0');
      expect(restored.getOption(3)).toBe('10.0.0.1');
      expect(restored.getOption(6)).toEqual(['8.8.8.8', '8.8.4.4']);
      expect(restored.getOption(15)).toBe('example.com');
      expect(restored.getOption(51)).toBe(3600);
      expect(restored.getOption(58)).toBe(1800);
      expect(restored.getOption(59)).toBe(3150);
    });

    it('should include magic cookie in serialized output', () => {
      const pkt = DHCPPacket.createDiscover('AA:BB:CC:DD:EE:01', 0x1);
      const bytes = pkt.serialize();

      // Magic cookie at offset 236 (after 236-byte fixed header)
      expect(bytes[236]).toBe(99);
      expect(bytes[237]).toBe(130);
      expect(bytes[238]).toBe(83);
      expect(bytes[239]).toBe(99);
    });
  });

  describe('DHCPPacket message type helpers', () => {
    it('should correctly identify message type', () => {
      const discover = DHCPPacket.createDiscover('AA:BB:CC:DD:EE:01', 1);
      expect(discover.getMessageType()).toBe('DHCPDISCOVER');

      const offer = DHCPPacket.createOffer('AA:BB:CC:DD:EE:01', 1, '1.1.1.1', '2.2.2.2', { mask: '255.0.0.0', router: '2.2.2.2', dns: [], leaseDuration: 100 });
      expect(offer.getMessageType()).toBe('DHCPOFFER');

      const nak = DHCPPacket.createNak('AA:BB:CC:DD:EE:01', 1, '2.2.2.2', 'no');
      expect(nak.getMessageType()).toBe('DHCPNAK');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: DHCPINFORM
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: DHCPINFORM', () => {

  it('should process DHCPINFORM and return configuration without lease', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');
    server.configurePoolRouter('LAN', '10.0.0.1');
    server.configurePoolDNS('LAN', ['8.8.8.8', '8.8.4.4']);
    server.configurePoolDomain('LAN', 'example.com');

    const result = server.processInform({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      clientIP: '10.0.0.50',
      xid: 999,
      clientIdentifier: '01aabbccddee01',
    });

    expect(result).not.toBeNull();
    expect(result!.serverIdentifier).toBe('10.0.0.1');
    expect(result!.xid).toBe(999);
    expect(result!.dnsServers).toEqual(['8.8.8.8', '8.8.4.4']);
    expect(result!.domainName).toBe('example.com');
    expect(result!.router).toBe('10.0.0.1');
    expect(result!.mask).toBe('255.255.255.0');
  });

  it('should increment informs counter', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');

    server.processInform({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      clientIP: '10.0.0.50',
      xid: 1,
      clientIdentifier: '01aabbccddee01',
    });

    expect(server.getStats().informs).toBe(1);
  });

  it('should return null if client IP not in any pool', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');

    const result = server.processInform({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      clientIP: '172.16.0.50',
      xid: 1,
      clientIdentifier: '01aabbccddee01',
    });

    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Static Reservations (Manual Bindings)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Static Reservations', () => {

  it('should add a static reservation (MAC → IP mapping)', () => {
    const server = new DHCPServer();
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '192.168.1.0', '255.255.255.0');

    server.addStaticBinding('LAN', 'AA:BB:CC:DD:EE:01', '192.168.1.200');

    const reservations = server.getStaticBindings('LAN');
    expect(reservations.length).toBe(1);
    expect(reservations[0].clientId).toBe('AA:BB:CC:DD:EE:01');
    expect(reservations[0].ipAddress).toBe('192.168.1.200');
    expect(reservations[0].type).toBe('manual');
  });

  it('should offer reserved IP to matching client', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('192.168.1.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '192.168.1.0', '255.255.255.0');
    server.addStaticBinding('LAN', 'AA:BB:CC:DD:EE:01', '192.168.1.200');

    const offer = server.processDiscover({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      clientIdentifier: '01aabbccddee01',
      parameterRequestList: [1, 3, 6],
    });

    expect(offer).not.toBeNull();
    expect(offer!.ip).toBe('192.168.1.200');
  });

  it('should not offer reserved IP to a different client', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('192.168.1.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '192.168.1.0', '255.255.255.0');
    server.configurePoolLease('LAN', 86400);
    server.addStaticBinding('LAN', 'AA:BB:CC:DD:EE:01', '192.168.1.200');

    const offer = server.processDiscover({
      clientMAC: 'FF:FF:FF:FF:FF:02',
      xid: 2,
      clientIdentifier: '01ffffffffffff02',
      parameterRequestList: [1, 3, 6],
    });

    expect(offer).not.toBeNull();
    expect(offer!.ip).not.toBe('192.168.1.200');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Lease Cleanup & Conflict TTL
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Lease Cleanup & Conflict TTL', () => {

  describe('Expired lease cleanup', () => {
    it('should clean up expired bindings on the server', () => {
      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.createPool('LAN');
      server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');
      server.configurePoolLease('LAN', 10);

      server.processDiscover({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1,
        clientIdentifier: '01aabbccddee01',
        parameterRequestList: [],
      });
      server.processRequest({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1,
        requestedIP: '10.0.0.1',
        clientIdentifier: '01aabbccddee01',
        serverIdentifier: '10.0.0.1',
      });

      expect(server.getBindings().size).toBe(1);

      // Manually expire the binding
      const binding = server.getBindings().values().next().value!;
      binding.leaseExpiration = Date.now() - 1000;

      server.cleanExpiredBindings();
      expect(server.getBindings().size).toBe(0);
    });

    it('should not clean up non-expired bindings', () => {
      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.createPool('LAN');
      server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');
      server.configurePoolLease('LAN', 86400);

      server.processDiscover({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1,
        clientIdentifier: '01aabbccddee01',
        parameterRequestList: [],
      });
      server.processRequest({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1,
        requestedIP: '10.0.0.1',
        clientIdentifier: '01aabbccddee01',
        serverIdentifier: '10.0.0.1',
      });

      server.cleanExpiredBindings();
      expect(server.getBindings().size).toBe(1);
    });
  });

  describe('Conflict TTL', () => {
    it('should expire conflicts after TTL', () => {
      const server = new DHCPServer();
      server.setConflictTTL(60);

      server.addConflict('10.0.0.5', 'DHCP Decline');

      expect(server.getConflicts().length).toBe(1);

      // Simulate time passage beyond TTL
      const conflicts = server.getConflicts();
      conflicts[0].detectionTime = Date.now() - 61_000;
      // Need to update internal state too
      server.setConflictTimeForTest('10.0.0.5', Date.now() - 61_000);

      server.cleanExpiredConflicts();
      expect(server.getConflicts().length).toBe(0);
    });

    it('should not allocate conflicted IP before TTL expires', () => {
      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.setConflictTTL(3600);
      server.createPool('LAN');
      server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.252'); // .1 and .2 only

      // Mark .1 as conflicted
      server.addConflict('10.0.0.1', 'Ping probe');

      const offer = server.processDiscover({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1,
        clientIdentifier: '01aabbccddee01',
        parameterRequestList: [],
      });

      expect(offer).not.toBeNull();
      expect(offer!.ip).toBe('10.0.0.2');
    });

    it('should allow conflicted IP after TTL expires', () => {
      const server = new DHCPServer();
      server.setServerIdentifier('10.0.0.1');
      server.setConflictTTL(60);
      server.createPool('LAN');
      server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.252');

      server.addConflict('10.0.0.1', 'Ping probe');
      server.setConflictTimeForTest('10.0.0.1', Date.now() - 61_000);
      server.cleanExpiredConflicts();

      const offer = server.processDiscover({
        clientMAC: 'AA:BB:CC:DD:EE:01',
        xid: 1,
        clientIdentifier: '01aabbccddee01',
        parameterRequestList: [],
      });

      expect(offer).not.toBeNull();
      expect(offer!.ip).toBe('10.0.0.1');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Pool Selection by giaddr
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Pool Selection by giaddr', () => {

  it('should select pool matching giaddr when present', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');

    server.createPool('VLAN10');
    server.configurePoolNetwork('VLAN10', '10.10.0.0', '255.255.255.0');

    server.createPool('VLAN20');
    server.configurePoolNetwork('VLAN20', '10.20.0.0', '255.255.255.0');

    const offer = server.processDiscover({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      clientIdentifier: '01aabbccddee01',
      parameterRequestList: [],
      giaddr: '10.20.0.1',
    });

    expect(offer).not.toBeNull();
    expect(offer!.ip).toMatch(/^10\.20\.0\./);
    expect(offer!.pool.name).toBe('VLAN20');
  });

  it('should fall back to sequential matching when no giaddr', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');

    server.createPool('POOL1');
    server.configurePoolNetwork('POOL1', '10.10.0.0', '255.255.255.0');

    const offer = server.processDiscover({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      clientIdentifier: '01aabbccddee01',
      parameterRequestList: [],
    });

    expect(offer).not.toBeNull();
    expect(offer!.pool.name).toBe('POOL1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: DHCP Relay
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: DHCP Relay', () => {

  it('should forward DISCOVER by setting giaddr to relay interface IP', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('REMOTE');
    server.configurePoolNetwork('REMOTE', '192.168.50.0', '255.255.255.0');

    const relayIP = '192.168.50.1';

    const offer = server.processDiscover({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 42,
      clientIdentifier: '01aabbccddee01',
      parameterRequestList: [1, 3, 6],
      giaddr: relayIP,
    });

    expect(offer).not.toBeNull();
    expect(offer!.ip).toMatch(/^192\.168\.50\./);
  });

  it('should relay DHCPREQUEST from remote subnet using giaddr for pool selection', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('REMOTE');
    server.configurePoolNetwork('REMOTE', '192.168.50.0', '255.255.255.0');

    server.processDiscover({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 42,
      clientIdentifier: '01aabbccddee01',
      parameterRequestList: [],
      giaddr: '192.168.50.1',
    });

    const ack = server.processRequest({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 42,
      requestedIP: '192.168.50.2',
      clientIdentifier: '01aabbccddee01',
      serverIdentifier: '10.0.0.1',
    });

    expect(ack).not.toBeNull();
    expect(ack!.binding.ipAddress).toBe('192.168.50.2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: Explicit DHCPNAK
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: Explicit DHCPNAK', () => {

  it('should return a NAK result (not null) when request is invalid', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');

    server.addExcludedRange('10.0.0.50', '10.0.0.50');

    const result = server.processRequestWithNak({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      requestedIP: '10.0.0.50',
      clientIdentifier: '01aabbccddee01',
      serverIdentifier: '10.0.0.1',
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe('NAK');
    expect(result!.message).toBeDefined();
    expect(result!.serverIdentifier).toBe('10.0.0.1');
  });

  it('should return an ACK result when request is valid', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');
    server.createPool('LAN');
    server.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');

    server.processDiscover({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      clientIdentifier: '01aabbccddee01',
      parameterRequestList: [],
    });

    const result = server.processRequestWithNak({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      requestedIP: '10.0.0.1',
      clientIdentifier: '01aabbccddee01',
      serverIdentifier: '10.0.0.1',
    });

    expect(result).not.toBeNull();
    expect(result!.type).toBe('ACK');
    expect(result!.binding).toBeDefined();
  });

  it('should not count requests for other servers', () => {
    const server = new DHCPServer();
    server.setServerIdentifier('10.0.0.1');

    const result = server.processRequestWithNak({
      clientMAC: 'AA:BB:CC:DD:EE:01',
      xid: 1,
      requestedIP: '10.0.0.50',
      clientIdentifier: '01aabbccddee01',
      serverIdentifier: '10.0.0.99',
    });

    expect(result).toBeNull();
    expect(server.getStats().requests).toBe(0);
  });
});
