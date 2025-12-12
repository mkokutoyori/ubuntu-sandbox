/**
 * LinuxPC Device Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC, createLinuxPC } from '../devices/linux/LinuxPC';

describe('LinuxPC', () => {
  let linuxPC: LinuxPC;

  beforeEach(() => {
    linuxPC = createLinuxPC({
      id: 'test-pc-1',
      name: 'Test-PC',
      hostname: 'test-pc',
      interfaces: [
        {
          id: 'eth0-id',
          name: 'eth0',
          type: 'ethernet',
          macAddress: '00:11:22:33:44:55',
          isUp: false,
          speed: '1Gbps',
          duplex: 'auto'
        },
        {
          id: 'eth1-id',
          name: 'eth1',
          type: 'ethernet',
          macAddress: '00:11:22:33:44:66',
          isUp: false,
          speed: '1Gbps',
          duplex: 'auto'
        }
      ]
    });
  });

  describe('Device Properties', () => {
    it('should have correct OS type', () => {
      expect(linuxPC.getOSType()).toBe('linux');
    });

    it('should return correct prompt', () => {
      const prompt = linuxPC.getPrompt();
      expect(prompt).toBe('test-pc:~$ ');
    });

    it('should have correct hostname', () => {
      expect(linuxPC.getHostname()).toBe('test-pc');
    });

    it('should allow changing hostname', () => {
      linuxPC.setHostname('new-hostname');
      expect(linuxPC.getHostname()).toBe('new-hostname');
    });

    it('should have network stack', () => {
      const stack = linuxPC.getNetworkStack();
      expect(stack).toBeDefined();
    });
  });

  describe('ifconfig Command', () => {
    it('should show no interfaces when all are down', () => {
      const result = linuxPC.executeCommand('ifconfig');
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('');
    });

    it('should show interface when up', () => {
      linuxPC.interfaceUp('eth0-id');
      const result = linuxPC.executeCommand('ifconfig');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('eth0');
      expect(result.output).toContain('00:11:22:33:44:55');
    });

    it('should configure interface with IP', () => {
      const result = linuxPC.executeCommand('ifconfig eth0 192.168.1.100 netmask 255.255.255.0');
      expect(result.exitCode).toBe(0);

      const iface = linuxPC.getNetworkStack().getInterfaceByName('eth0');
      expect(iface?.ipAddress).toBe('192.168.1.100');
      expect(iface?.subnetMask).toBe('255.255.255.0');
      expect(iface?.isUp).toBe(true);
    });

    it('should bring interface up', () => {
      const result = linuxPC.executeCommand('ifconfig eth0 up');
      expect(result.exitCode).toBe(0);

      const iface = linuxPC.getNetworkStack().getInterfaceByName('eth0');
      expect(iface?.isUp).toBe(true);
    });

    it('should bring interface down', () => {
      linuxPC.interfaceUp('eth0-id');
      const result = linuxPC.executeCommand('ifconfig eth0 down');
      expect(result.exitCode).toBe(0);

      const iface = linuxPC.getNetworkStack().getInterfaceByName('eth0');
      expect(iface?.isUp).toBe(false);
    });

    it('should return error for non-existent interface', () => {
      const result = linuxPC.executeCommand('ifconfig eth99');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Device not found');
    });

    it('should return error for invalid IP', () => {
      const result = linuxPC.executeCommand('ifconfig eth0 999.999.999.999');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Invalid argument');
    });
  });

  describe('ip Command', () => {
    beforeEach(() => {
      linuxPC.executeCommand('ifconfig eth0 192.168.1.100 netmask 255.255.255.0');
    });

    it('should show usage without arguments', () => {
      const result = linuxPC.executeCommand('ip');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Usage');
    });

    it('should show addresses with ip addr', () => {
      const result = linuxPC.executeCommand('ip addr');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('eth0');
      expect(result.output).toContain('192.168.1.100');
    });

    it('should show links with ip link', () => {
      const result = linuxPC.executeCommand('ip link');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('eth0');
      expect(result.output).toContain('00:11:22:33:44:55');
    });

    it('should show routes with ip route', () => {
      const result = linuxPC.executeCommand('ip route');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('192.168.1.0');
    });

    it('should add static route', () => {
      const result = linuxPC.executeCommand('ip route add 10.0.0.0/24 via 192.168.1.1');
      expect(result.exitCode).toBe(0);

      const routes = linuxPC.getNetworkStack().getRoutingTable();
      const staticRoute = routes.find(r => r.destination === '10.0.0.0');
      expect(staticRoute).toBeDefined();
      expect(staticRoute?.gateway).toBe('192.168.1.1');
    });

    it('should delete route', () => {
      linuxPC.executeCommand('ip route add 10.0.0.0/24 via 192.168.1.1');
      const result = linuxPC.executeCommand('ip route del 10.0.0.0/24');
      expect(result.exitCode).toBe(0);

      const routes = linuxPC.getNetworkStack().getRoutingTable();
      const staticRoute = routes.find(r => r.destination === '10.0.0.0');
      expect(staticRoute).toBeUndefined();
    });

    it('should return error for unknown object', () => {
      const result = linuxPC.executeCommand('ip unknown');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('unknown object');
    });
  });

  describe('hostname Command', () => {
    it('should return current hostname', () => {
      const result = linuxPC.executeCommand('hostname');
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('test-pc');
    });

    it('should set new hostname', () => {
      const result = linuxPC.executeCommand('hostname new-host');
      expect(result.exitCode).toBe(0);
      expect(linuxPC.getHostname()).toBe('new-host');
    });

    it('should show IP with -I flag', () => {
      linuxPC.executeCommand('ifconfig eth0 192.168.1.100 netmask 255.255.255.0');
      const result = linuxPC.executeCommand('hostname -I');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('192.168.1.100');
    });
  });

  describe('arp Command', () => {
    it('should show empty ARP table', () => {
      const result = linuxPC.executeCommand('arp -a');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('empty');
    });

    it('should add static ARP entry', () => {
      linuxPC.executeCommand('arp -s 192.168.1.1 00:AA:BB:CC:DD:EE');
      const result = linuxPC.executeCommand('arp -a');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('192.168.1.1');
      expect(result.output).toContain('00:AA:BB:CC:DD:EE');
    });

    it('should delete ARP entry', () => {
      linuxPC.executeCommand('arp -s 192.168.1.1 00:AA:BB:CC:DD:EE');
      linuxPC.executeCommand('arp -d 192.168.1.1');
      const result = linuxPC.executeCommand('arp -a');
      expect(result.output).toContain('empty');
    });
  });

  describe('route Command', () => {
    beforeEach(() => {
      linuxPC.executeCommand('ifconfig eth0 192.168.1.100 netmask 255.255.255.0');
    });

    it('should show routing table', () => {
      const result = linuxPC.executeCommand('route -n');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Kernel IP routing table');
      expect(result.output).toContain('192.168.1.0');
      expect(result.output).toContain('255.255.255.0');
    });
  });

  describe('ping Command', () => {
    beforeEach(() => {
      linuxPC.executeCommand('ifconfig eth0 192.168.1.100 netmask 255.255.255.0');
    });

    it('should return error without target', () => {
      const result = linuxPC.executeCommand('ping');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Destination address required');
    });

    it('should simulate ping', () => {
      const result = linuxPC.executeCommand('ping 192.168.1.1');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('PING 192.168.1.1');
      expect(result.output).toContain('icmp_seq=');
      expect(result.output).toContain('packets transmitted');
    });

    it('should respect -c count option', () => {
      const result = linuxPC.executeCommand('ping -c 2 192.168.1.1');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('icmp_seq=1');
      expect(result.output).toContain('icmp_seq=2');
      expect(result.output).toContain('2 packets transmitted');
    });

    it('should fail if no interface is up', () => {
      // Create a new PC without configured interfaces
      const newPC = createLinuxPC({
        id: 'test-pc-2',
        name: 'Test-PC-2'
      });

      const result = newPC.executeCommand('ping 192.168.1.1');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('unreachable');
    });
  });

  describe('Unknown Command', () => {
    it('should return error for unknown command', () => {
      const result = linuxPC.executeCommand('unknowncmd');
      expect(result.exitCode).toBe(127);
      expect(result.error).toContain('command not found');
    });
  });

  describe('Power Management', () => {
    it('should be powered on by default', () => {
      expect(linuxPC.getIsPoweredOn()).toBe(true);
    });

    it('should power off', () => {
      linuxPC.powerOff();
      expect(linuxPC.getIsPoweredOn()).toBe(false);
    });

    it('should power on', () => {
      linuxPC.powerOff();
      linuxPC.powerOn();
      expect(linuxPC.getIsPoweredOn()).toBe(true);
    });
  });

  describe('Factory Function', () => {
    it('should create LinuxPC with defaults', () => {
      const pc = createLinuxPC({
        id: 'new-pc',
        name: 'New PC'
      });

      expect(pc).toBeInstanceOf(LinuxPC);
      expect(pc.getId()).toBe('new-pc');
      expect(pc.getName()).toBe('New PC');
      expect(pc.getInterfaces()).toHaveLength(1);
      expect(pc.getInterfaces()[0].name).toBe('eth0');
    });

    it('should use provided hostname', () => {
      const pc = createLinuxPC({
        id: 'new-pc',
        name: 'New PC',
        hostname: 'custom-hostname'
      });

      expect(pc.getHostname()).toBe('custom-hostname');
    });

    it('should generate hostname from name if not provided', () => {
      const pc = createLinuxPC({
        id: 'new-pc',
        name: 'My Test PC!'
      });

      expect(pc.getHostname()).toBe('my-test-pc-');
    });
  });
});
