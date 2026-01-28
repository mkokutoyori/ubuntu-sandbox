/**
 * DHCPPacket Unit Tests
 * TDD approach - tests written before implementation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DHCPPacket,
  DHCPMessageType,
  DHCPOperation,
  DHCPOption,
  DHCPPacketConfig
} from '../../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { MACAddress } from '../../../domain/network/value-objects/MACAddress';

describe('DHCPPacket', () => {
  describe('Construction', () => {
    it('should create a DHCP DISCOVER packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC,
        messageType: DHCPMessageType.DISCOVER
      });

      expect(packet.getOperation()).toBe(DHCPOperation.BOOTREQUEST);
      expect(packet.getTransactionId()).toBe(0x12345678);
      expect(packet.getClientMAC().equals(clientMAC)).toBe(true);
      expect(packet.getMessageType()).toBe(DHCPMessageType.DISCOVER);
    });

    it('should create a DHCP OFFER packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const offeredIP = new IPAddress('192.168.1.100');
      const serverIP = new IPAddress('192.168.1.1');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREPLY,
        transactionId: 0x12345678,
        clientMAC,
        yourIP: offeredIP,
        serverIP,
        messageType: DHCPMessageType.OFFER,
        options: [
          { code: DHCPOption.SUBNET_MASK, data: new IPAddress('255.255.255.0').toBytes() },
          { code: DHCPOption.ROUTER, data: new IPAddress('192.168.1.1').toBytes() },
          { code: DHCPOption.LEASE_TIME, data: [0, 0, 0x0E, 0x10] } // 3600 seconds
        ]
      });

      expect(packet.getOperation()).toBe(DHCPOperation.BOOTREPLY);
      expect(packet.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(packet.getServerIP()?.toString()).toBe('192.168.1.1');
      expect(packet.getMessageType()).toBe(DHCPMessageType.OFFER);
    });

    it('should create a DHCP REQUEST packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const requestedIP = new IPAddress('192.168.1.100');
      const serverIP = new IPAddress('192.168.1.1');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC,
        messageType: DHCPMessageType.REQUEST,
        options: [
          { code: DHCPOption.REQUESTED_IP, data: requestedIP.toBytes() },
          { code: DHCPOption.SERVER_IDENTIFIER, data: serverIP.toBytes() }
        ]
      });

      expect(packet.getMessageType()).toBe(DHCPMessageType.REQUEST);
      expect(packet.getRequestedIP()?.toString()).toBe('192.168.1.100');
      expect(packet.getServerIdentifier()?.toString()).toBe('192.168.1.1');
    });

    it('should create a DHCP ACK packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const assignedIP = new IPAddress('192.168.1.100');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREPLY,
        transactionId: 0x12345678,
        clientMAC,
        yourIP: assignedIP,
        messageType: DHCPMessageType.ACK,
        options: [
          { code: DHCPOption.SUBNET_MASK, data: new IPAddress('255.255.255.0').toBytes() },
          { code: DHCPOption.ROUTER, data: new IPAddress('192.168.1.1').toBytes() },
          { code: DHCPOption.DNS_SERVERS, data: [...new IPAddress('8.8.8.8').toBytes(), ...new IPAddress('8.8.4.4').toBytes()] },
          { code: DHCPOption.LEASE_TIME, data: [0, 0, 0x1C, 0x20] } // 7200 seconds
        ]
      });

      expect(packet.getMessageType()).toBe(DHCPMessageType.ACK);
      expect(packet.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(packet.getSubnetMask()?.toString()).toBe('255.255.255.0');
      expect(packet.getRouter()?.toString()).toBe('192.168.1.1');
      expect(packet.getDNSServers()).toHaveLength(2);
      expect(packet.getLeaseTime()).toBe(7200);
    });

    it('should create a DHCP NAK packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREPLY,
        transactionId: 0x12345678,
        clientMAC,
        messageType: DHCPMessageType.NAK
      });

      expect(packet.getMessageType()).toBe(DHCPMessageType.NAK);
    });

    it('should create a DHCP RELEASE packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const clientIP = new IPAddress('192.168.1.100');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC,
        clientIP,
        messageType: DHCPMessageType.RELEASE
      });

      expect(packet.getMessageType()).toBe(DHCPMessageType.RELEASE);
      expect(packet.getClientIP()?.toString()).toBe('192.168.1.100');
    });

    it('should set broadcast flag by default for DISCOVER', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER
      });

      expect(packet.isBroadcast()).toBe(true);
    });

    it('should allow disabling broadcast flag', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER,
        broadcast: false
      });

      expect(packet.isBroadcast()).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should serialize DHCP packet to bytes', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC,
        messageType: DHCPMessageType.DISCOVER
      });

      const bytes = packet.toBytes();

      // Minimum DHCP packet size: 240 bytes (without options) + options
      expect(bytes.length).toBeGreaterThanOrEqual(240);

      // Check magic cookie at offset 236
      expect(bytes[236]).toBe(0x63);
      expect(bytes[237]).toBe(0x82);
      expect(bytes[238]).toBe(0x53);
      expect(bytes[239]).toBe(0x63);

      // Check operation (offset 0)
      expect(bytes[0]).toBe(1); // BOOTREQUEST

      // Check hardware type (offset 1)
      expect(bytes[1]).toBe(1); // Ethernet

      // Check hardware address length (offset 2)
      expect(bytes[2]).toBe(6);

      // Check transaction ID (offset 4-7)
      expect(bytes.readUInt32BE(4)).toBe(0x12345678);
    });

    it('should deserialize DHCP packet from bytes', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const offeredIP = new IPAddress('192.168.1.100');

      const original = new DHCPPacket({
        operation: DHCPOperation.BOOTREPLY,
        transactionId: 0xABCDEF12,
        clientMAC,
        yourIP: offeredIP,
        messageType: DHCPMessageType.OFFER,
        options: [
          { code: DHCPOption.SUBNET_MASK, data: new IPAddress('255.255.255.0').toBytes() },
          { code: DHCPOption.ROUTER, data: new IPAddress('192.168.1.1').toBytes() },
          { code: DHCPOption.LEASE_TIME, data: [0, 0, 0x0E, 0x10] }
        ]
      });

      const bytes = original.toBytes();
      const restored = DHCPPacket.fromBytes(bytes);

      expect(restored.getOperation()).toBe(original.getOperation());
      expect(restored.getTransactionId()).toBe(original.getTransactionId());
      expect(restored.getClientMAC().toString()).toBe(clientMAC.toString());
      expect(restored.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(restored.getMessageType()).toBe(DHCPMessageType.OFFER);
      expect(restored.getSubnetMask()?.toString()).toBe('255.255.255.0');
      expect(restored.getRouter()?.toString()).toBe('192.168.1.1');
      expect(restored.getLeaseTime()).toBe(3600);
    });

    it('should handle packet with multiple DNS servers', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREPLY,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        yourIP: new IPAddress('192.168.1.100'),
        messageType: DHCPMessageType.ACK,
        options: [
          {
            code: DHCPOption.DNS_SERVERS,
            data: [
              ...new IPAddress('8.8.8.8').toBytes(),
              ...new IPAddress('8.8.4.4').toBytes(),
              ...new IPAddress('1.1.1.1').toBytes()
            ]
          }
        ]
      });

      const bytes = packet.toBytes();
      const restored = DHCPPacket.fromBytes(bytes);

      const dnsServers = restored.getDNSServers();
      expect(dnsServers).toHaveLength(3);
      expect(dnsServers[0].toString()).toBe('8.8.8.8');
      expect(dnsServers[1].toString()).toBe('8.8.4.4');
      expect(dnsServers[2].toString()).toBe('1.1.1.1');
    });

    it('should throw error for invalid packet size', () => {
      const tooSmall = Buffer.alloc(100);
      expect(() => DHCPPacket.fromBytes(tooSmall)).toThrow();
    });

    it('should throw error for invalid magic cookie', () => {
      const buffer = Buffer.alloc(300);
      // Invalid magic cookie
      buffer[236] = 0x00;
      buffer[237] = 0x00;
      buffer[238] = 0x00;
      buffer[239] = 0x00;

      expect(() => DHCPPacket.fromBytes(buffer)).toThrow('Invalid DHCP magic cookie');
    });
  });

  describe('Factory Methods', () => {
    it('should create DISCOVER packet with factory method', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');

      const packet = DHCPPacket.createDiscover(clientMAC);

      expect(packet.getOperation()).toBe(DHCPOperation.BOOTREQUEST);
      expect(packet.getMessageType()).toBe(DHCPMessageType.DISCOVER);
      expect(packet.getClientMAC().equals(clientMAC)).toBe(true);
      expect(packet.isBroadcast()).toBe(true);
      expect(packet.getTransactionId()).toBeGreaterThan(0);
    });

    it('should create OFFER packet from DISCOVER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offeredIP = new IPAddress('192.168.1.100');
      const serverIP = new IPAddress('192.168.1.1');
      const subnetMask = new IPAddress('255.255.255.0');
      const gateway = new IPAddress('192.168.1.1');
      const dnsServers = [new IPAddress('8.8.8.8')];
      const leaseTime = 3600;

      const offer = DHCPPacket.createOffer(
        discover,
        offeredIP,
        serverIP,
        subnetMask,
        gateway,
        dnsServers,
        leaseTime
      );

      expect(offer.getOperation()).toBe(DHCPOperation.BOOTREPLY);
      expect(offer.getMessageType()).toBe(DHCPMessageType.OFFER);
      expect(offer.getTransactionId()).toBe(discover.getTransactionId());
      expect(offer.getClientMAC().equals(clientMAC)).toBe(true);
      expect(offer.getYourIP()?.toString()).toBe('192.168.1.100');
      expect(offer.getServerIP()?.toString()).toBe('192.168.1.1');
      expect(offer.getSubnetMask()?.toString()).toBe('255.255.255.0');
      expect(offer.getRouter()?.toString()).toBe('192.168.1.1');
      expect(offer.getLeaseTime()).toBe(3600);
    });

    it('should create REQUEST packet from OFFER', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const discover = DHCPPacket.createDiscover(clientMAC);

      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );

      const request = DHCPPacket.createRequest(offer, clientMAC);

      expect(request.getOperation()).toBe(DHCPOperation.BOOTREQUEST);
      expect(request.getMessageType()).toBe(DHCPMessageType.REQUEST);
      expect(request.getTransactionId()).toBe(offer.getTransactionId());
      expect(request.getRequestedIP()?.toString()).toBe('192.168.1.100');
      expect(request.getServerIdentifier()?.toString()).toBe('192.168.1.1');
    });

    it('should create ACK packet from REQUEST', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      const request = DHCPPacket.createRequest(offer, clientMAC);

      const ack = DHCPPacket.createAck(
        request,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );

      expect(ack.getOperation()).toBe(DHCPOperation.BOOTREPLY);
      expect(ack.getMessageType()).toBe(DHCPMessageType.ACK);
      expect(ack.getTransactionId()).toBe(request.getTransactionId());
      expect(ack.getYourIP()?.toString()).toBe('192.168.1.100');
    });

    it('should create NAK packet from REQUEST', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const discover = DHCPPacket.createDiscover(clientMAC);
      const offer = DHCPPacket.createOffer(
        discover,
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [new IPAddress('8.8.8.8')],
        3600
      );
      const request = DHCPPacket.createRequest(offer, clientMAC);

      const nak = DHCPPacket.createNak(request, new IPAddress('192.168.1.1'));

      expect(nak.getOperation()).toBe(DHCPOperation.BOOTREPLY);
      expect(nak.getMessageType()).toBe(DHCPMessageType.NAK);
      expect(nak.getTransactionId()).toBe(request.getTransactionId());
    });

    it('should create RELEASE packet', () => {
      const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
      const clientIP = new IPAddress('192.168.1.100');
      const serverIP = new IPAddress('192.168.1.1');

      const release = DHCPPacket.createRelease(clientIP, clientMAC, serverIP);

      expect(release.getOperation()).toBe(DHCPOperation.BOOTREQUEST);
      expect(release.getMessageType()).toBe(DHCPMessageType.RELEASE);
      expect(release.getClientIP()?.toString()).toBe('192.168.1.100');
      expect(release.getServerIdentifier()?.toString()).toBe('192.168.1.1');
    });
  });

  describe('Option Helpers', () => {
    it('should get parameter request list', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER,
        options: [
          {
            code: DHCPOption.PARAMETER_REQUEST_LIST,
            data: [
              DHCPOption.SUBNET_MASK,
              DHCPOption.ROUTER,
              DHCPOption.DNS_SERVERS,
              DHCPOption.DOMAIN_NAME
            ]
          }
        ]
      });

      const requestList = packet.getParameterRequestList();
      expect(requestList).toContain(DHCPOption.SUBNET_MASK);
      expect(requestList).toContain(DHCPOption.ROUTER);
      expect(requestList).toContain(DHCPOption.DNS_SERVERS);
      expect(requestList).toContain(DHCPOption.DOMAIN_NAME);
    });

    it('should get domain name option', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREPLY,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.ACK,
        options: [
          {
            code: DHCPOption.DOMAIN_NAME,
            data: Array.from(Buffer.from('example.com'))
          }
        ]
      });

      expect(packet.getDomainName()).toBe('example.com');
    });

    it('should return undefined for missing options', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER
      });

      expect(packet.getSubnetMask()).toBeUndefined();
      expect(packet.getRouter()).toBeUndefined();
      expect(packet.getDNSServers()).toEqual([]);
      expect(packet.getLeaseTime()).toBeUndefined();
      expect(packet.getDomainName()).toBeUndefined();
    });
  });

  describe('Message Type Names', () => {
    it('should return correct message type names', () => {
      const types = [
        { type: DHCPMessageType.DISCOVER, name: 'DHCPDISCOVER' },
        { type: DHCPMessageType.OFFER, name: 'DHCPOFFER' },
        { type: DHCPMessageType.REQUEST, name: 'DHCPREQUEST' },
        { type: DHCPMessageType.DECLINE, name: 'DHCPDECLINE' },
        { type: DHCPMessageType.ACK, name: 'DHCPACK' },
        { type: DHCPMessageType.NAK, name: 'DHCPNAK' },
        { type: DHCPMessageType.RELEASE, name: 'DHCPRELEASE' },
        { type: DHCPMessageType.INFORM, name: 'DHCPINFORM' }
      ];

      for (const { type, name } of types) {
        const packet = new DHCPPacket({
          operation: DHCPOperation.BOOTREQUEST,
          transactionId: 0x12345678,
          clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
          messageType: type
        });

        expect(packet.getMessageTypeName()).toBe(name);
      }
    });
  });

  describe('Validation', () => {
    it('should validate hardware type is Ethernet', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER
      });

      expect(packet.getHardwareType()).toBe(1); // Ethernet
      expect(packet.getHardwareAddressLength()).toBe(6);
    });

    it('should handle secs field (seconds elapsed)', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER,
        secs: 5
      });

      expect(packet.getSecs()).toBe(5);
    });

    it('should handle hops field for relay agents', () => {
      const packet = new DHCPPacket({
        operation: DHCPOperation.BOOTREQUEST,
        transactionId: 0x12345678,
        clientMAC: new MACAddress('AA:BB:CC:DD:EE:FF'),
        messageType: DHCPMessageType.DISCOVER,
        hops: 1,
        gatewayIP: new IPAddress('192.168.1.1')
      });

      expect(packet.getHops()).toBe(1);
      expect(packet.getGatewayIP()?.toString()).toBe('192.168.1.1');
    });
  });
});
