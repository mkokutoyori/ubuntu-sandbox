/**
 * DHCPService Unit Tests
 * Tests for both DHCP Server and Client functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DHCPServerService,
  DHCPClientService,
  DHCPLease,
  DHCPServerConfig,
  DHCPClientState,
  DHCPServerStatistics
} from '../../../domain/network/services/DHCPService';
import { DHCPPacket, DHCPMessageType, DHCPOption } from '../../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { MACAddress } from '../../../domain/network/value-objects/MACAddress';

describe('DHCPServerService', () => {
  let serverService: DHCPServerService;
  const defaultConfig: DHCPServerConfig = {
    serverIP: new IPAddress('192.168.1.1'),
    poolStart: new IPAddress('192.168.1.100'),
    poolEnd: new IPAddress('192.168.1.200'),
    subnetMask: new IPAddress('255.255.255.0'),
    gateway: new IPAddress('192.168.1.1'),
    dnsServers: [new IPAddress('8.8.8.8'), new IPAddress('8.8.4.4')],
    leaseTime: 86400, // 24 hours
    domainName: 'example.local'
  };

  beforeEach(() => {
    serverService = new DHCPServerService(defaultConfig);
  });

  describe('Configuration', () => {
    it('should initialize with correct configuration', () => {
      expect(serverService.getServerIP().toString()).toBe('192.168.1.1');
      expect(serverService.getPoolStart().toString()).toBe('192.168.1.100');
      expect(serverService.getPoolEnd().toString()).toBe('192.168.1.200');
      expect(serverService.getSubnetMask().toString()).toBe('255.255.255.0');
    });

    it('should calculate pool size correctly', () => {
      expect(serverService.getPoolSize()).toBe(101); // 100 to 200 inclusive
    });

    it('should report available addresses correctly', () => {
      expect(serverService.getAvailableCount()).toBe(101);
    });
  });

  describe('DISCOVER Handling', () => {
    it('should respond to DISCOVER with OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = serverService.handleDiscover(discover);

      expect(offer).not.toBeNull();
      expect(offer!.getMessageType()).toBe(DHCPMessageType.OFFER);
      expect(offer!.getYourIP()).toBeDefined();
      expect(offer!.getTransactionId()).toBe(discover.getTransactionId());
    });

    it('should offer same IP for same MAC within timeout', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      const discover1 = DHCPPacket.createDiscover(clientMAC);
      const offer1 = serverService.handleDiscover(discover1);

      const discover2 = DHCPPacket.createDiscover(clientMAC);
      const offer2 = serverService.handleDiscover(discover2);

      expect(offer1!.getYourIP()?.toString()).toBe(offer2!.getYourIP()?.toString());
    });

    it('should offer different IPs to different clients', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');

      const discover1 = DHCPPacket.createDiscover(mac1);
      const offer1 = serverService.handleDiscover(discover1);

      const discover2 = DHCPPacket.createDiscover(mac2);
      const offer2 = serverService.handleDiscover(discover2);

      expect(offer1!.getYourIP()?.toString()).not.toBe(offer2!.getYourIP()?.toString());
    });

    it('should return null when pool is exhausted', () => {
      // Create a small pool
      const smallPoolConfig: DHCPServerConfig = {
        ...defaultConfig,
        poolStart: new IPAddress('192.168.1.100'),
        poolEnd: new IPAddress('192.168.1.101') // Only 2 addresses
      };
      const smallServer = new DHCPServerService(smallPoolConfig);

      // Exhaust the pool
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');
      const mac3 = new MACAddress('AA:BB:CC:DD:EE:03');

      smallServer.handleDiscover(DHCPPacket.createDiscover(mac1));
      smallServer.handleDiscover(DHCPPacket.createDiscover(mac2));

      // Request a third IP - should fail
      const discover3 = DHCPPacket.createDiscover(mac3);
      const offer3 = smallServer.handleDiscover(discover3);

      expect(offer3).toBeNull();
    });

    it('should honor requested IP if available', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const requestedIP = new IPAddress('192.168.1.150');
      const discover = DHCPPacket.createDiscover(clientMAC, undefined, requestedIP);

      const offer = serverService.handleDiscover(discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.150');
    });

    it('should ignore requested IP outside pool', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const requestedIP = new IPAddress('192.168.1.50'); // Outside pool
      const discover = DHCPPacket.createDiscover(clientMAC, undefined, requestedIP);

      const offer = serverService.handleDiscover(discover);

      expect(offer!.getYourIP()?.toString()).not.toBe('192.168.1.50');
    });
  });

  describe('REQUEST Handling', () => {
    it('should respond to valid REQUEST with ACK', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);

      const ack = serverService.handleRequest(request);

      expect(ack).not.toBeNull();
      expect(ack!.getMessageType()).toBe(DHCPMessageType.ACK);
      expect(ack!.getYourIP()?.toString()).toBe(offer.getYourIP()?.toString());
    });

    it('should create lease after ACK', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);

      serverService.handleRequest(request);

      const lease = serverService.getLease(clientMAC);
      expect(lease).toBeDefined();
      expect(lease!.ipAddress.toString()).toBe(offer.getYourIP()?.toString());
      expect(lease!.macAddress.equals(clientMAC)).toBe(true);
    });

    it('should respond with NAK for invalid REQUEST', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      // Create request for IP that wasn't offered
      const fakeOffer = DHCPPacket.createOffer(
        DHCPPacket.createDiscover(clientMAC),
        new IPAddress('192.168.1.99'), // Different IP
        defaultConfig.serverIP,
        defaultConfig.subnetMask,
        defaultConfig.gateway,
        defaultConfig.dnsServers,
        defaultConfig.leaseTime
      );
      const request = DHCPPacket.createRequest(fakeOffer, clientMAC);

      const response = serverService.handleRequest(request);

      expect(response!.getMessageType()).toBe(DHCPMessageType.NAK);
    });

    it('should respond with NAK for wrong server identifier', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;

      // Create request with wrong server identifier
      const requestPacket = new DHCPPacket({
        operation: 1,
        transactionId: offer.getTransactionId(),
        clientMAC,
        messageType: DHCPMessageType.REQUEST,
        options: [
          { code: DHCPOption.REQUESTED_IP, data: offer.getYourIP()!.toBytes() },
          { code: DHCPOption.SERVER_IDENTIFIER, data: new IPAddress('10.0.0.1').toBytes() }
        ]
      });

      const response = serverService.handleRequest(requestPacket);

      // Should be null (not for us) or NAK
      expect(response === null || response.getMessageType() === DHCPMessageType.NAK).toBe(true);
    });
  });

  describe('RELEASE Handling', () => {
    it('should release IP address on RELEASE', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');

      // Complete DORA
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;
      const request = DHCPPacket.createRequest(offer, clientMAC);
      serverService.handleRequest(request);

      const assignedIP = offer.getYourIP()!;

      // Release the IP
      const release = DHCPPacket.createRelease(assignedIP, clientMAC, defaultConfig.serverIP);
      serverService.handleRelease(release);

      // Check lease is removed
      const lease = serverService.getLease(clientMAC);
      expect(lease).toBeUndefined();
    });

    it('should make released IP available again', () => {
      const clientMAC1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const clientMAC2 = new MACAddress('AA:BB:CC:DD:EE:02');

      // Client 1 gets an IP
      const discover1 = DHCPPacket.createDiscover(clientMAC1);
      const offer1 = serverService.handleDiscover(discover1)!;
      const request1 = DHCPPacket.createRequest(offer1, clientMAC1);
      serverService.handleRequest(request1);
      const ip1 = offer1.getYourIP()!;

      // Client 1 releases
      const release = DHCPPacket.createRelease(ip1, clientMAC1, defaultConfig.serverIP);
      serverService.handleRelease(release);

      // Client 2 requests the same IP
      const discover2 = DHCPPacket.createDiscover(clientMAC2, undefined, ip1);
      const offer2 = serverService.handleDiscover(discover2)!;

      expect(offer2.getYourIP()?.toString()).toBe(ip1.toString());
    });
  });

  describe('DECLINE Handling', () => {
    it('should mark declined IP as unavailable', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;
      const declinedIP = offer.getYourIP()!;

      // Client declines (detected IP conflict)
      const decline = DHCPPacket.createDecline(declinedIP, clientMAC, defaultConfig.serverIP);
      serverService.handleDecline(decline);

      // Try to get the same IP - should not be offered
      const discover2 = DHCPPacket.createDiscover(clientMAC, undefined, declinedIP);
      const offer2 = serverService.handleDiscover(discover2)!;

      expect(offer2.getYourIP()?.toString()).not.toBe(declinedIP.toString());
    });
  });

  describe('Lease Management', () => {
    it('should list all active leases', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');

      // Create two leases
      const discover1 = DHCPPacket.createDiscover(mac1);
      const offer1 = serverService.handleDiscover(discover1)!;
      serverService.handleRequest(DHCPPacket.createRequest(offer1, mac1));

      const discover2 = DHCPPacket.createDiscover(mac2);
      const offer2 = serverService.handleDiscover(discover2)!;
      serverService.handleRequest(DHCPPacket.createRequest(offer2, mac2));

      const leases = serverService.getActiveLeases();
      expect(leases.length).toBe(2);
    });

    it('should find lease by IP address', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;
      serverService.handleRequest(DHCPPacket.createRequest(offer, clientMAC));

      const lease = serverService.getLeaseByIP(offer.getYourIP()!);
      expect(lease).toBeDefined();
      expect(lease!.macAddress.equals(clientMAC)).toBe(true);
    });

    it('should expire old leases', () => {
      vi.useFakeTimers();

      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:01');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = serverService.handleDiscover(discover)!;
      serverService.handleRequest(DHCPPacket.createRequest(offer, clientMAC));

      // Fast forward past lease time
      vi.advanceTimersByTime(86400 * 1000 + 1000);

      serverService.cleanExpiredLeases();
      const lease = serverService.getLease(clientMAC);
      expect(lease).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('Reservations', () => {
    it('should support static IP reservations', () => {
      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.200');

      serverService.addReservation(reservedMAC, reservedIP);

      const discover = DHCPPacket.createDiscover(reservedMAC);
      const offer = serverService.handleDiscover(discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.200');
    });

    it('should not assign reserved IP to other clients', () => {
      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.150');
      const otherMAC = new MACAddress('11:22:33:44:55:66');

      serverService.addReservation(reservedMAC, reservedIP);

      // Other client requests the reserved IP
      const discover = DHCPPacket.createDiscover(otherMAC, undefined, reservedIP);
      const offer = serverService.handleDiscover(discover);

      expect(offer!.getYourIP()?.toString()).not.toBe('192.168.1.150');
    });

    it('should list reservations', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');
      const ip1 = new IPAddress('192.168.1.101');
      const ip2 = new IPAddress('192.168.1.102');

      serverService.addReservation(mac1, ip1);
      serverService.addReservation(mac2, ip2);

      const reservations = serverService.getReservations();
      expect(reservations.size).toBe(2);
    });

    it('should remove reservation', () => {
      const reservedMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const reservedIP = new IPAddress('192.168.1.200');

      serverService.addReservation(reservedMAC, reservedIP);
      serverService.removeReservation(reservedMAC);

      const otherMAC = new MACAddress('11:22:33:44:55:66');
      const discover = DHCPPacket.createDiscover(otherMAC, undefined, reservedIP);
      const offer = serverService.handleDiscover(discover);

      expect(offer!.getYourIP()?.toString()).toBe('192.168.1.200');
    });
  });

  describe('Statistics', () => {
    it('should track DHCP statistics', () => {
      const mac1 = new MACAddress('AA:BB:CC:DD:EE:01');
      const mac2 = new MACAddress('AA:BB:CC:DD:EE:02');

      // Client 1: Full DORA
      const discover1 = DHCPPacket.createDiscover(mac1);
      serverService.handleDiscover(discover1);
      const offer1 = serverService.handleDiscover(discover1)!;
      serverService.handleRequest(DHCPPacket.createRequest(offer1, mac1));

      // Client 2: Only DISCOVER
      serverService.handleDiscover(DHCPPacket.createDiscover(mac2));

      const stats = serverService.getStatistics();
      expect(stats.discoversReceived).toBeGreaterThanOrEqual(2);
      expect(stats.offersSent).toBeGreaterThanOrEqual(2);
      expect(stats.requestsReceived).toBeGreaterThanOrEqual(1);
      expect(stats.acksSent).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('DHCPClientService', () => {
  let clientService: DHCPClientService;
  const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

  beforeEach(() => {
    clientService = new DHCPClientService(clientMAC);
  });

  describe('State Machine', () => {
    it('should start in INIT state', () => {
      expect(clientService.getState()).toBe(DHCPClientState.INIT);
    });

    it('should transition to SELECTING after sending DISCOVER', () => {
      clientService.startDiscover();
      expect(clientService.getState()).toBe(DHCPClientState.SELECTING);
    });

    it('should create DISCOVER packet', () => {
      const discover = clientService.createDiscover();
      expect(discover.getMessageType()).toBe(DHCPMessageType.DISCOVER);
      expect(discover.getClientMAC().equals(clientMAC)).toBe(true);
    });

    it('should create DISCOVER with hostname', () => {
      const clientWithHostname = new DHCPClientService(clientMAC, 'my-pc');
      const discover = clientWithHostname.createDiscover();
      expect(discover.getHostname()).toBe('my-pc');
    });
  });

  describe('OFFER Handling', () => {
    it('should select first valid OFFER', () => {
      clientService.startDiscover();

      const serverIP = new IPAddress('192.168.1.1');
      const offeredIP = new IPAddress('192.168.1.100');
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        offeredIP,
        serverIP,
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );

      const result = clientService.handleOffer(offer);
      expect(result).toBe(true);
      expect(clientService.getState()).toBe(DHCPClientState.REQUESTING);
      expect(clientService.getSelectedOffer()).not.toBeNull();
    });

    it('should reject OFFER with wrong transaction ID', () => {
      clientService.startDiscover();
      clientService.createDiscover();

      const wrongOffer = new DHCPPacket({
        operation: 2,
        transactionId: 0xDEADBEEF, // Wrong XID
        clientMAC,
        yourIP: new IPAddress('192.168.1.100'),
        messageType: DHCPMessageType.OFFER
      });

      const result = clientService.handleOffer(wrongOffer);
      expect(result).toBe(false);
      expect(clientService.getState()).toBe(DHCPClientState.SELECTING);
    });

    it('should reject OFFER when not in SELECTING state', () => {
      const offer = new DHCPPacket({
        operation: 2,
        transactionId: 0x12345678,
        clientMAC,
        yourIP: new IPAddress('192.168.1.100'),
        messageType: DHCPMessageType.OFFER
      });

      const result = clientService.handleOffer(offer);
      expect(result).toBe(false);
    });
  });

  describe('REQUEST Creation', () => {
    it('should create REQUEST after accepting OFFER', () => {
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );

      clientService.handleOffer(offer);
      const request = clientService.createRequest();

      expect(request).not.toBeNull();
      expect(request!.getMessageType()).toBe(DHCPMessageType.REQUEST);
      expect(request!.getRequestedIP()?.toString()).toBe('192.168.1.100');
    });

    it('should return null if no offer selected', () => {
      const request = clientService.createRequest();
      expect(request).toBeNull();
    });
  });

  describe('ACK Handling', () => {
    it('should transition to BOUND after receiving ACK', () => {
      // Complete DORA
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);
      clientService.createRequest();

      const ack = DHCPPacket.createAck(
        clientService.createRequest()!,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );

      const result = clientService.handleAck(ack);
      expect(result).toBe(true);
      expect(clientService.getState()).toBe(DHCPClientState.BOUND);
    });

    it('should store lease information after ACK', () => {
      // Complete DORA
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);

      const ack = DHCPPacket.createAck(
        clientService.createRequest()!,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleAck(ack);

      const leaseInfo = clientService.getLeaseInfo();
      expect(leaseInfo).not.toBeNull();
      expect(leaseInfo!.ipAddress.toString()).toBe('192.168.1.100');
      expect(leaseInfo!.subnetMask.toString()).toBe('255.255.255.0');
      expect(leaseInfo!.gateway?.toString()).toBe('192.168.1.1');
      expect(leaseInfo!.dnsServers.length).toBe(1);
      expect(leaseInfo!.leaseTime).toBe(3600);
    });
  });

  describe('NAK Handling', () => {
    it('should transition to INIT after receiving NAK', () => {
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);

      const nak = DHCPPacket.createNak(
        clientService.createRequest()!,
        new IPAddress('192.168.1.1')
      );

      const result = clientService.handleNak(nak);
      expect(result).toBe(true);
      expect(clientService.getState()).toBe(DHCPClientState.INIT);
    });
  });

  describe('RELEASE', () => {
    it('should create RELEASE packet when bound', () => {
      // Complete DORA to get bound
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const serverIP = new IPAddress('192.168.1.1');
      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        serverIP,
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);

      const ack = DHCPPacket.createAck(
        clientService.createRequest()!,
        new IPAddress('192.168.1.100'),
        serverIP,
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleAck(ack);

      const release = clientService.createRelease();
      expect(release).not.toBeNull();
      expect(release!.getMessageType()).toBe(DHCPMessageType.RELEASE);
      expect(release!.getClientIP()?.toString()).toBe('192.168.1.100');
    });

    it('should return null if not bound', () => {
      const release = clientService.createRelease();
      expect(release).toBeNull();
    });

    it('should transition to INIT after release', () => {
      // Complete DORA and release
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);

      const ack = DHCPPacket.createAck(
        clientService.createRequest()!,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleAck(ack);

      clientService.createRelease();
      clientService.release();

      expect(clientService.getState()).toBe(DHCPClientState.INIT);
      expect(clientService.getLeaseInfo()).toBeNull();
    });
  });

  describe('Renewal', () => {
    it('should create REQUEST for renewal when bound', () => {
      // Complete DORA
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);

      const ack = DHCPPacket.createAck(
        clientService.createRequest()!,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleAck(ack);

      const renewRequest = clientService.createRenewRequest();
      expect(renewRequest).not.toBeNull();
      expect(renewRequest!.getMessageType()).toBe(DHCPMessageType.REQUEST);
      expect(renewRequest!.getClientIP()?.toString()).toBe('192.168.1.100');
    });

    it('should transition to RENEWING state', () => {
      // Complete DORA
      clientService.startDiscover();
      const discover = clientService.createDiscover();

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleOffer(offer);

      const ack = DHCPPacket.createAck(
        clientService.createRequest()!,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      clientService.handleAck(ack);

      clientService.startRenewal();
      expect(clientService.getState()).toBe(DHCPClientState.RENEWING);
    });
  });

  describe('Timeout Handling', () => {
    it('should handle DISCOVER timeout', () => {
      vi.useFakeTimers();

      clientService.startDiscover();

      // Simulate timeout (default 10 seconds)
      vi.advanceTimersByTime(11000);

      const isTimeout = clientService.isDiscoverTimeout();
      expect(isTimeout).toBe(true);

      vi.useRealTimers();
    });

    it('should track retry count', () => {
      clientService.startDiscover();
      expect(clientService.getRetryCount()).toBe(0);

      clientService.incrementRetry();
      expect(clientService.getRetryCount()).toBe(1);

      clientService.resetRetry();
      expect(clientService.getRetryCount()).toBe(0);
    });
  });
});
