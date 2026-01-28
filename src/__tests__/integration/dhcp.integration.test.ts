/**
 * DHCP Integration Tests
 * Tests end-to-end DHCP scenarios between Router (server) and PC (client)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Router, RouterDHCPConfig } from '../../domain/devices/Router';
import { LinuxPC } from '../../domain/devices/LinuxPC';
import { WindowsPC } from '../../domain/devices/WindowsPC';
import { DHCPServerService, DHCPClientService, DHCPClientState } from '../../domain/network/services/DHCPService';
import { DHCPPacket, DHCPMessageType } from '../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../domain/network/value-objects/SubnetMask';
import { MACAddress } from '../../domain/network/value-objects/MACAddress';

describe('DHCP Integration Tests', () => {
  describe('Router DHCP Server', () => {
    let router: Router;

    beforeEach(() => {
      router = new Router('r1', 'DHCP Router', 2);
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
    });

    it('should enable DHCP server on interface', () => {
      const dhcpConfig: RouterDHCPConfig = {
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      };

      router.enableDHCPServer(dhcpConfig);

      expect(router.isDHCPServerEnabled('eth0')).toBe(true);
      expect(router.isDHCPServerEnabled('eth1')).toBe(false);
    });

    it('should handle DHCP DISCOVER and return OFFER', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = router.handleDHCPPacket('eth0', discover);

      expect(offer).not.toBeNull();
      expect(offer!.getMessageType()).toBe(DHCPMessageType.OFFER);
      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(offer!.getSubnetMask()?.toString()).toBe('255.255.255.0');
      expect(offer!.getRouter()?.toString()).toBe('192.168.1.1');
    });

    it('should handle full DORA process', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        dnsServers: [new IPAddress('8.8.8.8'), new IPAddress('8.8.4.4')],
        leaseTime: 3600
      });

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      // DISCOVER
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;

      expect(offer.getMessageType()).toBe(DHCPMessageType.OFFER);

      // REQUEST
      const request = DHCPPacket.createRequest(offer, clientMAC);
      const ack = router.handleDHCPPacket('eth0', request)!;

      expect(ack.getMessageType()).toBe(DHCPMessageType.ACK);
      expect(ack.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(ack.getLeaseTime()).toBe(3600);

      // Verify lease is created
      const dhcpServer = router.getDHCPServer('eth0');
      const lease = dhcpServer?.getLease(clientMAC);
      expect(lease).toBeDefined();
      expect(lease!.ipAddress.toString()).toBe('192.168.1.100');
    });

    it('should allocate different IPs to different clients', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');

      // Client 1 DORA
      const discover1 = DHCPPacket.createDiscover(mac1);
      const offer1 = router.handleDHCPPacket('eth0', discover1)!;
      const request1 = DHCPPacket.createRequest(offer1, mac1);
      router.handleDHCPPacket('eth0', request1);

      // Client 2 DORA
      const discover2 = DHCPPacket.createDiscover(mac2);
      const offer2 = router.handleDHCPPacket('eth0', discover2)!;
      const request2 = DHCPPacket.createRequest(offer2, mac2);
      router.handleDHCPPacket('eth0', request2);

      expect(offer1.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(offer2.getYourIP()?.toString()).toBe('192.168.1.101');
    });

    it('should handle DHCP RELEASE', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      // DORA
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);
      router.handleDHCPPacket('eth0', request);

      // Verify lease exists
      const dhcpServer = router.getDHCPServer('eth0');
      expect(dhcpServer?.getLease(clientMAC)).toBeDefined();

      // RELEASE
      const release = DHCPPacket.createRelease(
        new IPAddress('192.168.1.100'),
        clientMAC,
        new IPAddress('192.168.1.1')
      );
      router.handleDHCPPacket('eth0', release);

      // Verify lease is removed
      expect(dhcpServer?.getLease(clientMAC)).toBeUndefined();
    });

    it('should support static IP reservations', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.50');

      router.addDHCPReservation('eth0', reservedMAC, reservedIP);

      const discover = DHCPPacket.createDiscover(reservedMAC);
      const offer = router.handleDHCPPacket('eth0', discover)!;

      expect(offer.getYourIP()?.toString()).toBe('192.168.1.50');
    });

    it('should list all DHCP leases', () => {
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      // Create leases for multiple clients
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
  });

  describe('LinuxPC DHCP Client', () => {
    let router: Router;
    let linux: LinuxPC;

    beforeEach(() => {
      // Setup router as DHCP server
      router = new Router('r1', 'DHCP Router', 2);
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        dnsServers: [new IPAddress('8.8.8.8')],
        leaseTime: 86400
      });

      // Setup Linux PC
      linux = new LinuxPC({ id: 'pc1', name: 'Ubuntu PC' });
    });

    it('should execute dhclient command', async () => {
      const output = await linux.executeCommand('dhclient');

      expect(output).toContain('Internet Systems Consortium DHCP Client');
      expect(output).toContain('DHCPDISCOVER');
    });

    it('should display dhclient help', async () => {
      const output = await linux.executeCommand('dhclient --help');

      expect(output).toContain('Usage: dhclient');
      expect(output).toContain('-r');
      expect(output).toContain('-v');
    });

    it('should handle DHCP response and configure interface', async () => {
      // Track sent packets
      const sentPackets: DHCPPacket[] = [];
      linux.setDHCPCallback((packet) => {
        sentPackets.push(packet);

        // Simulate router response
        const response = router.handleDHCPPacket('eth0', packet);
        if (response) {
          linux.handleDHCPResponse(response);
        }
      });

      // Execute dhclient to start DHCP process
      await linux.executeCommand('dhclient eth0');

      // Verify DISCOVER was sent
      expect(sentPackets.length).toBeGreaterThanOrEqual(1);
      expect(sentPackets[0].getMessageType()).toBe(DHCPMessageType.DISCOVER);
    });

    it('should execute dhclient release', async () => {
      const output = await linux.executeCommand('dhclient -r eth0');

      expect(output).toContain('Internet Systems Consortium DHCP Client');
      expect(output).toContain('DHCPRELEASE');
    });
  });

  describe('WindowsPC DHCP Client', () => {
    let router: Router;
    let windows: WindowsPC;

    beforeEach(() => {
      // Setup router as DHCP server
      router = new Router('r1', 'DHCP Router', 2);
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200'),
        dnsServers: [new IPAddress('8.8.8.8')],
        leaseTime: 86400
      });

      // Setup Windows PC
      windows = new WindowsPC({ id: 'pc1', name: 'Windows PC' });
    });

    it('should execute ipconfig /renew command', async () => {
      const output = await windows.executeCommand('ipconfig /renew');

      expect(output).toContain('Windows IP Configuration');
    });

    it('should execute ipconfig /release command', async () => {
      // First set DHCP enabled
      const renewOutput = await windows.executeCommand('ipconfig /renew');

      const output = await windows.executeCommand('ipconfig /release');

      expect(output).toContain('Windows IP Configuration');
      expect(output).toContain('Ethernet adapter Ethernet');
    });

    it('should show error for non-DHCP adapter release', async () => {
      const output = await windows.executeCommand('ipconfig /release');

      expect(output).toContain('DHCP is not enabled on this adapter');
    });

    it('should execute ipconfig /flushdns', async () => {
      const output = await windows.executeCommand('ipconfig /flushdns');

      expect(output).toContain('Successfully flushed the DNS Resolver Cache');
    });

    it('should handle DHCP response and configure interface', async () => {
      // Track sent packets
      const sentPackets: DHCPPacket[] = [];
      windows.setDHCPCallback((packet) => {
        sentPackets.push(packet);

        // Simulate router response
        const response = router.handleDHCPPacket('eth0', packet);
        if (response) {
          windows.handleDHCPResponse(response);
        }
      });

      // Execute ipconfig /renew to start DHCP process
      await windows.executeCommand('ipconfig /renew');

      // Verify DISCOVER was sent
      expect(sentPackets.length).toBeGreaterThanOrEqual(1);
      expect(sentPackets[0].getMessageType()).toBe(DHCPMessageType.DISCOVER);
    });
  });

  describe('DHCP Client State Machine', () => {
    it('should follow correct state transitions', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const client = new DHCPClientService(clientMAC, 'test-host');

      // Initial state
      expect(client.getState()).toBe(DHCPClientState.INIT);

      // Start discovery
      client.startDiscover();
      expect(client.getState()).toBe(DHCPClientState.SELECTING);

      // Create discover
      const discover = client.createDiscover();
      expect(discover.getMessageType()).toBe(DHCPMessageType.DISCOVER);

      // Receive offer
      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      client.handleOffer(offer);
      expect(client.getState()).toBe(DHCPClientState.REQUESTING);

      // Create request
      const request = client.createRequest();
      expect(request).not.toBeNull();
      expect(request!.getMessageType()).toBe(DHCPMessageType.REQUEST);

      // Receive ACK
      const ack = DHCPPacket.createAck(
        request!,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      client.handleAck(ack);
      expect(client.getState()).toBe(DHCPClientState.BOUND);

      // Verify lease info
      const leaseInfo = client.getLeaseInfo();
      expect(leaseInfo).not.toBeNull();
      expect(leaseInfo!.ipAddress.toString()).toBe('192.168.1.100');
      expect(leaseInfo!.subnetMask.toString()).toBe('255.255.255.0');
      expect(leaseInfo!.gateway?.toString()).toBe('192.168.1.1');
      expect(leaseInfo!.leaseTime).toBe(3600);

      // Release (must be in BOUND state)
      const release = client.createRelease();
      expect(release).not.toBeNull();
      expect(release!.getMessageType()).toBe(DHCPMessageType.RELEASE);

      // Test renewal state transition (before releasing)
      client.startRenewal();
      expect(client.getState()).toBe(DHCPClientState.RENEWING);

      // Now release
      client.release();
      expect(client.getState()).toBe(DHCPClientState.INIT);
      expect(client.getLeaseInfo()).toBeNull();
    });

    it('should handle NAK and return to INIT', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const client = new DHCPClientService(clientMAC);

      client.startDiscover();
      const discover = client.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [],
        3600
      );
      client.handleOffer(offer);

      const request = client.createRequest()!;

      // Receive NAK instead of ACK
      const nak = DHCPPacket.createNak(request, new IPAddress('192.168.1.1'));
      client.handleNak(nak);

      expect(client.getState()).toBe(DHCPClientState.INIT);
    });
  });

  describe('DHCP Pool Exhaustion', () => {
    it('should return null when pool is exhausted', () => {
      const router = new Router('r1', 'DHCP Router', 2);
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));

      // Small pool with only 2 addresses
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.101')
      });

      // Exhaust the pool
      for (let i = 1; i <= 2; i++) {
        const mac = new MACAddress(`AA:BB:CC:DD:EE:0${i}`);
        const discover = DHCPPacket.createDiscover(mac);
        const offer = router.handleDHCPPacket('eth0', discover)!;
        const request = DHCPPacket.createRequest(offer, mac);
        router.handleDHCPPacket('eth0', request);
      }

      // Third client should get null
      const mac3 = new MACAddress('AA:BB:CC:DD:EE:03');
      const discover3 = DHCPPacket.createDiscover(mac3);
      const offer3 = router.handleDHCPPacket('eth0', discover3);

      expect(offer3).toBeNull();
    });
  });

  describe('DHCP Server Statistics', () => {
    it('should track DHCP statistics', () => {
      const router = new Router('r1', 'DHCP Router', 2);
      router.powerOn();
      router.setIPAddress('eth0', new IPAddress('192.168.1.1'), new SubnetMask('/24'));
      router.enableDHCPServer({
        interfaceName: 'eth0',
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.200')
      });

      const dhcpServer = router.getDHCPServer('eth0')!;

      // Complete DORA for one client
      const mac = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(mac);
      router.handleDHCPPacket('eth0', discover);
      const offer = router.handleDHCPPacket('eth0', discover)!;
      const request = DHCPPacket.createRequest(offer, mac);
      router.handleDHCPPacket('eth0', request);

      const stats = dhcpServer.getStatistics();
      expect(stats.discoversReceived).toBeGreaterThanOrEqual(1);
      expect(stats.offersSent).toBeGreaterThanOrEqual(1);
      expect(stats.requestsReceived).toBeGreaterThanOrEqual(1);
      expect(stats.acksSent).toBeGreaterThanOrEqual(1);
      expect(stats.activeLeases).toBe(1);
    });
  });
});
