/**
 * Router DHCP Server Unit Tests
 * Tests for DHCP server functionality integrated into Router
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Router, RouterDHCPConfig } from '../../../domain/devices/Router';
import { DHCPPacket, DHCPMessageType, DHCPOption } from '../../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../../domain/network/value-objects/SubnetMask';
import { MACAddress } from '../../../domain/network/value-objects/MACAddress';

describe('Router DHCP Server', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router('r1', 'Test Router', 2);
    router.powerOn();
    router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
  });

  describe('DHCP Server Configuration', () => {
    it('should enable DHCP server on configured interface', () => {
      const config: RouterDHCPConfig = {
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      };

      router.enableDHCPServer(config);

      expect(router.isDHCPServerEnabled('eth0')).toBe(true);
    });

    it('should not be enabled on unconfigured interface', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      expect(router.isDHCPServerEnabled('eth1')).toBe(false);
    });

    it('should throw error when enabling on non-existent interface', () => {
      expect(() => {
        router.enableDHCPServer({
          interfaceName: 'eth99',
          poolStart: new IPAddress('192.168.1.100'),
          poolEnd: new IPAddress('192.168.1.200')
        });
      }).toThrow('Interface not found: eth99');
    });

    it('should throw error when interface has no IP configured', () => {
      expect(() => {
        router.enableDHCPServer({
          interfaceName: 'eth1', // eth1 has no IP
          poolStart: new IPAddress('10.0.0.100'),
          poolEnd: new IPAddress('10.0.0.200')
        });
      }).toThrow('must have IP address configured');
    });

    it('should disable DHCP server', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      router.disableDHCPServer('eth0');

      expect(router.isDHCPServerEnabled('eth0')).toBe(false);
    });

    it('should configure custom DNS servers', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        dnsServers: [new IPAddress('1.1.1.1'), new IPAddress('9.9.9.9')]
      });

      const dhcpServer = router.getDHCPServer('eth0');
      expect(dhcpServer).toBeDefined();
    });

    it('should configure custom lease time', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        leaseTime: 7200 // 2 hours
      });

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer?.getLeaseTime()).toBe(7200);
    });

    it('should use default lease time of 86400 seconds', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer?.getLeaseTime()).toBe(86400);
    });
  });

  describe('DHCP DISCOVER Handling', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        dnsServers: [new IPAddress('8.8.8.8')]
      });
    });

    it('should respond to DISCOVER with OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer).not.toBeNull();
      expect(offer!.getMessageType()).toBe(DHCPMessageType.OFFER);
    });

    it('should offer first available IP from pool', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.100');
    });

    it('should include subnet mask in OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getSubnetMask()?.toString()).toBe('255.255.255.0');
    });

    it('should include router (gateway) in OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getRouter()?.toString()).toBe('192.168.1.1');
    });

    it('should include DNS servers in OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      const dnsServers = offer!.getDNSServers();
      expect(dnsServers.length).toBeGreaterThan(0);
      expect(dnsServers[0].toString()).toBe('8.8.8.8');
    });

    it('should preserve transaction ID in OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getTransactionId()).toBe(discover.getTransactionId());
    });

    it('should return null when DHCP not enabled', () => {
      router.disableDHCPServer('eth0');

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer).toBeNull();
    });

    it('should honor requested IP if in pool', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const requestedIP = new IPAddress('192.168.1.150');
      const discover = DHCPPacket.createDiscover(clientMAC, undefined, requestedIP);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.150');
    });

    it('should ignore requested IP outside pool', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const requestedIP = new IPAddress('192.168.1.50'); // Outside pool
      const discover = DHCPPacket.createDiscover(clientMAC, undefined, requestedIP);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getYourIP()?.toString()).not.toBe('192.168.1.50');
      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.100');
    });
  });

  describe('DHCP REQUEST Handling', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });
    });

    it('should respond to valid REQUEST with ACK', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      // DISCOVER -> OFFER
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;

      // REQUEST -> ACK
      const request = DHCPPacket.createRequest(offer, clientMAC);
      const ack = router.handleDHCPPacket('eth0', request);

      expect(ack).not.toBeNull();
      expect(ack!.getMessageType()).toBe(DHCPMessageType.ACK);
    });

    it('should include same IP in ACK as in OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);
      const ack = router.handleDHCPPacket('eth0', request)!;

      expect(ack.getYourIP()?.toString()).toBe(offer.getYourIP()?.toString());
    });

    it('should create lease after ACK', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);
      router.handleDHCPPacket('eth0', request);

      const dhcpServer = router.getDHCPServer('eth0');
      const lease = dhcpServer?.getLease(clientMAC);

      expect(lease).toBeDefined();
      expect(lease!.ipAddress.toString()).toBe('192.168.1.100');
      expect(lease!.macAddress.equals(clientMAC)).toBe(true);
    });

    it('should respond with NAK for invalid REQUEST', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      // Create request without prior DISCOVER/OFFER for unknown IP
      const fakeOffer = DHCPPacket.createOffer(
        DHCPPacket.createDiscover(clientMAC),
        new IPAddress('192.168.1.99'), // IP not in pending offers
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [],
        3600
      );
      const request = DHCPPacket.createRequest(fakeOffer, clientMAC);

      const response = router.handleDHCPPacket('eth0', request);

      expect(response!.getMessageType()).toBe(DHCPMessageType.NAK);
    });
  });

  describe('DHCP RELEASE Handling', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });
    });

    it('should remove lease on RELEASE', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      // Complete DORA
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);
      router.handleDHCPPacket('eth0', request);

      // RELEASE
      const release = DHCPPacket.createRelease(
        new IPAddress('192.168.1.100'),
        clientMAC,
        new IPAddress('192.168.1.1')
      );
      router.handleDHCPPacket('eth0', release);

      const dhcpServer = router.getDHCPServer('eth0');
      expect(dhcpServer?.getLease(clientMAC)).toBeUndefined();
    });

    it('should return null response for RELEASE', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      const release = DHCPPacket.createRelease(
        new IPAddress('192.168.1.100'),
        clientMAC,
        new IPAddress('192.168.1.1')
      );
      const response = router.handleDHCPPacket('eth0', release);

      expect(response).toBeNull();
    });
  });

  describe('DHCP DECLINE Handling', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });
    });

    it('should mark declined IP as unavailable', () => {
      const clientMAC1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const clientMAC2 = new MACAddress('AA:BB:CC:DD:EE:02');

      // Client 1 gets offer for .100
      const discover1 = DHCPPacket.createDiscover(clientMAC1);
      const offer1 = router.handleDHCPPacket('eth0', discover1)!;
      expect(offer1.getYourIP()?.toString()).toBe('192.168.1.100');

      // Client 1 declines (IP conflict detected)
      const decline = DHCPPacket.createDecline(
        new IPAddress('192.168.1.100'),
        clientMAC1,
        new IPAddress('192.168.1.1')
      );
      router.handleDHCPPacket('eth0', decline);

      // Client 2 should not get .100
      const discover2 = DHCPPacket.createDiscover(clientMAC2, undefined, new IPAddress('192.168.1.100'));
      const offer2 = router.handleDHCPPacket('eth0', discover2)!;

      expect(offer2.getYourIP()?.toString()).not.toBe('192.168.1.100');
    });

    it('should return null response for DECLINE', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      const decline = DHCPPacket.createDecline(
        new IPAddress('192.168.1.100'),
        clientMAC,
        new IPAddress('192.168.1.1')
      );
      const response = router.handleDHCPPacket('eth0', decline);

      expect(response).toBeNull();
    });
  });

  describe('DHCP Reservations', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });
    });

    it('should add reservation', () => {
      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.50');

      router.addDHCPReservation('eth0', reservedMAC, reservedIP);

      const discover = DHCPPacket.createDiscover(reservedMAC);
      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.50');
    });

    it('should not assign reserved IP to other clients', () => {
      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.150');
      const otherMAC = new MACAddress('11:22:33:44:55:66');

      router.addDHCPReservation('eth0', reservedMAC, reservedIP);

      // Other client requests the reserved IP
      const discover = DHCPPacket.createDiscover(otherMAC, undefined, reservedIP);
      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getYourIP()?.toString()).not.toBe('192.168.1.150');
    });

    it('should remove reservation', () => {
      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.150'); // Inside pool range

      router.addDHCPReservation('eth0', reservedMAC, reservedIP);
      router.removeDHCPReservation('eth0', reservedMAC);

      // Now other client can get this IP
      const otherMAC = new MACAddress('11:22:33:44:55:66');
      const discover = DHCPPacket.createDiscover(otherMAC, undefined, reservedIP);
      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.150');
    });

    it('should throw error adding reservation when DHCP not enabled', () => {
      router.disableDHCPServer('eth0');

      expect(() => {
        router.addDHCPReservation('eth0', new MACAddress('AA:BB:CC:DD:EE:FF'), new IPAddress('192.168.1.50'));
      }).toThrow('DHCP server not enabled');
    });
  });

  describe('Lease Management', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });
    });

    it('should get all DHCP leases', () => {
      // Create leases for 3 clients
      for (let i = 1; i <= 3; i++) {
        const mac = new MACAddress(`AA:BB:CC:DD:EE:0${i}`);
        const discover = DHCPPacket.createDiscover(mac);
        const offer = router.handleDHCPPacket('eth0', discover)!;
        const request = DHCPPacket.createRequest(offer, mac);
        router.handleDHCPPacket('eth0', request);
      }

      const leases = router.getAllDHCPLeases();

      expect(leases).toHaveLength(3);
      expect(leases[0].interface).toBe('eth0');
    });

    it('should get DHCP server for interface', () => {
      const dhcpServer = router.getDHCPServer('eth0');

      expect(dhcpServer).toBeDefined();
    });

    it('should return undefined for non-existent DHCP server', () => {
      const dhcpServer = router.getDHCPServer('eth1');

      expect(dhcpServer).toBeUndefined();
    });
  });

  describe('Multiple Clients', () => {
    beforeEach(() => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.102') // Only 3 IPs
      });
    });

    it('should allocate sequential IPs to different clients', () => {
      const macs = [
        new MACAddress('AA:BB:CC:DD:EE:01'),
        new MACAddress('AA:BB:CC:DD:EE:02'),
        new MACAddress('AA:BB:CC:DD:EE:03')
      ];

      const ips: string[] = [];

      for (const mac of macs) {
        const discover = DHCPPacket.createDiscover(mac);
        const offer = router.handleDHCPPacket('eth0', discover)!;
        const request = DHCPPacket.createRequest(offer, mac);
        router.handleDHCPPacket('eth0', request);
        ips.push(offer.getYourIP()!.toString());
      }

      expect(ips).toContain('192.168.1.100');
      expect(ips).toContain('192.168.1.101');
      expect(ips).toContain('192.168.1.102');
    });

    it('should return null when pool exhausted', () => {
      // Exhaust the pool (3 IPs)
      for (let i = 1; i <= 3; i++) {
        const mac = new MACAddress(`AA:BB:CC:DD:EE:0${i}`);
        const discover = DHCPPacket.createDiscover(mac);
        const offer = router.handleDHCPPacket('eth0', discover)!;
        const request = DHCPPacket.createRequest(offer, mac);
        router.handleDHCPPacket('eth0', request);
      }

      // 4th client should get null
      const mac4 = new MACAddress('AA:BB:CC:DD:EE:04');
      const discover4 = DHCPPacket.createDiscover(mac4);
      const offer4 = router.handleDHCPPacket('eth0', discover4);

      expect(offer4).toBeNull();
    });

    it('should reuse released IP', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');

      // Client 1 gets .100
      const discover1 = DHCPPacket.createDiscover(mac1);
      const offer1 = router.handleDHCPPacket('eth0', discover1)!;
      const request1 = DHCPPacket.createRequest(offer1, mac1);
      router.handleDHCPPacket('eth0', request1);

      // Client 1 releases
      const release = DHCPPacket.createRelease(
        new IPAddress('192.168.1.100'),
        mac1,
        new IPAddress('192.168.1.1')
      );
      router.handleDHCPPacket('eth0', release);

      // Client 2 should be able to get .100
      const discover2 = DHCPPacket.createDiscover(mac2, undefined, new IPAddress('192.168.1.100'));
      const offer2 = router.handleDHCPPacket('eth0', discover2)!;

      expect(offer2.getYourIP()?.toString()).toBe('192.168.1.100');
    });
  });
});
