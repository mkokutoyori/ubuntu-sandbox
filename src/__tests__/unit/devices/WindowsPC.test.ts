/**
 * Unit tests for WindowsPC
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';

describe('WindowsPC', () => {
  let pc: WindowsPC;

  beforeEach(() => {
    pc = new WindowsPC({ id: 'pc1', name: 'Windows Test PC' });
  });

  describe('Device Properties', () => {
    it('should create WindowsPC with correct type', () => {
      expect(pc.getType()).toBe('windows-pc');
    });

    it('should have correct OS type', () => {
      expect(pc.getOSType()).toBe('windows');
    });

    it('should have default hostname', () => {
      expect(pc.getHostname()).toBe('Windows Test PC');
    });

    it('should allow hostname change', () => {
      pc.setHostname('WIN-SERVER');
      expect(pc.getHostname()).toBe('WIN-SERVER');
    });
  });

  describe('Command Execution', () => {
    beforeEach(() => {
      pc.powerOn();
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    });

    it('should execute cd command', async () => {
      const result = await pc.executeCommand('cd');
      expect(result).toContain('C:\\Users\\User');
    });

    it('should execute pwd command', async () => {
      const result = await pc.executeCommand('pwd');
      expect(result).toContain('C:\\Users\\User');
    });

    it('should execute echo command', async () => {
      const result = await pc.executeCommand('echo Hello Windows');
      expect(result).toBe('Hello Windows');
    });

    it('should execute whoami command', async () => {
      const result = await pc.executeCommand('whoami');
      expect(result).toContain('User');
    });

    it('should execute hostname command', async () => {
      const result = await pc.executeCommand('hostname');
      expect(result).toBe('Windows Test PC');
    });

    it('should execute ver command', async () => {
      const result = await pc.executeCommand('ver');
      expect(result).toContain('Microsoft Windows');
      expect(result).toContain('Version');
    });

    it('should execute systeminfo command', async () => {
      const result = await pc.executeCommand('systeminfo');
      expect(result).toContain('Host Name');
      expect(result).toContain('OS Name');
      expect(result).toContain('Microsoft Windows');
    });

    it('should handle unknown command', async () => {
      const result = await pc.executeCommand('unknowncommand');
      expect(result).toContain('is not recognized');
    });
  });

  describe('Network Commands', () => {
    beforeEach(() => {
      pc.powerOn();
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    });

    it('should execute ipconfig command', async () => {
      const result = await pc.executeCommand('ipconfig');
      expect(result).toContain('Windows IP Configuration');
      expect(result).toContain('Ethernet adapter');
      expect(result).toContain('192.168.1.10');
      expect(result).toContain('255.255.255.0');
    });

    it('should execute ipconfig /all command', async () => {
      const result = await pc.executeCommand('ipconfig /all');
      expect(result).toContain('Windows IP Configuration');
      expect(result).toContain('Physical Address');
      expect(result).toContain('DHCP Enabled');
    });

    it('should execute route print command', async () => {
      pc.setGateway(new IPAddress('192.168.1.1'));
      const result = await pc.executeCommand('route print');
      expect(result).toContain('IPv4 Route Table');
      expect(result).toContain('Active Routes');
      expect(result).toContain('192.168.1.1');
    });

    it('should execute arp command', async () => {
      const result = await pc.executeCommand('arp');
      expect(result).toContain('Internet Address');
      expect(result).toContain('Physical Address');
    });

    it('should execute arp -a command', async () => {
      const result = await pc.executeCommand('arp -a');
      expect(result).toContain('Interface');
      expect(result).toContain('Internet Address');
    });

    it('should execute ping command', async () => {
      const result = await pc.executeCommand('ping 192.168.1.1');
      expect(result).toContain('Pinging 192.168.1.1');
      expect(result).toContain('32 bytes');
    });

    it('should execute tracert command', async () => {
      const result = await pc.executeCommand('tracert 8.8.8.8');
      expect(result).toContain('Tracing route to 8.8.8.8');
      expect(result).toContain('30 hops');
    });
  });

  describe('Command History', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should track command history with doskey', async () => {
      await pc.executeCommand('cd');
      await pc.executeCommand('echo test');
      await pc.executeCommand('whoami');

      const result = await pc.executeCommand('doskey /history');
      expect(result).toContain('cd');
      expect(result).toContain('echo test');
      expect(result).toContain('whoami');
    });

    it('should track command history with history command', async () => {
      await pc.executeCommand('ver');
      await pc.executeCommand('hostname');

      const result = await pc.executeCommand('history');
      expect(result).toContain('ver');
      expect(result).toContain('hostname');
    });

    it('should clear screen with cls command', async () => {
      const result = await pc.executeCommand('cls');
      expect(result).toContain('\x1b[2J\x1b[H');
    });

    it('should clear screen with clear command', async () => {
      const result = await pc.executeCommand('clear');
      expect(result).toContain('\x1b[2J\x1b[H');
    });
  });

  describe('Offline Behavior', () => {
    it('should return offline message when powered off', async () => {
      pc.powerOff(); // Explicitly power off
      const result = await pc.executeCommand('cd');
      expect(result).toBe('Device is offline');
    });

    it('should not execute commands when offline', async () => {
      pc.powerOff(); // Explicitly power off
      const result = await pc.executeCommand('ipconfig');
      expect(result).toBe('Device is offline');
    });
  });

  describe('Network Configuration', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should configure IP address', () => {
      pc.setIPAddress('eth0', new IPAddress('10.0.0.5'), new SubnetMask('/8'));
      const iface = pc.getInterface('eth0');
      expect(iface?.getIPAddress()?.toString()).toBe('10.0.0.5');
    });

    it('should configure gateway', () => {
      pc.setGateway(new IPAddress('192.168.1.1'));
      expect(pc.getGateway()?.toString()).toBe('192.168.1.1');
    });

    it('should show configured gateway in route print', async () => {
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc.setGateway(new IPAddress('192.168.1.1'));

      const result = await pc.executeCommand('route print');
      expect(result).toContain('192.168.1.1');
      expect(result).toContain('0.0.0.0');
    });
  });

  describe('Help Command', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should show help with help command', async () => {
      const result = await pc.executeCommand('help');
      expect(result).toContain('Available commands');
      expect(result).toContain('CD');
      expect(result).toContain('IPCONFIG');
      expect(result).toContain('PING');
    });

    it('should show help with /? flag', async () => {
      const result = await pc.executeCommand('/?');
      expect(result).toContain('Available commands');
    });
  });

  describe('Case Insensitivity', () => {
    beforeEach(() => {
      pc.powerOn();
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    });

    it('should handle uppercase commands', async () => {
      const result = await pc.executeCommand('IPCONFIG');
      expect(result).toContain('Windows IP Configuration');
    });

    it('should handle mixed case commands', async () => {
      const result = await pc.executeCommand('IpCoNfIg');
      expect(result).toContain('Windows IP Configuration');
    });

    it('should handle lowercase commands', async () => {
      const result = await pc.executeCommand('hostname');
      expect(result).toBe('Windows Test PC');
    });
  });
});
