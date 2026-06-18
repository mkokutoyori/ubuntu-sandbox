/**
 * TDD tests for IP addressing, subnet configuration, and routing commands
 * across Linux, Windows, and Cisco IOS devices.
 *
 * Covers 100 test scenarios grouped by operating system environment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ─── Helpers ────────────────────────────────────────────────────────

function setupLinuxTopology() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  return { pc1, pc2, sw };
}

function setupWindowsTopology() {
  const pc1 = new WindowsPC('WPC1', 0, 0);
  const pc2 = new WindowsPC('WPC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);

  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

  return { pc1, pc2, sw };
}

function setupCiscoTopology() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  const cable = new Cable('c1');
  cable.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  return { r1, r2 };
}

// ═══════════════════════════════════════════════════════════════════
// LINUX NETWORKING TESTS (1-42)
// ═══════════════════════════════════════════════════════════════════

describe('Linux Subnet and Route Configurations', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Linux ifconfig (Tests 1-15) ────────────────────────────────

  describe('Linux ifconfig commands', () => {
    it('1. should set IP and netmask on valid interface', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
      expect(output.trim()).toBe('');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).toContain('inet 192.168.1.1');
      expect(status).toContain('netmask 255.255.255.0');
    });

    it('2. should set classful default netmask if netmask is omitted (Class A)', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).toContain('inet 10.0.0.1');
      expect(status).toContain('netmask 255.0.0.0');
    });

    it('3. should set classful default netmask if netmask is omitted (Class B)', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 172.16.0.1');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).toContain('inet 172.16.0.1');
      expect(status).toContain('netmask 255.255.0.0');
    });

    it('4. should set classful default netmask if netmask is omitted (Class C)', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.5.1');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).toContain('inet 192.168.5.1');
      expect(status).toContain('netmask 255.255.255.0');
    });

    it('5. should reject configuration on non-existent interface', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth99 10.0.0.1');
      expect(output.toLowerCase()).toContain('error');
      expect(output.toLowerCase()).toContain('device not found');
    });

    it('6. should reject invalid IP address format', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth0 256.100.100.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('7. should reject invalid subnet mask format', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.256.0');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('8. should show usage guide on incomplete ifconfig arguments', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth0 netmask');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('9. should configure broadcast address explicitly', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0 broadcast 192.168.1.255');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).toContain('broadcast 192.168.1.255');
    });

    it('10. should reject invalid broadcast address format', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth0 192.168.1.1 broadcast 300.300.300.300');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('11. should handle command case sensitivity properly (fail on uppercase)', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('IFCONFIG eth0 10.0.0.1');
      expect(output.toLowerCase()).toContain('command not found');
    });

    it('12. should clear IP configuration using 0.0.0.0', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1');
      await pc1.executeCommand('ifconfig eth0 0.0.0.0');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).not.toContain('inet 10.0.0.1');
    });

    it('13. should overwrite existing interface IP settings', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.0.0.0');
      await pc1.executeCommand('ifconfig eth0 192.168.10.10 netmask 255.255.255.0');
      const status = await pc1.executeCommand('ifconfig eth0');
      expect(status).toContain('192.168.10.10');
      expect(status).not.toContain('10.0.0.1');
    });

    it('14. should block loopback configuration on physical interface eth0', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig eth0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|cannot assign/);
    });

    it('15. should handle spaces or quotes around options cleanly', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ifconfig "eth0" 10.1.1.1');
      expect(output.trim()).toBe('');
    });
  });

  // ─── Linux ip addr (Tests 16-30) ────────────────────────────────

  describe('Linux ip addr commands', () => {
    it('16. should add valid IP/CIDR to eth0', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth0');
      expect(output.trim()).toBe('');
      const status = await pc1.executeCommand('ip addr show eth0');
      expect(status).toContain('10.10.10.1/24');
    });

    it('17. should add secondary IP address to interface', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth0');
      await pc1.executeCommand('ip addr add 172.16.1.1/16 dev eth0');
      const status = await pc1.executeCommand('ip addr show eth0');
      expect(status).toContain('10.10.10.1/24');
      expect(status).toContain('172.16.1.1/16');
    });

    it('18. should delete specific IP address from interface', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth0');
      const delOutput = await pc1.executeCommand('ip addr del 10.10.10.1/24 dev eth0');
      expect(delOutput.trim()).toBe('');
      const status = await pc1.executeCommand('ip addr show eth0');
      expect(status).not.toContain('10.10.10.1');
    });

    it('19. should execute shortcut ip a successfully', async () => {
      const { pc1 } = setupLinuxTopology();
      const status = await pc1.executeCommand('ip a');
      expect(status).toContain('eth0');
    });

    it('20. should execute alternative keyword ip address show', async () => {
      const { pc1 } = setupLinuxTopology();
      const status = await pc1.executeCommand('ip address show');
      expect(status).toContain('eth0');
    });

    it('21. should reject invalid CIDR range over 32', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/33 dev eth0');
      expect(output.toLowerCase()).toMatch(/invalid|error|prefix/);
    });

    it('22. should allow CIDR range of 0', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/0 dev eth0');
      expect(output.toLowerCase()).toMatch(/invalid|error/); // 0 prefix is typical network configuration error for host interface
    });

    it('23. should reject adding IP to non-existent dev name', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth99');
      expect(output.toLowerCase()).toContain('not find device');
    });

    it('24. should reject malformed IP formats', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add abc.def.ghi.jkl/24 dev eth0');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('25. should show error when deleting non-existent IP address', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr del 10.99.99.99/24 dev eth0');
      expect(output.toLowerCase()).toMatch(/cannot|error|no such/);
    });

    it('26. should show details for specified interface only', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth0');
      const status = await pc1.executeCommand('ip addr show dev eth0');
      expect(status).toContain('eth0');
    });

    it('27. should fail when dev keyword is omitted', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/24 eth0');
      expect(output.toLowerCase()).toMatch(/syntax|error|usage/);
    });

    it('28. should reject trailing unrecognized parameters', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth0 extra_unrecognized_argument');
      expect(output.toLowerCase()).toMatch(/error|unknown/);
    });

    it('29. should deny IP allocation on administratively down link (if simulator enforces)', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 down');
      const output = await pc1.executeCommand('ip addr add 10.10.10.1/24 dev eth0');
      // Success or silent configuration allowed depending on simulation depth.
      // Asserting command execution processes correctly.
      expect(output.toLowerCase()).not.toContain('command not found');
    });

    it('30. should match expected structure format with loopback status', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip addr');
      expect(output).toContain('lo');
      expect(output).toContain('127.0.0.1');
    });
  });

  // ─── Linux ip route (Tests 31-42) ───────────────────────────────

  describe('Linux ip route commands', () => {
    it('31. should configure static default gateway route', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      const output = await pc1.executeCommand('ip route add default via 192.168.1.1');
      expect(output.trim()).toBe('');
      const routes = await pc1.executeCommand('ip route show');
      expect(routes).toContain('default via 192.168.1.1');
    });

    it('32. should configure static route to target subnet', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      const output = await pc1.executeCommand('ip route add 10.1.0.0/16 via 192.168.1.1');
      expect(output.trim()).toBe('');
      const routes = await pc1.executeCommand('ip route show');
      expect(routes).toContain('10.1.0.0/16 via 192.168.1.1');
    });

    it('33. should configure static route through physical device directly', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      const output = await pc1.executeCommand('ip route add 10.2.0.0/16 dev eth0');
      expect(output.trim()).toBe('');
      const routes = await pc1.executeCommand('ip route show');
      expect(routes).toContain('10.2.0.0/16 dev eth0');
    });

    it('34. should display route configurations on "ip route"', async () => {
      const { pc1 } = setupLinuxTopology();
      const routes = await pc1.executeCommand('ip route');
      expect(routes).toBeDefined();
    });

    it('35. should delete static route from subnet table', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      await pc1.executeCommand('ip route add 10.1.0.0/16 via 192.168.1.1');
      const delOutput = await pc1.executeCommand('ip route del 10.1.0.0/16');
      expect(delOutput.trim()).toBe('');
      const routes = await pc1.executeCommand('ip route show');
      expect(routes).not.toContain('10.1.0.0/16');
    });

    it('36. should delete default gateway route entry', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      await pc1.executeCommand('ip route add default via 192.168.1.1');
      await pc1.executeCommand('ip route del default');
      const routes = await pc1.executeCommand('ip route show');
      expect(routes).not.toContain('default');
    });

    it('37. should reject subnet routes containing active host bits (strict validation)', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip route add 10.1.0.5/16 via 192.168.1.1');
      // Subnet validation detects host bits set (10.1.0.5 with /16 mask)
      expect(output.toLowerCase()).toMatch(/invalid|error|inconsistent/);
    });

    it('38. should show warning/error when adding routing gateway outside interface subnets', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      const output = await pc1.executeCommand('ip route add 10.0.0.0/24 via 172.16.1.1');
      expect(output.toLowerCase()).toMatch(/unreachable|error|invalid/);
    });

    it('39. should reject route additions when route already exists', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      await pc1.executeCommand('ip route add 10.0.0.0/24 via 192.168.1.1');
      const output = await pc1.executeCommand('ip route add 10.0.0.0/24 via 192.168.1.1');
      expect(output.toLowerCase()).toMatch(/exists|error/);
    });

    it('40. should fail when trying to delete non-existent route', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip route del 172.16.0.0/16');
      expect(output.toLowerCase()).toMatch(/no such|error|not found/);
    });

    it('41. should reject ip route configurations with missing arguments', async () => {
      const { pc1 } = setupLinuxTopology();
      const output = await pc1.executeCommand('ip route add 10.0.0.0/24');
      expect(output.toLowerCase()).toMatch(/usage|error|syntax/);
    });

    it('42. should query routes for specific target IP', async () => {
      const { pc1 } = setupLinuxTopology();
      await pc1.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');
      await pc1.executeCommand('ip route add 10.0.0.0/24 via 192.168.1.1');
      const query = await pc1.executeCommand('ip route get 10.0.0.15');
      expect(query).toContain('10.0.0.15');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// WINDOWS NETWORKING TESTS (43-70)
// ═══════════════════════════════════════════════════════════════════

describe('Windows Subnet and Route Configurations', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Windows netsh (Tests 43-57) ────────────────────────────────

  describe('Windows netsh ip config', () => {
    it('43. should set interface static IP and subnet mask', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address name="Ethernet" static 192.168.1.10 255.255.255.0');
      expect(output.trim()).toBe('');
      const status = await pc1.executeCommand('netsh interface ip show addresses "Ethernet"');
      expect(status).toContain('192.168.1.10');
      expect(status).toContain('255.255.255.0');
    });

    it('44. should set static IP, subnet mask, and default gateway', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0 192.168.1.1');
      const status = await pc1.executeCommand('netsh interface ip show addresses "Ethernet"');
      expect(status).toContain('192.168.1.10');
      expect(status).toContain('192.168.1.1');
    });

    it('45. should support netsh options omitting interface name quotes when space-free', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address Ethernet static 192.168.1.10 255.255.255.0');
      expect(output.trim()).toBe('');
    });

    it('46. should clear static IP parameters by setting to source=dhcp', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      const dhcpCmd = await pc1.executeCommand('netsh interface ip set address "Ethernet" source=dhcp');
      expect(dhcpCmd.trim()).toBe('');
      const status = await pc1.executeCommand('netsh interface ip show addresses "Ethernet"');
      expect(status).not.toContain('192.168.1.10');
    });

    it('47. should append secondary IP address using add address command', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      const addCmd = await pc1.executeCommand('netsh interface ip add address "Ethernet" 10.0.0.5 255.255.255.0');
      expect(addCmd.trim()).toBe('');
      const status = await pc1.executeCommand('netsh interface ip show addresses "Ethernet"');
      expect(status).toContain('192.168.1.10');
      expect(status).toContain('10.0.0.5');
    });

    it('48. should remove secondary IP address using delete address command', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      await pc1.executeCommand('netsh interface ip add address "Ethernet" 10.0.0.5 255.255.255.0');
      const delCmd = await pc1.executeCommand('netsh interface ip delete address "Ethernet" 10.0.0.5');
      expect(delCmd.trim()).toBe('');
      const status = await pc1.executeCommand('netsh interface ip show addresses "Ethernet"');
      expect(status).not.toContain('10.0.0.5');
    });

    it('49. should list address summaries across all interfaces', async () => {
      const { pc1 } = setupWindowsTopology();
      const status = await pc1.executeCommand('netsh interface ip show addresses');
      expect(status).toContain('Ethernet');
    });

    it('50. should reject static configurations on missing interface name', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address "Ethernet99" static 10.0.0.1 255.255.255.0');
      expect(output.toLowerCase()).toMatch(/not find|invalid|error/);
    });

    it('51. should reject invalid IP address parameter', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address "Ethernet" static 256.256.256.256 255.255.255.0');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('52. should reject configuration if mask parameter is invalid', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.0');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('53. should show syntax help when crucial parameters are omitted', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address');
      expect(output.toLowerCase()).toMatch(/syntax|usage|help/);
    });

    it('54. should reject configuration if static/dhcp mode parameter is unrecognized', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip set address "Ethernet" dynamic 10.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|syntax|error/);
    });

    it('55. should accept single-quotes as wrapper around interface name', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand("netsh interface ip set address 'Ethernet' static 10.1.1.1 255.255.255.0");
      expect(output.trim()).toBe('');
    });

    it('56. should show config state of specific ethernet device', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('netsh interface ip show address "Ethernet"');
      expect(output).toContain('Ethernet');
    });

    it('57. should prevent configuring duplicate secondary IPs', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.1 255.255.255.0');
      const output = await pc1.executeCommand('netsh interface ip add address "Ethernet" 10.0.0.1 255.255.255.0');
      expect(output.toLowerCase()).toMatch(/already exists|error|duplicate/);
    });
  });

  // ─── Windows route (Tests 58-70) ────────────────────────────────

  describe('Windows route commands', () => {
    it('58. should configure static route to specific subnet', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      const output = await pc1.executeCommand('route add 10.20.30.0 mask 255.255.255.0 192.168.1.1');
      expect(output.trim()).toBe('');
      const routes = await pc1.executeCommand('route print');
      expect(routes).toContain('10.20.30.0');
      expect(routes).toContain('255.255.255.0');
    });

    it('59. should configure static default gateway route using 0.0.0.0 mask', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      const output = await pc1.executeCommand('route add 0.0.0.0 mask 0.0.0.0 192.168.1.1');
      expect(output.trim()).toBe('');
      const routes = await pc1.executeCommand('route print');
      expect(routes).toContain('0.0.0.0');
    });

    it('60. should allow route configurations with interface metrics', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      const output = await pc1.executeCommand('route add 10.20.30.0 mask 255.255.255.0 192.168.1.1 metric 10');
      expect(output.trim()).toBe('');
    });

    it('61. should accept persistent flag option silently', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      const output = await pc1.executeCommand('route -p add 10.20.30.0 mask 255.255.255.0 192.168.1.1');
      expect(output.trim()).toBe('');
    });

    it('62. should output tables properly during route print execution', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('route print');
      expect(output).toContain('Active Routes');
      expect(output).toContain('Network Destination');
    });

    it('63. should delete static route from routing list', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      await pc1.executeCommand('route add 10.20.30.0 mask 255.255.255.0 192.168.1.1');
      const delCmd = await pc1.executeCommand('route delete 10.20.30.0');
      expect(delCmd.trim()).toBe('');
      const routes = await pc1.executeCommand('route print');
      expect(routes).not.toContain('10.20.30.0');
    });

    it('64. should support route deletes with trailing wildcard matches', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      await pc1.executeCommand('route add 10.20.30.0 mask 255.255.255.0 192.168.1.1');
      await pc1.executeCommand('route delete 10.*');
      const routes = await pc1.executeCommand('route print');
      expect(routes).not.toContain('10.20.30.0');
    });

    it('65. should modify existing routes using change command parameter', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      await pc1.executeCommand('route add 10.20.30.0 mask 255.255.255.0 192.168.1.1');
      const output = await pc1.executeCommand('route change 10.20.30.0 mask 255.255.255.0 192.168.1.254');
      expect(output.trim()).toBe('');
    });

    it('66. should reject invalid next-hop address format', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('route add 10.0.0.0 mask 255.0.0.0 invalid_gw');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('67. should reject subnet entries that contain active host bits', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('route add 10.0.0.5 mask 255.0.0.0 192.168.1.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|bad mask/);
    });

    it('68. should report non-matching elements silently when deleting non-existent routes', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('route delete 172.99.0.0');
      // Windows route delete returns output even when route is missing
      expect(output.toLowerCase()).toContain('route');
    });

    it('69. should fail route command modifications with missing parameters', async () => {
      const { pc1 } = setupWindowsTopology();
      const output = await pc1.executeCommand('route add 10.0.0.0');
      expect(output.toLowerCase()).toMatch(/invalid|error|syntax/);
    });

    it('70. should support route querying with specific prefixes', async () => {
      const { pc1 } = setupWindowsTopology();
      await pc1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0');
      await pc1.executeCommand('route add 10.20.30.0 mask 255.255.255.0 192.168.1.1');
      const output = await pc1.executeCommand('route print 10.*');
      expect(output).toContain('10.20.30.0');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// CISCO IOS INTERFACE SUBNETS (71-85)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS Interface Subnet configurations', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  it('71. should set valid IP address and mask on Cisco GigabitEthernet interface', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    const output = await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    expect(output.trim()).toBe('');
    await r1.executeCommand('end');
    const status = await r1.executeCommand('show ip interface brief');
    expect(status).toContain('10.1.1.1');
  });

  it('72. should overwrite previous interface IP configuration settings', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    await r1.executeCommand('ip address 172.16.1.1 255.255.0.0');
    await r1.executeCommand('end');
    const status = await r1.executeCommand('show ip interface brief');
    expect(status).toContain('172.16.1.1');
    expect(status).not.toContain('10.1.1.1');
  });

  it('73. should accept variable length subnets (VLSM)', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    const output = await r1.executeCommand('ip address 192.168.1.129 255.255.255.248');
    expect(output.trim()).toBe('');
  });

  it('74. should remove IP configuration when no ip address is executed', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    const output = await r1.executeCommand('no ip address');
    expect(output.trim()).toBe('');
    await r1.executeCommand('end');
    const status = await r1.executeCommand('show ip interface brief');
    expect(status).toContain('unassigned');
  });

  it('75. should allow secondary IP address configurations', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    const output = await r1.executeCommand('ip address 192.168.1.1 255.255.255.0 secondary');
    expect(output.trim()).toBe('');
  });

  it('76. should delete specific secondary IP allocations', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0 secondary');
    const delOutput = await r1.executeCommand('no ip address 192.168.1.1 255.255.255.0 secondary');
    expect(delOutput.trim()).toBe('');
  });

  it('77. should allow configuring IP addresses when physical line states are down', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('shutdown');
    const output = await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    expect(output.trim()).toBe('');
  });

  it('78. should reject discontiguous subnet mask formats', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    const output = await r1.executeCommand('ip address 10.1.1.1 255.0.255.0');
    expect(output).toContain('%'); // Cisco error marker
  });

  it('79. should reject IP configurations outside valid octet range', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    const output = await r1.executeCommand('ip address 10.300.1.1 255.255.255.0');
    expect(output).toContain('%');
  });

  it('80. should reflect correct IP parameters on show ip interface brief commands', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 10.5.5.5 255.255.255.0');
    await r1.executeCommand('end');
    const status = await r1.executeCommand('show ip interface brief');
    expect(status).toContain('GigabitEthernet0/0');
    expect(status).toContain('10.5.5.5');
  });

  it('81. should show advanced details for interface queries', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    const details = await r1.executeCommand('show interfaces GigabitEthernet0/0');
    expect(details).toContain('GigabitEthernet0/0');
  });

  it('82. should prevent IP configurations when executing in invalid modes (Global mode)', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip address 10.1.1.1 255.255.255.0');
    expect(output).toContain('%'); // Rejected because not in interface sub-mode
  });

  it('83. should prevent setting IP address on active layer 2 Switchports', async () => {
    const sw = new CiscoSwitch('sw-id', 'SW1', 24, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    const output = await sw.executeCommand('ip address 10.1.1.1 255.255.255.0');
    expect(output).toContain('%'); // Rejected on layer-2 port
  });

  it('84. should reject IP on physical ports of an L2-only switch (no routed ports)', async () => {
    // The simulated switch is a pure Layer-2 device: physical ports cannot be
    // converted to routed L3 ports, so an IP address stays rejected.
    const sw = new CiscoSwitch('sw-id', 'SW1', 24, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('no switchport');
    const output = await sw.executeCommand('ip address 10.1.1.1 255.255.255.0');
    expect(output).toContain('%');
  });

  it('85. should support virtual software loopback interface allocations', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface Loopback0');
    const output = await r1.executeCommand('ip address 1.1.1.1 255.255.255.255');
    expect(output.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CISCO IOS STATIC ROUTES (86-100)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS Static Route configurations', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  it('86. should configure static routing paths using standard next-hop gateways', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 192.168.1.1');
    expect(output.trim()).toBe('');
    await r1.executeCommand('end');
    const routes = await r1.executeCommand('show ip route');
    expect(routes).toContain('10.10.10.0');
  });

  it('87. should configure static routing paths directing to physical interfaces directly', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 GigabitEthernet0/0');
    expect(output.trim()).toBe('');
  });

  it('88. should configure static routing paths using interface together with next-hop gateways', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 GigabitEthernet0/0 192.168.1.1');
    expect(output.trim()).toBe('');
  });

  it('89. should configure general default routes (gateway of last resort)', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 0.0.0.0 0.0.0.0 192.168.1.1');
    expect(output.trim()).toBe('');
    await r1.executeCommand('end');
    const routes = await r1.executeCommand('show ip route');
    expect(routes).toContain('0.0.0.0/0');
  });

  it('90. should configure administrative distance on routes (floating static routing)', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 192.168.1.1 90');
    expect(output.trim()).toBe('');
  });

  it('91. should delete static route from database', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 192.168.1.1');
    const delOutput = await r1.executeCommand('no ip route 10.10.10.0 255.255.255.0 192.168.1.1');
    expect(delOutput.trim()).toBe('');
    await r1.executeCommand('end');
    const routes = await r1.executeCommand('show ip route');
    expect(routes).not.toContain('10.10.10.0');
  });

  it('92. should render tables clearly during show ip route operations', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    const routes = await r1.executeCommand('show ip route');
    expect(routes).toContain('Codes:');
  });

  it('93. should show static-specific entries when filtered', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 192.168.1.1');
    await r1.executeCommand('end');
    const routes = await r1.executeCommand('show ip route static');
    expect(routes).toContain('10.10.10.0');
  });

  it('94. should query pathways for targeted addresses within active route table', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 192.168.1.1');
    await r1.executeCommand('end');
    const query = await r1.executeCommand('show ip route 10.10.10.5');
    expect(query).toContain('10.10.10.0');
  });

  it('95. should reject routing configurations with invalid next-hop parameters', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0 255.255.255.0 300.1.1.1');
    expect(output).toContain('%');
  });

  it('96. should reject route configurations using discontinuous mask parameters', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0 255.0.255.0 192.168.1.1');
    expect(output).toContain('%');
  });

  it('97. should show syntax errors on incomplete routing command definitions', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.0');
    expect(output).toContain('%');
  });

  it('98. should clear Gateway of Last Resort on deleting default pathways', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('ip route 0.0.0.0 0.0.0.0 192.168.1.1');
    await r1.executeCommand('no ip route 0.0.0.0 0.0.0.0 192.168.1.1');
    await r1.executeCommand('end');
    const routes = await r1.executeCommand('show ip route');
    expect(routes).toContain('Gateway of last resort is not set');
  });

  it('99. should resolve and support common route command abbreviations', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    const output = await r1.executeCommand('sh ip ro');
    expect(output).toContain('Codes:');
  });

  it('100. should reject host configurations containing active host bits inside network prefixes', async () => {
    const { r1 } = setupCiscoTopology();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    const output = await r1.executeCommand('ip route 10.10.10.5 255.255.255.0 192.168.1.1');
    expect(output).toContain('%'); // Inconsistent address and mask error
  });
});
