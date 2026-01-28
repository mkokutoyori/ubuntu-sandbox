/**
 * LinuxPC DHCP Client Unit Tests
 * Tests for DHCP client functionality (dhclient command)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '../../../domain/devices/LinuxPC';
import { DHCPPacket, DHCPMessageType } from '../../../domain/network/entities/DHCPPacket';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { MACAddress } from '../../../domain/network/value-objects/MACAddress';

describe('LinuxPC DHCP Client', () => {
  let linux: LinuxPC;

  beforeEach(() => {
    linux = new LinuxPC({ id: 'pc1', name: 'Ubuntu PC', hostname: 'ubuntu-test' });
  });

  describe('dhclient Command', () => {
    it('should execute dhclient command', async () => {
      const output = await linux.executeCommand('dhclient');

      expect(output).toContain('Internet Systems Consortium DHCP Client');
      expect(output).toContain('DHCPDISCOVER');
    });

    it('should execute dhclient with interface argument', async () => {
      const output = await linux.executeCommand('dhclient eth0');

      expect(output).toContain('DHCPDISCOVER on eth0');
    });

    it('should execute dhclient with verbose flag', async () => {
      const output = await linux.executeCommand('dhclient -v eth0');

      expect(output).toContain('Listening on LPF/eth0');
      expect(output).toContain('Sending on   LPF/eth0');
    });

    it('should execute sudo dhclient', async () => {
      const output = await linux.executeCommand('sudo dhclient');

      expect(output).toContain('DHCPDISCOVER');
    });

    it('should show help with --help flag', async () => {
      const output = await linux.executeCommand('dhclient --help');

      expect(output).toContain('Usage: dhclient');
      expect(output).toContain('-r');
      expect(output).toContain('-v');
      expect(output).toContain('-d');
      expect(output).toContain('-1');
      expect(output).toContain('--version');
    });

    it('should show help with -h flag', async () => {
      const output = await linux.executeCommand('dhclient -h');

      expect(output).toContain('Usage: dhclient');
    });

    it('should handle non-existent interface', async () => {
      const output = await linux.executeCommand('dhclient eth99');

      expect(output).toContain("interface 'eth99' not found");
    });
  });

  describe('dhclient Release (-r)', () => {
    it('should execute dhclient -r', async () => {
      const output = await linux.executeCommand('dhclient -r');

      expect(output).toContain('DHCPRELEASE');
    });

    it('should execute dhclient -r with interface', async () => {
      const output = await linux.executeCommand('dhclient -r eth0');

      expect(output).toContain('DHCPRELEASE');
      expect(output).toContain('eth0');
    });

    it('should include MAC address in release output', async () => {
      const nic = linux.getInterface('eth0');
      const mac = nic?.getMAC().toString();

      const output = await linux.executeCommand('dhclient -r eth0');

      expect(output).toContain(mac);
    });

    it('should handle release on non-existent interface', async () => {
      const output = await linux.executeCommand('dhclient -r eth99');

      expect(output).toContain("interface 'eth99' not found");
    });
  });

  describe('DHCP Callback', () => {
    it('should send DISCOVER packet via callback', async () => {
      const sentPackets: DHCPPacket[] = [];

      linux.setDHCPCallback((packet) => {
        sentPackets.push(packet);
      });

      await linux.executeCommand('dhclient eth0');

      expect(sentPackets.length).toBeGreaterThanOrEqual(1);
      expect(sentPackets[0].getMessageType()).toBe(DHCPMessageType.DISCOVER);
    });

    it('should include client MAC in DISCOVER', async () => {
      const nic = linux.getInterface('eth0');
      const clientMAC = nic?.getMAC();
      let discoverPacket: DHCPPacket | null = null;

      linux.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          discoverPacket = packet;
        }
      });

      await linux.executeCommand('dhclient eth0');

      expect(discoverPacket).not.toBeNull();
      expect(discoverPacket!.getClientMAC().equals(clientMAC!)).toBe(true);
    });

    it('should include hostname in DISCOVER', async () => {
      let discoverPacket: DHCPPacket | null = null;

      linux.setDHCPCallback((packet) => {
        discoverPacket = packet;
      });

      await linux.executeCommand('dhclient eth0');

      expect(discoverPacket?.getHostname()).toBe('ubuntu-test');
    });

    it('should send RELEASE via callback', async () => {
      // First get a lease
      linux.setDHCPCallback((packet) => {
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
          linux.handleDHCPResponse(offer);
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
          linux.handleDHCPResponse(ack);
        }
      });

      await linux.executeCommand('dhclient eth0');

      // Now track release
      const sentPackets: DHCPPacket[] = [];
      linux.setDHCPCallback((packet) => {
        sentPackets.push(packet);
      });

      await linux.executeCommand('dhclient -r eth0');

      const releasePacket = sentPackets.find(p => p.getMessageType() === DHCPMessageType.RELEASE);
      expect(releasePacket).toBeDefined();
    });
  });

  describe('DHCP Response Handling', () => {
    it('should handle OFFER and send REQUEST', async () => {
      const sentPackets: DHCPPacket[] = [];

      linux.setDHCPCallback((packet) => {
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
          linux.handleDHCPResponse(offer);
        }
      });

      await linux.executeCommand('dhclient eth0');

      const requestPacket = sentPackets.find(p => p.getMessageType() === DHCPMessageType.REQUEST);
      expect(requestPacket).toBeDefined();
      expect(requestPacket?.getRequestedIP()?.toString()).toBe('192.168.1.100');
    });

    it('should configure interface after ACK', async () => {
      linux.setDHCPCallback((packet) => {
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
          linux.handleDHCPResponse(offer);
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
          linux.handleDHCPResponse(ack);
        }
      });

      await linux.executeCommand('dhclient eth0');

      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo).toBeDefined();
      expect(leaseInfo?.ipAddress.toString()).toBe('192.168.1.100');
      expect(leaseInfo?.subnetMask.toString()).toBe('255.255.255.0');
      expect(leaseInfo?.gateway?.toString()).toBe('192.168.1.1');
    });

    it('should handle NAK response', async () => {
      linux.setDHCPCallback((packet) => {
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
          linux.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const nak = DHCPPacket.createNak(packet, new IPAddress('192.168.1.1'));
          linux.handleDHCPResponse(nak);
        }
      });

      await linux.executeCommand('dhclient eth0');

      // After NAK, lease info should be undefined
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo).toBeUndefined();
    });

    it('should return false for uninitialized response', () => {
      // No dhclient executed, so dhcpClient is undefined
      const offer = DHCPPacket.createOffer(
        DHCPPacket.createDiscover(new MACAddress('AA:BB:CC:DD:EE:FF')),
        new IPAddress('192.168.1.100'),
        new IPAddress('192.168.1.1'),
        new IPAddress('255.255.255.0'),
        new IPAddress('192.168.1.1'),
        [],
        3600
      );

      const result = linux.handleDHCPResponse(offer);

      expect(result).toBe(false);
    });
  });

  describe('DHCP Lease Info', () => {
    beforeEach(async () => {
      linux.setDHCPCallback((packet) => {
        if (packet.getMessageType() === DHCPMessageType.DISCOVER) {
          const offer = DHCPPacket.createOffer(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [new IPAddress('8.8.8.8'), new IPAddress('8.8.4.4')],
            7200
          );
          linux.handleDHCPResponse(offer);
        } else if (packet.getMessageType() === DHCPMessageType.REQUEST) {
          const ack = DHCPPacket.createAck(
            packet,
            new IPAddress('192.168.1.100'),
            new IPAddress('192.168.1.1'),
            new IPAddress('255.255.255.0'),
            new IPAddress('192.168.1.1'),
            [new IPAddress('8.8.8.8'), new IPAddress('8.8.4.4')],
            7200
          );
          linux.handleDHCPResponse(ack);
        }
      });

      await linux.executeCommand('dhclient eth0');
    });

    it('should store IP address', () => {
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo?.ipAddress.toString()).toBe('192.168.1.100');
    });

    it('should store subnet mask', () => {
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo?.subnetMask.toString()).toBe('255.255.255.0');
    });

    it('should store gateway', () => {
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo?.gateway?.toString()).toBe('192.168.1.1');
    });

    it('should store DNS servers', () => {
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo?.dnsServers.length).toBe(2);
      expect(leaseInfo?.dnsServers[0].toString()).toBe('8.8.8.8');
      expect(leaseInfo?.dnsServers[1].toString()).toBe('8.8.4.4');
    });

    it('should store lease time', () => {
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo?.leaseTime).toBe(7200);
    });

    it('should store server IP', () => {
      const leaseInfo = linux.getDHCPLeaseInfo();
      expect(leaseInfo?.serverIP.toString()).toBe('192.168.1.1');
    });
  });

  describe('DHCP Client State', () => {
    it('should return undefined state initially', () => {
      const state = linux.getDHCPClientState();
      expect(state).toBeUndefined();
    });

    it('should return state after starting DHCP', async () => {
      linux.setDHCPCallback(() => {});
      await linux.executeCommand('dhclient eth0');

      const state = linux.getDHCPClientState();
      expect(state).toBeDefined();
    });
  });

  describe('Realistic Output', () => {
    it('should include ISC copyright in output', async () => {
      const output = await linux.executeCommand('dhclient eth0');

      expect(output).toContain('Copyright 2004-2018 Internet Systems Consortium');
      expect(output).toContain('All rights reserved');
      expect(output).toContain('https://www.isc.org/software/dhcp/');
    });

    it('should show timeout message when no DHCP server responds', async () => {
      const output = await linux.executeCommand('dhclient eth0');

      expect(output).toContain('No DHCPOFFERS received');
      expect(output).toContain('No working leases');
    });

    it('should show bound message when lease obtained', async () => {
      linux.setDHCPCallback((packet) => {
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
          linux.handleDHCPResponse(offer);
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
          linux.handleDHCPResponse(ack);
        }
      });

      const output = await linux.executeCommand('dhclient eth0');

      expect(output).toContain('DHCPOFFER of 192.168.1.100');
      expect(output).toContain('DHCPREQUEST');
      expect(output).toContain('DHCPACK');
      expect(output).toContain('bound to 192.168.1.100');
    });
  });

  describe('Device Offline', () => {
    it('should return offline message when device is off', async () => {
      linux.powerOff();

      const output = await linux.executeCommand('dhclient eth0');

      expect(output).toBe('Device is offline');
    });
  });
});
