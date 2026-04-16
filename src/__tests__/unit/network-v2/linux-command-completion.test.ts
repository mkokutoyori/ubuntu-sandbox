/**
 * TDD tests for LinuxCommand.complete — context-aware argument completion.
 *
 * Section 2 of the LinuxCommand enrichment: tab completion for command
 * arguments (interface names for ifconfig/dhclient, IPs for ping, known
 * hosts for arp -d, etc).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { IPAddress, MACAddress } from '@/network/core/types';

describe('LinuxCommand — argument completion', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    pc = new LinuxPC('linux-pc', 'PC1');
  });

  describe('interface-name completion', () => {
    it('completes ifconfig <TAB> with interface names', () => {
      const c = pc.getCompletions('ifconfig ');
      expect(c).toContain('eth0');
      expect(c).toContain('eth1');
      expect(c).toContain('eth2');
      expect(c).toContain('eth3');
    });

    it('completes ifconfig eth<TAB> with matching interfaces', () => {
      const c = pc.getCompletions('ifconfig eth');
      expect(c).toContain('eth0');
      expect(c).toContain('eth1');
      expect(c).not.toContain('lo');
    });

    it('filters ifconfig eth0<TAB> to only eth0', () => {
      const c = pc.getCompletions('ifconfig eth0');
      expect(c).toEqual(['eth0']);
    });

    it('completes dhclient <TAB> with interface names', () => {
      const c = pc.getCompletions('dhclient ');
      expect(c).toContain('eth0');
      expect(c).toContain('eth1');
    });

    it('completes dhclient -v <TAB> with interface names', () => {
      const c = pc.getCompletions('dhclient -v ');
      expect(c).toContain('eth0');
    });

    it('completes dhclient -r <TAB> with interface names', () => {
      const c = pc.getCompletions('dhclient -r ');
      expect(c).toContain('eth0');
    });
  });

  describe('flag completion', () => {
    it('completes ping -<TAB> with flags', () => {
      const c = pc.getCompletions('ping -');
      expect(c).toContain('-c');
      expect(c).toContain('-t');
    });

    it('completes dhclient -<TAB> with flags', () => {
      const c = pc.getCompletions('dhclient -');
      expect(c).toContain('-v');
      expect(c).toContain('-r');
      expect(c).toContain('-x');
    });

    it('completes sysctl -<TAB> with flags', () => {
      const c = pc.getCompletions('sysctl -');
      expect(c).toContain('-w');
      expect(c).toContain('-a');
    });

    it('completes arp -<TAB> with flags', () => {
      const c = pc.getCompletions('arp -');
      expect(c).toContain('-a');
      expect(c).toContain('-d');
    });
  });

  describe('arp host completion', () => {
    it('completes arp -d <TAB> with ARP cache entries', () => {
      pc.addStaticARP('192.168.1.50', new MACAddress('aa:bb:cc:dd:ee:01'), 'eth0');
      pc.addStaticARP('192.168.1.51', new MACAddress('aa:bb:cc:dd:ee:02'), 'eth0');
      const c = pc.getCompletions('arp -d ');
      expect(c).toContain('192.168.1.50');
      expect(c).toContain('192.168.1.51');
    });

    it('filters arp -d 192.168.1.5<TAB>', () => {
      pc.addStaticARP('192.168.1.50', new MACAddress('aa:bb:cc:dd:ee:01'), 'eth0');
      pc.addStaticARP('10.0.0.1', new MACAddress('aa:bb:cc:dd:ee:02'), 'eth0');
      const c = pc.getCompletions('arp -d 192.168.1.5');
      expect(c).toContain('192.168.1.50');
      expect(c).not.toContain('10.0.0.1');
    });
  });

  describe('sysctl parameter completion', () => {
    it('completes sysctl <TAB> with known parameters', () => {
      const c = pc.getCompletions('sysctl ');
      expect(c).toContain('net.ipv4.ip_forward');
    });

    it('completes sysctl -w <TAB> with known parameters', () => {
      const c = pc.getCompletions('sysctl -w ');
      expect(c).toContain('net.ipv4.ip_forward');
    });

    it('filters sysctl net.<TAB>', () => {
      const c = pc.getCompletions('sysctl net.');
      expect(c).toContain('net.ipv4.ip_forward');
    });
  });

  describe('fallback to command name completion', () => {
    it('still completes command names at first word', () => {
      const c = pc.getCompletions('pi');
      expect(c).toContain('ping');
    });

    it('still completes paths for non-network commands', () => {
      const c = pc.getCompletions('ls /');
      expect(Array.isArray(c)).toBe(true);
    });

    it('sudo <cmd> <TAB> delegates to cmd completion', () => {
      const c = pc.getCompletions('sudo ifconfig ');
      expect(c).toContain('eth0');
    });
  });

  describe('man page completion', () => {
    it('completes man <TAB> with network command names', () => {
      const c = pc.getCompletions('man ');
      expect(c).toContain('ping');
      expect(c).toContain('ifconfig');
      expect(c).toContain('traceroute');
    });

    it('filters man p<TAB>', () => {
      const c = pc.getCompletions('man p');
      expect(c).toContain('ping');
    });
  });
});

describe('LinuxCommand — argument completion on LinuxServer', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer('linux-server', 'SRV1');
  });

  it('completes ifconfig <TAB> with interface names on a server', () => {
    const c = server.getCompletions('ifconfig ');
    expect(c).toContain('eth0');
  });

  it('completes dhclient <TAB> with interface names on a server', () => {
    const c = server.getCompletions('dhclient ');
    expect(c).toContain('eth0');
  });
});
