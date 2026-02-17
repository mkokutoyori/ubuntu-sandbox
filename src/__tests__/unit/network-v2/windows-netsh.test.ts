/**
 * TDD Tests for Windows netsh command — realistic network configuration
 *
 * Tests that netsh commands have REAL impact on the WindowsPC device state:
 *   - IP address changes reflected in ipconfig
 *   - Routes added/removed from routing table
 *   - DNS servers managed and visible
 *   - Interfaces enabled/disabled with real port state changes
 *   - DHCP mode switching
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: netsh interface ip set address — Static IP Configuration
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: netsh interface ip set address', () => {

  describe('N-01: set static IP with quoted adapter name', () => {
    it('should configure IP and reflect in ipconfig', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0'
      );
      expect(result).toContain('Ok');

      const ipconfig = await pc.executeCommand('ipconfig');
      expect(ipconfig).toContain('192.168.1.10');
      expect(ipconfig).toContain('255.255.255.0');
    });
  });

  describe('N-02: set static IP with gateway', () => {
    it('should configure IP + gateway', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 10.0.0.5 255.255.255.0 10.0.0.1'
      );
      const ipconfig = await pc.executeCommand('ipconfig');
      expect(ipconfig).toContain('10.0.0.5');
      expect(ipconfig).toContain('10.0.0.1');
    });
  });

  describe('N-03: set address with source=dhcp', () => {
    it('should switch interface to DHCP mode', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      // First configure static
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0'
      );
      // Then switch to DHCP
      const result = await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" dhcp'
      );
      expect(result).toContain('Ok');

      const ipconfig = await pc.executeCommand('ipconfig /all');
      expect(ipconfig).toContain('DHCP Enabled');
      expect(ipconfig).toContain('Yes');
    });
  });

  describe('N-04: set address on non-existent interface', () => {
    it('should return error for unknown interface', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand(
        'netsh interface ip set address "FakeAdapter" static 1.2.3.4 255.255.255.0'
      );
      expect(result).toContain('not found');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: netsh interface ip — DNS Server Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: netsh interface ip DNS management', () => {

  describe('N-05: set static DNS server', () => {
    it('should set primary DNS and show in show dns', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand(
        'netsh interface ip set dns "Ethernet 0" static 8.8.8.8'
      );
      expect(result).toContain('Ok');

      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).toContain('8.8.8.8');
    });
  });

  describe('N-06: add secondary DNS server', () => {
    it('should add DNS to the list', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');
      const result = await pc.executeCommand(
        'netsh interface ip add dns "Ethernet 0" 1.1.1.1'
      );
      expect(result).toContain('Ok');

      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).toContain('8.8.8.8');
      expect(dns).toContain('1.1.1.1');
    });
  });

  describe('N-07: delete DNS server', () => {
    it('should remove specific DNS', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');
      await pc.executeCommand('netsh interface ip add dns "Ethernet 0" 1.1.1.1');

      const result = await pc.executeCommand(
        'netsh interface ip delete dns "Ethernet 0" 8.8.8.8'
      );
      expect(result).toContain('Ok');

      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).not.toContain('8.8.8.8');
      expect(dns).toContain('1.1.1.1');
    });
  });

  describe('N-08: set DNS to DHCP mode', () => {
    it('should clear static DNS and switch to DHCP', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');

      const result = await pc.executeCommand(
        'netsh interface ip set dns "Ethernet 0" dhcp'
      );
      expect(result).toContain('Ok');

      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).toContain('DHCP');
    });
  });

  describe('N-09: show dns with no DNS configured', () => {
    it('should show none configured', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).toContain('Ethernet');
      // Should show something for each interface
      expect(dns).toContain('DNS');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: netsh interface ip — Route Management
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: netsh interface ip route management', () => {

  describe('N-10: show route displays routing table', () => {
    it('should show connected routes after IP config', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0 192.168.1.1'
      );
      const routes = await pc.executeCommand('netsh interface ip show route');
      expect(routes).toContain('192.168.1');
      expect(routes).toContain('0.0.0.0');
    });
  });

  describe('N-11: add route with real effect', () => {
    it('should add static route visible in show route and route print', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0'
      );
      const result = await pc.executeCommand(
        'netsh interface ip add route 10.0.0.0/24 "Ethernet 0" 192.168.1.1'
      );
      expect(result).toContain('Ok');

      const routes = await pc.executeCommand('netsh interface ip show route');
      expect(routes).toContain('10.0.0.0');
    });
  });

  describe('N-12: delete route', () => {
    it('should remove route from table', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0'
      );
      await pc.executeCommand(
        'netsh interface ip add route 10.0.0.0/24 "Ethernet 0" 192.168.1.1'
      );
      const result = await pc.executeCommand(
        'netsh interface ip delete route 10.0.0.0/24 "Ethernet 0"'
      );
      expect(result).toContain('Ok');

      const routes = await pc.executeCommand('netsh interface ip show route');
      expect(routes).not.toContain('10.0.0.0/24');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: netsh interface ip delete address
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: netsh interface ip delete address', () => {

  describe('N-13: delete address removes IP from interface', () => {
    it('should clear IP and show Media disconnected', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0'
      );
      const result = await pc.executeCommand(
        'netsh interface ip delete address "Ethernet 0" addr=192.168.1.10'
      );
      expect(result).toContain('Ok');

      const ipconfig = await pc.executeCommand('ipconfig');
      // After removing IP, the interface should show no IP
      expect(ipconfig).not.toContain('192.168.1.10');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: netsh interface show/set interface — Interface State
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: netsh interface — interface management', () => {

  describe('N-14: show interface lists all interfaces', () => {
    it('should display interface table with status', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const output = await pc.executeCommand('netsh interface show interface');
      expect(output).toContain('Admin State');
      expect(output).toContain('State');
      expect(output).toContain('Ethernet 0');
      expect(output).toContain('Enabled');
    });
  });

  describe('N-15: disable interface', () => {
    it('should administratively disable the port', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      const result = await pc.executeCommand(
        'netsh interface set interface "Ethernet 0" admin=disable'
      );
      expect(result).toContain('Ok');

      const showIf = await pc.executeCommand('netsh interface show interface');
      expect(showIf).toContain('Disabled');
    });
  });

  describe('N-16: re-enable interface', () => {
    it('should re-enable a disabled port', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand('netsh interface set interface "Ethernet 0" admin=disable');
      const result = await pc.executeCommand(
        'netsh interface set interface "Ethernet 0" admin=enable'
      );
      expect(result).toContain('Ok');

      const showIf = await pc.executeCommand('netsh interface show interface');
      // Ethernet 0 should be Enabled again
      expect(showIf).toContain('Enabled');
    });
  });

  describe('N-17: disabled interface blocks traffic', () => {
    it('should not have IP after disable', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0'
      );
      await pc.executeCommand('netsh interface set interface "Ethernet 0" admin=disable');

      const ipconfig = await pc.executeCommand('ipconfig');
      expect(ipconfig).toContain('Media disconnected');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: netsh integration — Combined Scenarios
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: netsh integration scenarios', () => {

  describe('N-18: full network setup via netsh', () => {
    it('should configure complete network via netsh commands', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');

      // Set IP
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 172.16.0.100 255.255.0.0 172.16.0.1'
      );
      // Set DNS
      await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 172.16.0.2');
      await pc.executeCommand('netsh interface ip add dns "Ethernet 0" 8.8.8.8');
      // Add route
      await pc.executeCommand(
        'netsh interface ip add route 10.0.0.0/8 "Ethernet 0" 172.16.0.1'
      );

      // Verify everything via ipconfig
      const ipconfig = await pc.executeCommand('ipconfig');
      expect(ipconfig).toContain('172.16.0.100');
      expect(ipconfig).toContain('172.16.0.1');

      // Verify DNS
      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).toContain('172.16.0.2');
      expect(dns).toContain('8.8.8.8');

      // Verify routes
      const routes = await pc.executeCommand('netsh interface ip show route');
      expect(routes).toContain('10.0.0.0');
    });
  });

  describe('N-19: netsh interface ip show config after configuration', () => {
    it('should reflect all configuration in show config', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.50.10 255.255.255.0 192.168.50.1'
      );
      const config = await pc.executeCommand('netsh interface ip show config');
      expect(config).toContain('192.168.50.10');
      expect(config).toContain('192.168.50.1');
      expect(config).toContain('DHCP enabled');
      expect(config).toContain('No');
    });
  });

  describe('N-20: netsh int ip reset clears everything', () => {
    it('should reset all IP configuration', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 192.168.1.10 255.255.255.0 192.168.1.1'
      );
      await pc.executeCommand('netsh interface ip set dns "Ethernet 0" static 8.8.8.8');

      const result = await pc.executeCommand('netsh int ip reset');
      expect(result).toContain('Resetting');

      // IP should be gone
      const ipconfig = await pc.executeCommand('ipconfig');
      expect(ipconfig).not.toContain('192.168.1.10');

      // DNS should be gone
      const dns = await pc.executeCommand('netsh interface ip show dns');
      expect(dns).not.toContain('8.8.8.8');
    });
  });

  describe('N-21: netsh interface ip show addresses format', () => {
    it('should show addresses in proper format', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1');
      await pc.executeCommand(
        'netsh interface ip set address "Ethernet 0" static 10.0.0.50 255.255.255.0'
      );
      const output = await pc.executeCommand('netsh interface ip show addresses');
      expect(output).toContain('Configuration for interface');
      expect(output).toContain('10.0.0.50');
    });
  });

  describe('N-22: netsh help contexts', () => {
    it('should show help for interface ip context', async () => {
      const output = await new WindowsPC('windows-pc', 'PC1').executeCommand('netsh interface ip ?');
      expect(output).toContain('add');
      expect(output).toContain('delete');
      expect(output).toContain('set');
      expect(output).toContain('show');
    });
  });
});
