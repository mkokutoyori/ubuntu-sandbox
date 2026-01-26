/**
 * Unit tests for LinuxPC
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';
import { SubnetMask } from '@/domain/network/value-objects/SubnetMask';

describe('LinuxPC', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    pc = new LinuxPC({ id: 'pc1', name: 'Linux Test PC' });
  });

  describe('Device Properties', () => {
    it('should create LinuxPC with correct type', () => {
      expect(pc.getType()).toBe('linux-pc');
    });

    it('should have correct OS type', () => {
      expect(pc.getOSType()).toBe('linux');
    });

    it('should have default hostname', () => {
      expect(pc.getHostname()).toBe('Linux Test PC');
    });

    it('should allow hostname change', () => {
      pc.setHostname('ubuntu-server');
      expect(pc.getHostname()).toBe('ubuntu-server');
    });
  });

  describe('Command Execution', () => {
    beforeEach(() => {
      pc.powerOn();
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    });

    it('should execute pwd command', async () => {
      const result = await pc.executeCommand('pwd');
      expect(result).toContain('/home/user');
    });

    it('should execute echo command', async () => {
      const result = await pc.executeCommand('echo Hello World');
      expect(result).toBe('Hello World');
    });

    it('should execute whoami command', async () => {
      const result = await pc.executeCommand('whoami');
      expect(result).toBe('user');
    });

    it('should execute hostname command', async () => {
      const result = await pc.executeCommand('hostname');
      expect(result).toBe('Linux Test PC');
    });

    it('should execute uname command', async () => {
      const result = await pc.executeCommand('uname');
      expect(result).toContain('Linux');
    });

    it('should execute uname -a command', async () => {
      const result = await pc.executeCommand('uname -a');
      expect(result).toContain('Linux');
      expect(result).toContain('x86_64');
    });

    it('should show command not found for unknown command', async () => {
      const result = await pc.executeCommand('unknowncommand');
      expect(result).toContain('command not found');
    });
  });

  describe('Network Commands', () => {
    beforeEach(() => {
      pc.powerOn();
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
    });

    it('should execute ifconfig command', async () => {
      const result = await pc.executeCommand('ifconfig');
      expect(result).toContain('eth0');
      expect(result).toContain('192.168.1.10');
      expect(result).toContain('255.255.255.0');
    });

    it('should execute ip addr command', async () => {
      const result = await pc.executeCommand('ip addr');
      expect(result).toContain('eth0');
      expect(result).toContain('192.168.1.10');
    });

    it('should execute route command', async () => {
      pc.setGateway(new IPAddress('192.168.1.1'));
      const result = await pc.executeCommand('route');
      expect(result).toContain('192.168.1.0');
      expect(result).toContain('0.0.0.0');
      expect(result).toContain('192.168.1.1');
    });

    it('should execute ip route command', async () => {
      pc.setGateway(new IPAddress('192.168.1.1'));
      const result = await pc.executeCommand('ip route');
      expect(result).toContain('192.168.1.0');
      expect(result).toContain('192.168.1.1');
    });

    it('should execute arp command', async () => {
      const result = await pc.executeCommand('arp');
      expect(result).toBeTruthy();
    });

    it('should execute ping command', async () => {
      const result = await pc.executeCommand('ping 192.168.1.1');
      expect(result).toContain('PING 192.168.1.1');
      expect(result).toContain('bytes of data');
    });

    it('should execute traceroute command', async () => {
      const result = await pc.executeCommand('traceroute 8.8.8.8');
      expect(result).toContain('traceroute to 8.8.8.8');
      expect(result).toContain('hops max');
    });
  });

  describe('Command History', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should track command history', async () => {
      await pc.executeCommand('pwd');
      await pc.executeCommand('echo test');
      await pc.executeCommand('whoami');

      const result = await pc.executeCommand('history');
      expect(result).toContain('pwd');
      expect(result).toContain('echo test');
      expect(result).toContain('whoami');
    });

    it('should clear screen with clear command', async () => {
      const result = await pc.executeCommand('clear');
      expect(result).toContain('\x1b[2J\x1b[H');
    });
  });

  describe('Offline Behavior', () => {
    it('should return offline message when powered off', async () => {
      pc.powerOff(); // Explicitly power off
      const result = await pc.executeCommand('pwd');
      expect(result).toBe('Device is offline');
    });

    it('should not execute commands when offline', async () => {
      pc.powerOff(); // Explicitly power off
      const result = await pc.executeCommand('ifconfig');
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

    it('should show configured gateway in route', async () => {
      pc.setIPAddress('eth0', new IPAddress('192.168.1.10'), new SubnetMask('/24'));
      pc.setGateway(new IPAddress('192.168.1.1'));

      const result = await pc.executeCommand('route');
      expect(result).toContain('192.168.1.1');
      expect(result).toContain('0.0.0.0'); // Default route
    });
  });

  describe('Help Command', () => {
    beforeEach(() => {
      pc.powerOn();
    });

    it('should show help with help command', async () => {
      const result = await pc.executeCommand('help');
      expect(result).toContain('Available commands');
      expect(result).toContain('pwd');
      expect(result).toContain('ifconfig');
      expect(result).toContain('ping');
    });

    it('should show help with --help flag', async () => {
      const result = await pc.executeCommand('--help');
      expect(result).toContain('Available commands');
    });
  });
});
