/**
 * WindowsPC DHCP Client Unit Tests
 * Tests for DHCP client functionality (ipconfig /renew, /release)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '../../../domain/devices/WindowsPC';
import { DHCPPacket, DHCPMessageType } from '../../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { MACAddress } from '../../../domain/network/value-objects/MACAddress';

describe('WindowsPC DHCP Client', () => {
  let windows: WindowsPC;

  beforeEach(() => {
    windows = new WindowsPC({ id: 'pc1', name: 'Windows PC', hostname: 'DESKTOP-TEST' });
  });

  describe('ipconfig /renew Command', () => {
    it('should execute ipconfig /renew', async () => {
      const output = await windows.executeCommand('ipconfig /renew');

      expect(output).toContain('Windows IP Configuration');
    });

    it('should execute ipconfig /renew with adapter name', async () => {
      const output = await windows.executeCommand('ipconfig /renew eth0');

      expect(output).toContain('Windows IP Configuration');
    });

    it('should show error for non-existent adapter', async () => {
      const output = await windows.executeCommand('ipconfig /renew eth99');

      expect(output).toContain('No adapter named');
      expect(output).toContain('eth99');
    });

    it('should enable DHCP after renew', async () => {
      await windows.executeCommand('ipconfig /renew');

      expect(windows.isDHCPEnabled('eth0')).toBe(true);
    });

    it('should send DHCP DISCOVER via callback', async () => {
      const sentPackets: DHCPPacket[] = [];

      windows.setDHCPCallback((packet) => {
        sentPackets.push(packet);
      });

      await windows.executeCommand('ipconfig /renew');

      expect(sentPackets.length).toBeGreaterThanOrEqual(1);
      expect(sentPackets[0].getMessageType()).toBe(DHCPMessageType.DISCOVER);
    });
  });

  describe('ipconfig /release Command', () => {
    it('should execute ipconfig /release', async () => {
      const output = await windows.executeCommand('ipconfig /release');

      expect(output).toContain('Windows IP Configuration');
    });

    it('should show DHCP not enabled error on static adapter', async () => {
      const output = await windows.executeCommand('ipconfig /release');

      expect(output).toContain('DHCP is not enabled on this adapter');
    });

    it('should release DHCP lease after renewal', async () => {
      // First renew to enable DHCP
      await windows.executeCommand('ipconfig /renew');

      // Then release
      const output = await windows.executeCommand('ipconfig /release');

      expect(output).toContain('Ethernet adapter Ethernet');
      expect(output).not.toContain('DHCP is not enabled');
    });

    it('should show error for non-existent adapter', async () => {
      const output = await windows.executeCommand('ipconfig /release eth99');

      expect(output).toContain('No adapter named');
    });
  });

  describe('ipconfig /flushdns Command', () => {
    it('should execute ipconfig /flushdns', async () => {
      const output = await windows.executeCommand('ipconfig /flushdns');

      expect(output).toContain('Successfully flushed the DNS Resolver Cache');
    });
  });

  describe('ipconfig /displaydns Command', () => {
    it('should execute ipconfig /displaydns', async () => {
      const output = await windows.executeCommand('ipconfig /displaydns');

      expect(output).toContain('Windows IP Configuration');
    });
  });

  describe('ipconfig /registerdns Command', () => {
    it('should execute ipconfig /registerdns', async () => {
      const output = await windows.executeCommand('ipconfig /registerdns');

      expect(output).toContain('Registration of the DNS resource records');
      expect(output).toContain('has been initiated');
    });
  });

  describe('Invalid ipconfig Commands', () => {
    it('should show error for invalid switch', async () => {
      const output = await windows.executeCommand('ipconfig /invalid');

      expect(output).toContain('Error: unrecognized or incomplete command line');
      expect(output).toContain('USAGE:');
    });

    it('should show usage help', async () => {
      const output = await windows.executeCommand('ipconfig /invalid');

      expect(output).toContain('/renew');
      expect(output).toContain('/release');
      expect(output).toContain('/flushdns');
    });
  });

  describe('DHCP Callback', () => {
    it('should include client MAC in DISCOVER', async () => {
      const nic = windows.getInterface('eth0');
      const clientMAC = nic?.getMAC();
      let discoverPacket: DHCPPacket | null = null;

      windows.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          discoverPacket = packet;
        }
      });

      await windows.executeCommand('ipconfig /renew');

      expect(discoverPacket).not.toBeNull();
      expect(discoverPacket!.getClientMAC().equals(clientMAC!)).toBe(true);
    });

    it('should include hostname in DISCOVER', async () => {
      let discoverPacket: DHCPPacket | null = null;

      windows.setDHCPCallback((packet) => {
        discoverPacket = packet;
      });

      await windows.executeCommand('ipconfig /renew');

      expect(discoverPacket?.getHostname()).toBe('DESKTOP-TEST');
    });
  });

  describe('DHCP Response Handling', () => {
    it('should handle OFFER and send REQUEST', async () => {
      const sentPackets: DHCPPacket[] = [];

      windows.setDHCPCallback((packet) => {
        sentPackets.push(packet);

        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [new IPAddress('8.8.8.8')],
            3600
          );
          windows.handleDHCPResponse(offer);
        }
      });

      await windows.executeCommand('ipconfig /renew');

      const requestPacket = sentPackets.find(p => p.getMessageType() === DHCPMessageType.REQUEST);
      expect(requestPacket).toBeDefined();
    });

    it('should configure interface after ACK', async () => {
      windows.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [new IPAddress('8.8.8.8')],
            3600
          );
          windows.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const ack = DHCPPacket.createAck(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [new IPAddress('8.8.8.8')],
            3600
          );
          windows.handleDHCPResponse(ack);
        }
      });

      await windows.executeCommand('ipconfig /renew');

      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo).toBeDefined();
      expect(leaseInfo?.ipAddress.toString()).toBe('192.168.1.100');
    });

    it('should handle NAK response', async () => {
      windows.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [],
            3600
          );
          windows.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const nak = DHCPPacket.createNak(packet, new IPAddress('192.168.1.1'));
          windows.handleDHCPResponse(nak);
        }
      });

      await windows.executeCommand('ipconfig /renew');

      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo).toBeUndefined();
    });

    it('should return false for uninitialized response', () => {
      const offer = DHCPPacket.createOffer(
        DHCPPacket.createDiscover(new MACAddress('AA:BB:CC:DD:EE:FF')),
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [],
        3600
      );

      const result = windows.handleDHCPResponse(offer);

      expect(result).toBe(false);
    });
  });

  describe('DHCP Lease Info', () => {
    beforeEach(async () => {
      windows.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('10.0.0.50'),
            new IPAddress('10.0.0.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('10.0.0.1'),
            [new IPAddress('1.1.1.1'), new IPAddress('9.9.9.9')],
            86400
          );
          windows.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const ack = DHCPPacket.createAck(
            packet,
            new IPAddress('10.0.0.50'),
            new IPAddress('10.0.0.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('10.0.0.1'),
            [new IPAddress('1.1.1.1'), new IPAddress('9.9.9.9')],
            86400
          );
          windows.handleDHCPResponse(ack);
        }
      });

      await windows.executeCommand('ipconfig /renew');
    });

    it('should store IP address', () => {
      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo?.ipAddress.toString()).toBe('10.0.0.50');
    });

    it('should store subnet mask', () => {
      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo?.subnetMask.toString()).toBe('255.255.255.0');
    });

    it('should store gateway', () => {
      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo?.gateway?.toString()).toBe('10.0.0.1');
    });

    it('should store DNS servers', () => {
      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo?.dnsServers.length).toBe(2);
      expect(leaseInfo?.dnsServers[0].toString()).toBe('1.1.1.1');
    });

    it('should store lease time', () => {
      const leaseInfo = windows.getDHCPLeaseInfo();
      expect(leaseInfo?.leaseTime).toBe(86400);
    });
  });

  describe('DHCP Client State', () => {
    it('should return undefined state initially', () => {
      const state = windows.getDHCPClientState();
      expect(state).toBeUndefined();
    });

    it('should return state after starting DHCP', async () => {
      windows.setDHCPCallback(() => {});
      await windows.executeCommand('ipconfig /renew');

      const state = windows.getDHCPClientState();
      expect(state).toBeDefined();
    });
  });

  describe('DHCP Enabled State', () => {
    it('should be disabled initially', () => {
      expect(windows.isDHCPEnabled('eth0')).toBe(false);
    });

    it('should be enabled after renew', async () => {
      await windows.executeCommand('ipconfig /renew');

      expect(windows.isDHCPEnabled('eth0')).toBe(true);
    });
  });

  describe('Adapter Display Name', () => {
    it('should display eth0 as Ethernet', async () => {
      windows.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [],
            3600
          );
          windows.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const ack = DHCPPacket.createAck(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [],
            3600
          );
          windows.handleDHCPResponse(ack);
        }
      });

      const output = await windows.executeCommand('ipconfig /renew eth0');

      expect(output).toContain('Ethernet adapter Ethernet');
    });
  });

  describe('Realistic Output', () => {
    it('should show timeout message when no DHCP server responds', async () => {
      const output = await windows.executeCommand('ipconfig /renew');

      expect(output).toContain('unable to connect to your DHCP server');
      expect(output).toContain('Request has timed out');
    });

    it('should show successful renewal with IP info', async () => {
      windows.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [],
            3600
          );
          windows.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const ack = DHCPPacket.createAck(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [],
            3600
          );
          windows.handleDHCPResponse(ack);
        }
      });

      const output = await windows.executeCommand('ipconfig /renew');

      expect(output).toContain('IPv4 Address');
      expect(output).toContain('192.168.1.100');
      expect(output).toContain('Subnet Mask');
      expect(output).toContain('255.255.255.0');
      expect(output).toContain('Default Gateway');
      expect(output).toContain('192.168.1.1');
    });
  });

  describe('Device Offline', () => {
    it('should return offline message when device is off', async () => {
      windows.powerOff();

      const output = await windows.executeCommand('ipconfig /renew');

      expect(output).toBe('Device is offline');
    });
  });
});
