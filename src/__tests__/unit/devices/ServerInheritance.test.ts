/**
 * Server Inheritance Tests
 *
 * Tests that LinuxServer and WindowsServer properly inherit
 * all commands from their parent PC classes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '../../../domain/devices/LinuxPC';
import { LinuxServer } from '../../../domain/devices/LinuxServer';
import { WindowsPC } from '../../../domain/devices/WindowsPC';
import { WindowsServer } from '../../../domain/devices/WindowsServer';
import { IPAddress } from '../../../domain/network/value-objects/IPAddress';
import { SubnetMask } from '../../../domain/network/value-objects/SubnetMask';
import { MACAddress } from '../../../domain/network/value-objects/MACAddress';

describe('LinuxServer Inheritance', () => {
  let server: LinuxServer;

  beforeEach(() => {
    server = new LinuxServer({
      id: 'server1',
      name: 'Test Server'
    });
  });

  describe('Basic Properties', () => {
    it('should have type linux-server', () => {
      expect(server.getType()).toBe('linux-server');
    });

    it('should have default hostname "server"', () => {
      expect(server.getHostname()).toBe('server');
    });

    it('should allow custom hostname', () => {
      const customServer = new LinuxServer({
        id: 'server2',
        name: 'Custom Server',
        hostname: 'myserver'
      });
      expect(customServer.getHostname()).toBe('myserver');
    });

    it('should have 4 network interfaces (eth0-eth3)', () => {
      const interfaces = server.getInterfaces();
      expect(interfaces.length).toBe(4);

      const names = interfaces.map(i => i.getName()).sort();
      expect(names).toEqual(['eth0', 'eth1', 'eth2', 'eth3']);
    });

    it('should have valid MAC addresses on all interfaces', () => {
      const interfaces = server.getInterfaces();
      for (const iface of interfaces) {
        const mac = iface.getMAC();
        expect(mac).toBeInstanceOf(MACAddress);
        expect(mac.toString()).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i);
      }
    });
  });

  describe('Interface Operations', () => {
    it('should get interface by name', () => {
      const eth0 = server.getInterface('eth0');
      expect(eth0).toBeDefined();
      expect(eth0!.getName()).toBe('eth0');
    });

    it('should configure IP on any interface', () => {
      const ip = new IPAddress('192.168.1.10');
      const mask = new SubnetMask('/24');

      server.setIPAddress('eth0', ip, mask);
      server.setIPAddress('eth1', new IPAddress('10.0.0.10'), new SubnetMask('/8'));

      const eth0 = server.getInterface('eth0')!;
      const eth1 = server.getInterface('eth1')!;

      expect(eth0.getIPAddress()?.toString()).toBe('192.168.1.10');
      expect(eth1.getIPAddress()?.toString()).toBe('10.0.0.10');
    });
  });

  describe('Linux Command Inheritance', () => {
    beforeEach(() => {
      server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
    });

    it('should execute pwd command', async () => {
      const result = await server.executeCommand('pwd');
      expect(result).toContain('/home');
    });

    it('should execute hostname command', async () => {
      const result = await server.executeCommand('hostname');
      expect(result).toContain('server');
    });

    it('should execute uname command', async () => {
      const result = await server.executeCommand('uname -a');
      expect(result).toContain('Linux');
    });

    it('should execute ip addr command', async () => {
      const result = await server.executeCommand('ip addr');
      expect(result).toContain('eth0');
      expect(result).toContain('192.168.1.100');
    });

    it('should execute ip link command', async () => {
      const result = await server.executeCommand('ip link');
      expect(result).toContain('eth0');
      expect(result).toContain('eth1');
    });

    it('should execute ip route command', async () => {
      const result = await server.executeCommand('ip route');
      expect(result).toContain('192.168.1.0/24');
    });

    it('should execute nmcli device command', async () => {
      const result = await server.executeCommand('nmcli device');
      expect(result).toContain('eth0');
      expect(result).toContain('ethernet');
    });

    it('should execute ss command', async () => {
      const result = await server.executeCommand('ss -tl');
      expect(result).toContain('State');
    });

    it('should execute iptables command', async () => {
      const result = await server.executeCommand('iptables -L');
      expect(result).toContain('Chain INPUT');
    });

    it('should execute ufw status command', async () => {
      const result = await server.executeCommand('ufw status');
      expect(result).toMatch(/inactive|active/i);
    });

    it('should execute systemctl list-units command', async () => {
      const result = await server.executeCommand('systemctl list-units --type=service');
      expect(result).toContain('ssh');
    });

    it('should execute systemctl status command', async () => {
      const result = await server.executeCommand('systemctl status ssh');
      expect(result).toContain('ssh');
    });

    it('should execute hostnamectl command', async () => {
      const result = await server.executeCommand('hostnamectl');
      expect(result).toContain('hostname');
    });

    it('should execute resolvectl command', async () => {
      const result = await server.executeCommand('resolvectl status');
      expect(result).toContain('DNS');
    });

    it('should execute dig command', async () => {
      const result = await server.executeCommand('dig google.com');
      expect(result).toContain('google.com');
    });

    it('should execute journalctl command', async () => {
      const result = await server.executeCommand('journalctl -n 5');
      expect(result).toBeDefined();
    });

    it('should execute ethtool command', async () => {
      const result = await server.executeCommand('ethtool eth0');
      expect(result).toContain('eth0');
    });

    it('should execute service command (legacy)', async () => {
      const result = await server.executeCommand('service ssh status');
      expect(result).toContain('ssh');
    });
  });

  describe('Service Management', () => {
    it('should start services', async () => {
      await server.executeCommand('systemctl stop nginx');
      let result = await server.executeCommand('systemctl is-active nginx');
      expect(result.trim()).toBe('inactive');

      await server.executeCommand('systemctl start nginx');
      result = await server.executeCommand('systemctl is-active nginx');
      expect(result.trim()).toBe('active');
    });

    it('should stop services', async () => {
      await server.executeCommand('systemctl start nginx');
      await server.executeCommand('systemctl stop nginx');
      const result = await server.executeCommand('systemctl is-active nginx');
      expect(result.trim()).toBe('inactive');
    });

    it('should enable services', async () => {
      await server.executeCommand('systemctl disable nginx');
      await server.executeCommand('systemctl enable nginx');
      const result = await server.executeCommand('systemctl is-enabled nginx');
      expect(result.trim()).toBe('enabled');
    });

    it('should disable services', async () => {
      await server.executeCommand('systemctl enable nginx');
      await server.executeCommand('systemctl disable nginx');
      const result = await server.executeCommand('systemctl is-enabled nginx');
      expect(result.trim()).toBe('disabled');
    });
  });

  describe('Multiple Interfaces', () => {
    it('should show all interfaces in ip addr', async () => {
      server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
      server.setIPAddress('eth1', new IPAddress('10.0.0.100'), new SubnetMask('/8'));
      server.setIPAddress('eth2', new IPAddress('172.16.0.100'), new SubnetMask('/16'));

      const result = await server.executeCommand('ip addr');
      expect(result).toContain('192.168.1.100');
      expect(result).toContain('10.0.0.100');
      expect(result).toContain('172.16.0.100');
    });

    it('should show all interfaces in ip link', async () => {
      const result = await server.executeCommand('ip link');
      expect(result).toContain('eth0');
      expect(result).toContain('eth1');
      expect(result).toContain('eth2');
      expect(result).toContain('eth3');
    });
  });
});

describe('WindowsServer Inheritance', () => {
  let server: WindowsServer;

  beforeEach(() => {
    server = new WindowsServer({
      id: 'server1',
      name: 'Test Server'
    });
  });

  describe('Basic Properties', () => {
    it('should have type windows-server', () => {
      expect(server.getType()).toBe('windows-server');
    });

    it('should have default hostname "SERVER"', () => {
      expect(server.getHostname()).toBe('SERVER');
    });

    it('should allow custom hostname', () => {
      const customServer = new WindowsServer({
        id: 'server2',
        name: 'Custom Server',
        hostname: 'MYSERVER'
      });
      expect(customServer.getHostname()).toBe('MYSERVER');
    });

    it('should have 4 network interfaces (eth0-eth3)', () => {
      const interfaces = server.getInterfaces();
      expect(interfaces.length).toBe(4);

      const names = interfaces.map(i => i.getName()).sort();
      expect(names).toEqual(['eth0', 'eth1', 'eth2', 'eth3']);
    });

    it('should have valid MAC addresses on all interfaces', () => {
      const interfaces = server.getInterfaces();
      for (const iface of interfaces) {
        const mac = iface.getMAC();
        expect(mac).toBeInstanceOf(MACAddress);
        expect(mac.toString()).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i);
      }
    });
  });

  describe('Interface Operations', () => {
    it('should get interface by name', () => {
      const eth0 = server.getInterface('eth0');
      expect(eth0).toBeDefined();
      expect(eth0!.getName()).toBe('eth0');
    });

    it('should configure IP on any interface', () => {
      const ip = new IPAddress('192.168.1.10');
      const mask = new SubnetMask('/24');

      server.setIPAddress('eth0', ip, mask);
      server.setIPAddress('eth1', new IPAddress('10.0.0.10'), new SubnetMask('/8'));

      const eth0 = server.getInterface('eth0')!;
      const eth1 = server.getInterface('eth1')!;

      expect(eth0.getIPAddress()?.toString()).toBe('192.168.1.10');
      expect(eth1.getIPAddress()?.toString()).toBe('10.0.0.10');
    });
  });

  describe('Windows Command Inheritance', () => {
    beforeEach(() => {
      server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
    });

    it('should execute hostname command', async () => {
      const result = await server.executeCommand('hostname');
      expect(result).toContain('SERVER');
    });

    it('should execute whoami command', async () => {
      const result = await server.executeCommand('whoami');
      expect(result).toContain('User');
    });

    it('should execute ver command', async () => {
      const result = await server.executeCommand('ver');
      expect(result).toContain('Windows');
    });

    it('should execute ipconfig command', async () => {
      const result = await server.executeCommand('ipconfig');
      expect(result).toContain('192.168.1.100');
    });

    it('should execute ipconfig /all command', async () => {
      const result = await server.executeCommand('ipconfig /all');
      expect(result).toContain('Physical Address');
    });

    it('should execute route print command', async () => {
      const result = await server.executeCommand('route print');
      expect(result).toContain('Network');
    });

    it('should execute arp -a command', async () => {
      const result = await server.executeCommand('arp -a');
      expect(result).toContain('Interface');
    });

    it('should execute netsh interface show command', async () => {
      const result = await server.executeCommand('netsh interface show interface');
      expect(result).toContain('Ethernet0');
      expect(result).toContain('Ethernet1');
    });

    it('should execute netsh interface ip show config', async () => {
      const result = await server.executeCommand('netsh interface ip show config');
      expect(result).toContain('Configuration');
    });

    it('should execute netsh interface ip show addresses', async () => {
      const result = await server.executeCommand('netsh interface ip show addresses');
      expect(result).toContain('Ethernet0');
    });

    it('should execute netsh advfirewall show command', async () => {
      const result = await server.executeCommand('netsh advfirewall show allprofiles');
      expect(result).toContain('Profile');
    });

    it('should execute systeminfo command', async () => {
      const result = await server.executeCommand('systeminfo');
      expect(result).toContain('Windows');
    });
  });

  describe('Netsh Interface Configuration', () => {
    it('should configure static IP via netsh', async () => {
      await server.executeCommand('netsh interface ip set address "eth1" static 10.0.0.50 255.0.0.0');

      const eth1 = server.getInterface('eth1')!;
      expect(eth1.getIPAddress()?.toString()).toBe('10.0.0.50');
    });

    it('should configure DNS via netsh', async () => {
      await server.executeCommand('netsh interface ip set dns "eth0" static 1.1.1.1');
      const result = await server.executeCommand('ipconfig /all');
      expect(result).toContain('1.1.1.1');
    });
  });

  describe('Multiple Interfaces', () => {
    it('should show all interfaces in ipconfig', async () => {
      server.setIPAddress('eth0', new IPAddress('192.168.1.100'), new SubnetMask('/24'));
      server.setIPAddress('eth1', new IPAddress('10.0.0.100'), new SubnetMask('/8'));
      server.setIPAddress('eth2', new IPAddress('172.16.0.100'), new SubnetMask('/16'));

      const result = await server.executeCommand('ipconfig /all');
      expect(result).toContain('192.168.1.100');
      expect(result).toContain('10.0.0.100');
      expect(result).toContain('172.16.0.100');
    });

    it('should show all interfaces in netsh', async () => {
      const result = await server.executeCommand('netsh interface show interface');
      expect(result).toContain('Ethernet0');
      expect(result).toContain('Ethernet1');
      expect(result).toContain('Ethernet2');
      expect(result).toContain('Ethernet3');
    });
  });
});

describe('Cross-Platform Server Consistency', () => {
  let linuxServer: LinuxServer;
  let windowsServer: WindowsServer;

  beforeEach(() => {
    linuxServer = new LinuxServer({ id: 'linux', name: 'Linux Server' });
    windowsServer = new WindowsServer({ id: 'windows', name: 'Windows Server' });

    // Same IP configuration
    linuxServer.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    windowsServer.setIPAddress('eth0', new IPAddress('192.168.1.20'), new SubnetMask('/24'));
  });

  it('should both have 4 interfaces', () => {
    expect(linuxServer.getInterfaces().length).toBe(4);
    expect(windowsServer.getInterfaces().length).toBe(4);
  });

  it('should both support multi-interface configuration', () => {
    linuxServer.setIPAddress('eth1', new IPAddress('10.0.0.10'), new SubnetMask('/8'));
    windowsServer.setIPAddress('eth1', new IPAddress('10.0.0.20'), new SubnetMask('/8'));

    expect(linuxServer.getInterface('eth1')!.getIPAddress()?.toString()).toBe('10.0.0.10');
    expect(windowsServer.getInterface('eth1')!.getIPAddress()?.toString()).toBe('10.0.0.20');
  });

  it('should both have unique MAC addresses per interface', () => {
    const linuxMACs = new Set(linuxServer.getInterfaces().map(i => i.getMAC().toString()));
    const windowsMACs = new Set(windowsServer.getInterfaces().map(i => i.getMAC().toString()));

    expect(linuxMACs.size).toBe(4); // All unique
    expect(windowsMACs.size).toBe(4); // All unique
  });
});
