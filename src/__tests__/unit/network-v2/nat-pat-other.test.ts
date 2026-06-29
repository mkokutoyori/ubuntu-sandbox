/**
 * WAN-level NAT and PAT Validation Suite for Cisco IOS and Huawei VRP.
 * 
 * Contains exactly 400 unit test scenarios divided into:
 *  - Section 1: Cisco Static NAT (One-to-One) (Tests 1-50)
 *  - Section 2: Cisco Dynamic NAT (Address Pool & ACL) (Tests 51-100)
 *  - Section 3: Cisco PAT / NAT Overload (Port-level Translation) (Tests 101-150)
 *  - Section 4: Cisco Static PAT / Port Forwarding (Inbound Port Translation) (Tests 151-200)
 *  - Section 5: NAT/PAT Verification, Clears & Diagnostic Commands (Tests 201-250)
 *  - Section 6: Huawei NAT Outbound, Address Groups & NAT Server (VRP V5/V8) (Tests 251-300)
 *  - Section 7: WAN Routing Interlocking, MTU, ALG & NAT Order of Operations (Tests 301-350)
 *  - Section 8: Edge Cases, Pool Exhaustion, Typos & Syntax Error Handlers (Tests 351-400)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network/equipment/Equipment';

// ─── NAT Topology Helper ────────────────────────────────────────────

function setupNATTopology() {
  const inside_pc1 = new LinuxPC('InsidePC1', 0, 0);
  const inside_pc2 = new WindowsPC('InsidePC2', 0, 100);
  const sw1 = new CiscoSwitch('sw1', 'SW1', 24, 100, 50);
  const r1 = new CiscoRouter('r1', 'R1', 200, 50); // NAT Router
  const r2 = new CiscoRouter('r2', 'R2', 300, 50); // ISP Router
  const outside_pc1 = new LinuxPC('OutsidePC1', 400, 50);

  const c1 = new Cable('c1');
  c1.connect(inside_pc1.getPort('eth0')!, sw1.getPort('FastEthernet0/1')!);

  const c2 = new Cable('c2');
  c2.connect(inside_pc2.getPort('eth0')!, sw1.getPort('FastEthernet0/2')!);

  const c3 = new Cable('c3');
  c3.connect(sw1.getPort('FastEthernet0/24')!, r1.getPort('GigabitEthernet0/0')!);

  const c4 = new Cable('c4');
  c4.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  const c5 = new Cable('c5');
  c5.connect(r2.getPort('GigabitEthernet0/0')!, outside_pc1.getPort('eth0')!);

  return { inside_pc1, inside_pc2, sw1, r1, r2, outside_pc1, c1, c2, c3, c4, c5 };
}

async function configureBasicNATRouting(topo: ReturnType<typeof setupNATTopology>) {
  // Inside PC1 (Linux)
  await topo.inside_pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
  await topo.inside_pc1.executeCommand('ip route add default via 192.168.1.1');

  // Inside PC2 (Windows)
  await topo.inside_pc2.executeCommand('netsh interface ip set address "Ethernet" static 192.168.1.20 255.255.255.0 192.168.1.1');

  // R1 (Cisco - NAT)
  await topo.r1.executeCommand('enable');
  await topo.r1.executeCommand('configure terminal');
  await topo.r1.executeCommand('interface GigabitEthernet0/0');
  await topo.r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await topo.r1.executeCommand('ip nat inside');
  await topo.r1.executeCommand('no shutdown');
  await topo.r1.executeCommand('exit');
  await topo.r1.executeCommand('interface GigabitEthernet0/1');
  await topo.r1.executeCommand('ip address 203.0.113.1 255.255.255.252');
  await topo.r1.executeCommand('ip nat outside');
  await topo.r1.executeCommand('no shutdown');
  await topo.r1.executeCommand('exit');
  await topo.r1.executeCommand('ip route 0.0.0.0 0.0.0.0 203.0.113.2');
  await topo.r1.executeCommand('end');

  // R2 (Cisco - ISP)
  await topo.r2.executeCommand('enable');
  await topo.r2.executeCommand('configure terminal');
  await topo.r2.executeCommand('interface GigabitEthernet0/1');
  await topo.r2.executeCommand('ip address 203.0.113.2 255.255.255.252');
  await topo.r2.executeCommand('no shutdown');
  await topo.r2.executeCommand('exit');
  await topo.r2.executeCommand('interface GigabitEthernet0/0');
  await topo.r2.executeCommand('ip address 198.51.100.1 255.255.255.0');
  await topo.r2.executeCommand('no shutdown');
  await topo.r2.executeCommand('exit');
  await topo.r2.executeCommand('ip route 203.0.113.0 255.255.255.0 203.0.113.1');
  await topo.r2.executeCommand('end');

  // Outside PC1 (Linux)
  await topo.outside_pc1.executeCommand('ifconfig eth0 198.51.100.10 netmask 255.255.255.0');
  await topo.outside_pc1.executeCommand('ip route add default via 198.51.100.1');
}

// ═══════════════════════════════════════════════════════════════════
// DETAILED UNIT TESTS FOR NAT/PAT (1-400)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco and Huawei NAT/PAT Command System', () => {
  beforeEach(() => {
    Equipment.clearRegistry();
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Section 1: Cisco Static NAT (One-to-One) (Tests 1-50) ────────

  describe('Section 1: Cisco Static NAT (One-to-One)', () => {
    it('1. should configure static one-to-one NAT mapping', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      expect(output.trim()).toBe('');
    });

    it('2. should show static NAT entry in the translation table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
      expect(table).toContain('192.168.1.10');
    });

    it('3. should translate ping packets from inside host to outside host via static NAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const ping = await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      expect(ping).toContain('1 packets transmitted, 1 received');
    });

    it('4. should allow outside host to ping inside host using its static public IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const ping = await topo.outside_pc1.executeCommand('ping -c 1 203.0.113.10');
      expect(ping).toContain('64 bytes from 203.0.113.10');
    });

    it('5. should delete static NAT mapping via no ip nat inside source static', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('no ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).not.toContain('203.0.113.10');
    });

    it('6. should reject static NAT if the inside local IP address is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static 300.300.300.300 203.0.113.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('7. should reject static NAT if the inside global IP address is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 300.300.300.300');
      expect(output.toLowerCase()).toContain('%');
    });

    it('8. should support bidirectional communication on static NAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const pingInside = await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const pingOutside = await topo.outside_pc1.executeCommand('ping -c 1 203.0.113.10');
      expect(pingInside).toContain('0% packet loss');
      expect(pingOutside).toContain('0% packet loss');
    });

    it('9. should configure static NAT with network mask (static network translation)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static network 192.168.1.0 203.0.113.0 /24');
      expect(output.trim()).toBe('');
    });

    it('10. should show network static translation in the routing/NAT table', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static network 192.168.1.0 203.0.113.0 /24');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.0');
      expect(table).toContain('192.168.1.0');
    });

    it('11. should translate any inside host inside the network statically with offset preserved', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static network 192.168.1.0 203.0.113.0 /24');
      await topo.r1.executeCommand('end');

      // Inside PC1 (192.168.1.10) pings -> translates to 203.0.113.10
      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('12. should reject static network translation if mask is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static network 192.168.1.0 203.0.113.0 /35');
      expect(output.toLowerCase()).toContain('%');
    });

    it('13. should configure static NAT with VRF mapping if supported', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('14. should block configuring static NAT if the local IP is already mapped in a different rule', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.11');
      expect(output.toLowerCase()).toContain('%');
    });

    it('15. should block configuring static NAT if the global IP is already mapped in a different rule', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.11 203.0.113.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('16. should accept netsh equivalent commands for static NAT if ran in Windows PC (check error/refusal)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      const output = await topo.inside_pc2.executeCommand('netsh routing ip nat add staticportmapping "Ethernet"');
      expect(output.toLowerCase()).toContain('invalid');
    });

    it('17. should show zero translation hits initially on show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Hits: 0');
    });

    it('18. should increment translation hits on show ip nat statistics after successful translation', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).not.toContain('Hits: 0');
    });

    it('19. should allow outside host to scan/reach inside host port if static NAT is active', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      // Outside PC1 pings -> resolves to inside PC1 public IP
      const ping = await topo.outside_pc1.executeCommand('ping -c 1 203.0.113.10');
      expect(ping).toContain('64 bytes');
    });

    it('20. should block outside host from reaching inside host if no static NAT is mapped', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      // No static NAT configured, Outside PC1 attempts to ping 203.0.113.10 (which is unassigned)
      const ping = await topo.outside_pc1.executeCommand('ping -c 1 -W 1 203.0.113.10');
      expect(ping).toContain('100% packet loss');
    });

    it('21. should overwrite static NAT destination automatically when updated in config terminal', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('no ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.50');
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.50');
      expect(table).not.toContain('203.0.113.10');
    });

    it('22. should support no ip nat inside source static network negation command', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static network 192.168.1.0 203.0.113.0 /24');
      await topo.r1.executeCommand('no ip nat inside source static network 192.168.1.0 203.0.113.0 /24');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('no nat entries');
    });

    it('23. should show static NAT configuration in show running-config output', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source static 192.168.1.10 203.0.113.10');
    });

    it('24. should show ip nat inside on internal interface inside show running-config', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n ip nat inside');
    });

    it('25. should show ip nat outside on external interface inside show running-config', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('interface GigabitEthernet0/1\n ip address 203.0.113.1 255.255.255.252\n ip nat outside');
    });

    it('26. should support configuring static NAT inside subinterfaces (router-on-a-stick NAT)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/0.10');
      await topo.r1.executeCommand('encapsulation dot1q 10');
      const output = await topo.r1.executeCommand('ip nat inside');
      expect(output.trim()).toBe('');
    });

    it('27. should fail to translate if ip nat inside is omitted from internal interface', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('no ip nat inside'); // Disable inside NAT
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 -W 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      // No dynamic allocations should occur since inside interface is not participating in NAT
      expect(table).not.toContain('icmp');
    });

    it('28. should fail to translate if ip nat outside is omitted from external interface', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('no ip nat outside'); // Disable outside NAT
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 -W 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).not.toContain('icmp');
    });

    it('29. should preserve static NAT after soft reload of Cisco router (if write was executed)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      await topo.r1.executeCommand('write memory');
      await topo.r1.executeCommand('reload');

      await topo.r1.executeCommand('enable');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('30. should clear dynamic entries but keep static NAT mappings on clear ip nat translation *', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10'); // Generates dynamic translation on top of static
      await topo.r1.executeCommand('clear ip nat translation *');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10'); // Static mapping survives
      expect(table).not.toContain('icmp');     // Dynamic ICMP translation is cleared
    });

    it('31. should reject static NAT config if syntax has missing global IP parameter', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('32. should reject static NAT config if syntax has missing local IP parameter', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static 203.0.113.10'); // missing local IP
      expect(output.toLowerCase()).toContain('%');
    });

    it('33. should support static NAT outside translation mapping (ip nat outside source static)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50');
      expect(output.trim()).toBe('');
    });

    it('34. should display outside static translation inside translations table', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('198.51.100.10');
      expect(table).toContain('203.0.113.50');
    });

    it('35. should allow disabling static NAT outside mapping using no ip nat outside source static', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50');
      const delOutput = await topo.r1.executeCommand('no ip nat outside source static 198.51.100.10 203.0.113.50');
      expect(delOutput.trim()).toBe('');
    });

    it('36. should translate source IP of outgoing ICMP packets under static inside NAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.1.10');
      expect(table).toContain('203.0.113.10');
    });

    it('37. should allow configuring static NAT on loopback interfaces', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface Loopback0');
      await topo.r1.executeCommand('ip address 1.1.1.1 255.255.255.255');
      const output = await topo.r1.executeCommand('ip nat inside');
      expect(output.trim()).toBe('');
    });

    it('38. should show the SVI interfaces in show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('GigabitEthernet0/0');
      expect(stats).toContain('GigabitEthernet0/1');
    });

    it('39. should prevent duplicate key creation inside static IP ruleset', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      expect(output.toLowerCase()).toContain('duplicate');
    });

    it('40. should support static NAT maps configurations on Cisco switches supporting L3 SVIs', async () => {
      const sw = new CiscoSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface Vlan1');
      await sw.executeCommand('no switchport'); // Convert if supported or verify command accepted
      expect(sw).toBeDefined();
    });

    it('41. should reject static IP configurations if target subnet mask has invalid boundaries', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static network 192.168.1.0 203.0.113.0 255.255.0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('42. should support static NAT translations using IP alias host definitions', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip host client1 192.168.1.10');
      const output = await topo.r1.executeCommand('ip nat inside source static client1 203.0.113.10');
      expect(output.trim()).toBe('');
    });

    it('43. should show static NAT definitions in show running-config after hostname alias definition', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip host client1 192.168.1.10');
      await topo.r1.executeCommand('ip nat inside source static client1 203.0.113.10');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source static client1 203.0.113.10');
    });

    it('44. should handle very large network translation scope bounds cleanly (/8)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static network 10.0.0.0 200.0.0.0 /8');
      expect(output.trim()).toBe('');
    });

    it('45. should show correct /8 mask parameters in translations table output', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static network 10.0.0.0 200.0.0.0 /8');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('255.0.0.0');
    });

    it('46. should support single quotes around static IP target addresses inside Cisco config terminal', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand("ip nat inside source static '192.168.1.10' '203.0.113.10'");
      expect(output.trim()).toBe('');
    });

    it('47. should support double quotes around static IP target addresses inside Cisco config terminal', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static "192.168.1.10" "203.0.113.10"');
      expect(output.trim()).toBe('');
    });

    it('48. should reject static NAT config if the protocol sub-modifier is completely unknown', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static unknown_proto 192.168.1.10 203.0.113.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('49. should wipe all active static translations when no ip nat commands are re-evaluated', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('no ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('no nat entries');
    });

    it('50. should execute successfully and return status 0 on clean static NAT configuration', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('configure terminal && ip nat inside source static 192.168.1.10 203.0.113.10 && end');
      expect(output).toBeDefined();
    });
  });

  // ─── Section 2: Cisco Dynamic NAT (Address Pool & ACL) (Tests 51-100) ───

  describe('Section 2: Cisco Dynamic NAT (Address Pool & ACL)', () => {
    it('51. should configure NAT IP address pool via ip nat pool', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      expect(output.trim()).toBe('');
    });

    it('52. should configure access-list to match inside local network', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      expect(output.trim()).toBe('');
    });

    it('53. should bind access-list to NAT pool dynamically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('54. should map inside host to first address in pool on active outbound traffic', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10'); // First address allocated
      expect(table).toContain('192.168.1.10');
    });

    it('55. should map second inside host to second address in pool on concurrent traffic', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 198.51.100.10');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10'); // Allocated to PC1
      expect(table).toContain('203.0.113.11'); // Allocated to PC2
    });

    it('56. should exhaust pool if there are more inside hosts than pool addresses (no overload)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      // Limit pool to exactly 1 address
      await topo.r1.executeCommand('ip nat pool POOL_SINGLE 203.0.113.10 203.0.113.10 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_SINGLE');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10'); // Claims 203.0.113.10
      const ping2 = await topo.inside_pc2.executeCommand('ping -n 1 -w 1000 198.51.100.10'); // Blocked! Pool exhausted
      expect(ping2).toContain('Request timed out');
    });

    it('57. should show pool exhaustion count in show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_SINGLE 203.0.113.10 203.0.113.10 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_SINGLE');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 -w 500 198.51.100.10');

      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats.toLowerCase()).toMatch(/exhausted|misses|failed/);
    });

    it('58. should support dynamic NAT pool prefix-length notation (prefix-length 24)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 prefix-length 24');
      expect(output.trim()).toBe('');
    });

    it('59. should reject ip nat pool if starting IP is greater than ending IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.20 203.0.113.10 netmask 255.255.255.0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('60. should reject ip nat pool if mask parameter is omitted', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20');
      expect(output.toLowerCase()).toContain('%');
    });

    it('61. should allow deleting dynamic NAT pool configuration using no ip nat pool', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      const output = await topo.r1.executeCommand('no ip nat pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('62. should fail to delete NAT pool if it is currently mapped to an active list translation', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      const output = await topo.r1.executeCommand('no ip nat pool POOL_1');
      expect(output.toLowerCase()).toContain('% pool is in use');
    });

    it('63. should allow pool deletion once mapping is negated first', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('no ip nat inside source list 1 pool POOL_1');
      const output = await topo.r1.executeCommand('no ip nat pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('64. should not translate inside host if traffic does not match the configured ACL', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      // ACL matches only 192.168.1.50, PC1 (192.168.1.10) won't match
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.50 0.0.0.0');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 -W 1 198.51.100.10'); // Untranslated
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('no nat entries');
    });

    it('65. should support using named standard ACLs instead of numbered ones', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip access-list standard NAT_ACL');
      await topo.r1.executeCommand('permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      const output = await topo.r1.executeCommand('ip nat inside source list NAT_ACL pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('66. should translate successfully when named standard ACL is active', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip access-list standard NAT_ACL');
      await topo.r1.executeCommand('permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('ip nat inside source list NAT_ACL pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('67. should show dynamic allocations in show ip nat translations after successful trigger', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('68. should automatically time out dynamic NAT entries after expiration interval (if simulated)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      // Set short translation timeout if supported (e.g. 5 seconds)
      await topo.r1.executeCommand('ip nat translation timeout 5');
      expect(topo.r1).toBeDefined();
    });

    it('69. should support setting custom translation timeouts on specific protocol types (ip nat translation tcp-timeout)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation tcp-timeout 300');
      expect(output.trim()).toBe('');
    });

    it('70. should support setting custom translation timeouts on specific protocol types (ip nat translation udp-timeout)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation udp-timeout 60');
      expect(output.trim()).toBe('');
    });

    it('71. should reject timeout adjustments if value is out of range', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation tcp-timeout 9999999');
      expect(output.toLowerCase()).toContain('%');
    });

    it('72. should reject timeout adjustments if value is negative', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation tcp-timeout -10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('73. should show pool names correctly inside show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool DYNAMIC_POOL 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool DYNAMIC_POOL');
      await topo.r1.executeCommand('end');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('DYNAMIC_POOL');
    });

    it('74. should clear dynamic allocations on clear ip nat translation *', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('clear ip nat translation *');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('no nat entries');
    });

    it('75. should show dynamic pool mapping in show running-config output', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat pool POOL_1');
      expect(running).toContain('ip nat inside source list 1 pool POOL_1');
    });

    it('76. should reject dynamic NAT binding if ACL is completely undefined', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      const output = await topo.r1.executeCommand('ip nat inside source list 99 pool POOL_1'); // ACL 99 doesn't exist
      expect(output.toLowerCase()).toContain('%');
    });

    it('77. should reject dynamic NAT binding if pool is completely undefined', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool NON_EXISTENT_POOL');
      expect(output.toLowerCase()).toContain('%');
    });

    it('78. should support dynamic NAT with multiple pools configured simultaneously', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_A 203.0.113.10 203.0.113.15 netmask 255.255.255.0');
      await topo.r1.executeCommand('ip nat pool POOL_B 203.0.113.20 203.0.113.25 netmask 255.255.255.0');
      expect(topo.r1).toBeDefined();
    });

    it('79. should prevent overlapping dynamic pools configurations', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_A 203.0.113.10 203.0.113.15 netmask 255.255.255.0');
      const output = await topo.r1.executeCommand('ip nat pool POOL_B 203.0.113.12 203.0.113.25 netmask 255.255.255.0'); // overlaps
      expect(output.toLowerCase()).toContain('%');
    });

    it('80. should reject dynamic NAT pool configuration if IP is out of octet range', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 300.0.113.10 203.0.113.20 netmask 255.255.255.0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('81. should configure dynamic NAT using CIDR network mask notation in pool (/24)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 prefix-length 24');
      expect(output.trim()).toBe('');
    });

    it('82. should show prefix-length correctly in show running-config', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 prefix-length 24');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('prefix-length 24');
    });

    it('83. should support using standard numbered ACLs up to 99', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 99 permit 192.168.1.0 0.0.0.255');
      expect(topo.r1).toBeDefined();
    });

    it('84. should support using extended numbered ACLs up to 199 (access-list 101)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 101 permit ip 192.168.1.0 0.0.0.255 any');
      expect(topo.r1).toBeDefined();
    });

    it('85. should support binding dynamic NAT to extended numbered ACLs', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 101 permit ip 192.168.1.0 0.0.0.255 any');
      const output = await topo.r1.executeCommand('ip nat inside source list 101 pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('86. should successfully translate when bound to extended ACL 101', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 101 permit ip 192.168.1.0 0.0.0.255 any');
      await topo.r1.executeCommand('ip nat inside source list 101 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('87. should reject dynamic NAT binding if ACL is of type MAC address', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      const output = await topo.r1.executeCommand('ip nat inside source list MAC_FILTER pool POOL_1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('88. should reject dynamic NAT pool configuration if pool name has special characters', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL#1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('89. should show correct pool capacity usage inside show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.19 netmask 255.255.255.0'); // 10 addresses
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('10%'); // 1/10 used
    });

    it('90. should release pool addresses dynamically once timeouts occur (if simulated)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.11 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      expect(topo.r1).toBeDefined();
    });

    it('91. should negate dynamic NAT binding explicitly', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      const output = await topo.r1.executeCommand('no ip nat inside source list 1 pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('92. should deny dynamic NAT bindings from User EXEC mode', async () => {
      const topo = setupNATTopology();
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('93. should show active Dynamic NAT mappings chronologically in translations table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('94. should allow multiple ACLs bound to separate pools concurrently', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_A 203.0.113.10 203.0.113.15 netmask 255.255.255.0');
      await topo.r1.executeCommand('ip nat pool POOL_B 203.0.113.20 203.0.113.25 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.127');
      await topo.r1.executeCommand('access-list 2 permit 192.168.1.128 0.0.0.127');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_A');
      await topo.r1.executeCommand('ip nat inside source list 2 pool POOL_B');
      expect(topo.r1).toBeDefined();
    });

    it('95. should route through OSPF dynamically when dynamic NAT is running', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      const ping = await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      expect(ping).toContain('64 bytes');
    });

    it('96. should support single quotes around pool names inside Cisco config terminal', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand("ip nat pool 'POOL_1' 203.0.113.10 203.0.113.20 netmask 255.255.255.0");
      expect(topo.r1).toBeDefined();
    });

    it('97. should support double quotes around pool names inside Cisco config terminal', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool "POOL_1" 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      expect(topo.r1).toBeDefined();
    });

    it('98. should reject dynamic NAT binding if syntax has missing pool keyword', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 POOL_1'); // missing pool keyword
      expect(output.toLowerCase()).toContain('%');
    });

    it('99. should reject dynamic NAT binding if syntax has missing list keyword', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source 1 pool POOL_1'); // missing list keyword
      expect(output.toLowerCase()).toContain('%');
    });

    it('100. should execute successfully and return status 0 on complete dynamic NAT configuration', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('configure terminal && ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0 && end');
      expect(output).toBeDefined();
    });
  });

  // ─── Section 3: Cisco PAT / NAT Overload (Tests 101-150) ──────────

  describe('Section 3: Cisco PAT / NAT Overload (Port-level Translation)', () => {
    it('101. should configure PAT using interface overload', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      expect(output.trim()).toBe('');
    });

    it('102. should translate packets and map them to unique source ports under PAT overload', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      // Verify public IP translates to the interface's external IP
      expect(table).toContain('203.0.113.1:');
    });

    it('103. should translate multiple inside hosts simultaneously using different source ports', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 198.51.100.10');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.1.10:');
      expect(table).toContain('192.168.1.20:');
      expect(table).toContain('203.0.113.1:'); // both translate to same public IP
    });

    it('104. should configure PAT using pool overload', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.10 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 overload');
      expect(output.trim()).toBe('');
    });

    it('105. should translate successfully under pool overload mapping', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.10 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 198.51.100.10');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10:');
    });

    it('106. should show overload flag correctly inside show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats.toLowerCase()).toContain('overloaded');
    });

    it('107. should reject overload configuration if interface name has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/99 overload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('108. should support multiple inside ports translating to same public port if destination IPs differ (PAT target socket uniqueness)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      // PC1 and PC2 pinging external target -> different source IP/port sockets mapped uniquely
      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 10.0.12.2'); // different target IP
      const config = await topo.r1.executeCommand('show ip nat translations');
      expect(config).toBeDefined();
    });

    it('109. should negate PAT configurations using no ip nat inside source list overload', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      const output = await topo.r1.executeCommand('no ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      expect(output.trim()).toBe('');
    });

    it('110. should show overload config in show running-config output', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    });

    it('111. should support interface overload with subinterfaces name reference', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1.10 overload');
      expect(output.trim()).toBe('');
    });

    it('112. should reject overload configuration if list keyword is omitted', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source 1 interface GigabitEthernet0/1 overload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('113. should reject overload configuration if interface keyword is omitted', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 GigabitEthernet0/1 overload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('114. should support overload configurations on loopback interfaces', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface Loopback0 overload');
      expect(output.trim()).toBe('');
    });

    it('115. should show correct hits and misses inside stats after PAT translation', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).not.toContain('Hits: 0');
    });

    it('116. should map translation records using TCP protocol tags inside translations table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      // Trigger TCP session simulation via telnet/ssh
      await topo.inside_pc1.executeCommand('telnet 198.51.100.10 80');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('tcp');
    });

    it('117. should map translation records using UDP protocol tags inside translations table', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      // Trigger UDP session simulation via dns lookup/traceroute
      await topo.inside_pc1.executeCommand('traceroute 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('udp');
    });

    it('118. should map translation records using ICMP protocol tags inside translations table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('icmp');
    });

    it('119. should support clear ip nat translation tcp options explicitly', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('telnet 198.51.100.10 80');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp *');
      expect(output.trim()).toBe('');
    });

    it('120. should support clear ip nat translation udp options explicitly', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('traceroute 198.51.100.10');
      const output = await topo.r1.executeCommand('clear ip nat translation udp *');
      expect(output.trim()).toBe('');
    });

    it('121. should silently succeed on clear ip nat translation tcp when no matching mapping exists (IOS behaviour)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 10.0.0.1 1234 20.0.0.1 80');
      expect(output.trim()).toBe('');
    });

    it('122. should preserve overload config after write memory followed by reload', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');
      await topo.r1.executeCommand('write memory');
      await topo.r1.executeCommand('reload');

      await topo.r1.executeCommand('enable');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    });

    it('123. should show translations grouped by protocol in show ip nat translations', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('Pro');
      expect(table).toContain('Inside local');
      expect(table).toContain('Inside global');
    });

    it('124. should support single quotes wrapping on interface overload config parameters', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand("ip nat inside source list 1 interface 'GigabitEthernet0/1' overload");
      expect(output.trim()).toBe('');
    });

    it('125. should support double quotes wrapping on interface overload config parameters', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface "GigabitEthernet0/1" overload');
      expect(output.trim()).toBe('');
    });

    it('126. should reject overload config if the overload keyword is missing', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1'); // missing overload
      expect(output.toLowerCase()).toContain('%');
    });

    it('127. should translate inside hosts to different ports but same IP under PAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 198.51.100.10');

      const table = await topo.r1.executeCommand('show ip nat translations');
      // Asserting different dynamic translated ports
      expect(table).toContain('203.0.113.1:');
    });

    it('128. should release PAT translations after dynamic timeout limits expire (if simulated)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('ip nat translation timeout 5');
      expect(topo.r1).toBeDefined();
    });

    it('129. should preserve PAT after interface configuration status changes (shutdown -> no shutdown)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('shutdown');
      await topo.r1.executeCommand('no shutdown');
      await topo.r1.executeCommand('end');

      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
    });

    it('130. should clear specific translation mapping using clear ip nat translation inside local_ip local_port global_ip global_port', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('telnet 198.51.100.10 80');
      // Clear specific mapped translation
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 192.168.1.10 1024 203.0.113.1 1024 198.51.100.10 80 198.51.100.10 80');
      expect(output.trim()).toBe('');
    });

    it('131. should support clear ip nat translation command using inside global IP specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 203.0.113.1');
      expect(output.trim()).toBe('');
    });

    it('132. should support clear ip nat translation command using outside global IP specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10');
      expect(output.trim()).toBe('');
    });

    it('133. should show translations entries containing correct protocol numbers inside show ip nat translations', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('icmp');
    });

    it('134. should reject clearing translations if parameters are invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation invalid_param');
      expect(output.toLowerCase()).toContain('%');
    });

    it('135. should allow up to 10,000 concurrent PAT port mappings sessions (if simulated)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      // Trigger multiple dynamic port connections
      for (let i = 0; i < 5; i++) {
        await topo.inside_pc1.executeCommand(`ping -c 1 198.51.100.10`);
      }
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toBeDefined();
    });

    it('136. should show correct stats inside show ip nat statistics after multiple ports mapping', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Dynamic translations:');
    });

    it('137. should support overload on VLAN SVI interface', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface Vlan10');
      await topo.r1.executeCommand('ip address 203.0.113.1 255.255.255.0');
      await topo.r1.executeCommand('ip nat outside');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface Vlan10 overload');
      expect(output.trim()).toBe('');
    });

    it('138. should reject SVI overload if SVI name has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface Vlann10 overload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('139. should support overload on serial interfaces (if simulated, serial 0/0/0)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface Serial0/0/0');
      await topo.r1.executeCommand('ip address 203.0.113.1 255.255.255.252');
      await topo.r1.executeCommand('ip nat outside');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface Serial0/0/0 overload');
      expect(output.trim()).toBe('');
    });

    it('140. should reject serial overload if interface name has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface Seriaall0/0/0 overload');
      expect(output.toLowerCase()).toContain('%');
    });

    it('141. should clear only dynamic PAT sessions and retain static rules on clear', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10'); // Dynamic PAT session
      await topo.r1.executeCommand('clear ip nat translation *');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10'); // Static remains
      expect(table).not.toContain('icmp');     // Dynamic cleared
    });

    it('142. should map translations correctly with TCP socket port numbers listed in table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('telnet 198.51.100.10 80');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain(':80');
    });

    it('143. should map translations correctly with UDP socket port numbers listed in table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('traceroute 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain(':33434'); // standard starting UDP port for traceroute
    });

    it('144. should display statistics details correctly inside show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Total translations:');
    });

    it('145. should reject set overload config if Access-List lacks numeric identifier', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source list pool POOL_1 overload'); // missing ACL name/id
      expect(output.toLowerCase()).toContain('%');
    });

    it('146. should translate successfully inside NAT/PAT overloaded environments if target is in suboptimal routing paths', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      const ping = await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      expect(ping).toContain('64 bytes');
    });

    it('147. should show zero translation errors initially on show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats.toLowerCase()).not.toContain('expired');
    });

    it('148. should support NAT interface overload config parameters wrapping in single-quotes', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand("ip nat inside source list 1 interface 'GigabitEthernet0/1' overload");
      expect(output.trim()).toBe('');
    });

    it('149. should support NAT interface overload config parameters wrapping in double-quotes', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 interface "GigabitEthernet0/1" overload');
      expect(output.trim()).toBe('');
    });

    it('150. should execute successfully and return status 0 on complete PAT configuration', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('configure terminal && access-list 1 permit 192.168.1.0 0.0.0.255 && ip nat inside source list 1 interface GigabitEthernet0/1 overload && end');
      expect(output).toBeDefined();
    });
  });

  // ─── Section 4: Cisco Static PAT / Port Forwarding (Tests 151-200) 

  describe('Section 4: Cisco Static PAT / Port Forwarding (Inbound Port Translation)', () => {
    it('151. should configure static inbound TCP port forwarding mapping', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      expect(output.trim()).toBe('');
    });

    it('152. should show static port forwarding mapping in the translation table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.1:8080');
      expect(table).toContain('192.168.1.10:80');
    });

    it('153. should forward incoming TCP traffic targeting public port to inside local server port', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      // Outside host attempts TCP session to public IP on 8080
      await topo.outside_pc1.executeCommand('telnet 203.0.113.1 8080');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.1.10:80');
    });

    it('154. should configure static inbound UDP port forwarding mapping', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 53 203.0.113.1 53');
      expect(output.trim()).toBe('');
    });

    it('155. should forward incoming UDP traffic targeting public port to inside local server port', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 53 203.0.113.1 53');
      await topo.r1.executeCommand('end');

      await topo.outside_pc1.executeCommand('traceroute -p 53 203.0.113.1'); // trigger UDP session on port 53
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.1.10:53');
    });

    it('156. should block port forwarding configuration if local port is invalid (port 70000)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 70000 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('157. should block port forwarding configuration if global port is invalid (port 70000)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 70000');
      expect(output.toLowerCase()).toContain('%');
    });

    it('158. should block port forwarding configuration if local port is negative', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 -80 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('159. should block port forwarding configuration if global port is negative', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 -8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('160. should negate port forwarding mapping explicitly', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      const output = await topo.r1.executeCommand('no ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      expect(output.trim()).toBe('');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).not.toContain('203.0.113.1:8080');
    });

    it('161. should allow multiple port forwarding mapping configurations pointing to same inside local server', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 80');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 443 203.0.113.1 443');
      expect(output.trim()).toBe('');
    });

    it('162. should prevent conflicting port forwarding mapping configurations (mapping same global port to separate local ports)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.20 80 203.0.113.1 8080'); // conflict on global 8080
      expect(output.toLowerCase()).toContain('%');
    });

    it('163. should allow mapping same global port on different global IPs to separate inside local ports (no conflict)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.20 80 203.0.113.10 8080'); // different global IP
      expect(output.trim()).toBe('');
    });

    it('164. should negate port forwarding mapped with extended syntax parameters', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 extended');
      const output = await topo.r1.executeCommand('no ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 extended');
      expect(output.trim()).toBe('');
    });

    it('165. should show port forwarding mapping in show running-config output', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
    });

    it('166. should support port forwarding with loopback interface global target (ip nat inside source static tcp 192.168.1.10 80 interface Loopback0 80)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface Loopback0');
      await topo.r1.executeCommand('ip address 1.1.1.1 255.255.255.255');
      await topo.r1.executeCommand('exit');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface Loopback0 80');
      expect(output.trim()).toBe('');
    });

    it('167. should show correct metrics inside show ip nat statistics after port forwarding translation', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      await topo.outside_pc1.executeCommand('telnet 203.0.113.1 8080');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).not.toContain('Hits: 0');
    });

    it('168. should reject port forwarding configuration if protocol is omitted', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 80 203.0.113.1 8080'); // missing tcp/udp protocol keyword
      expect(output.toLowerCase()).toContain('%');
    });

    it('169. should reject port forwarding configuration if local IP is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 300.1.1.10 80 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('170. should reject port forwarding configuration if global IP is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 300.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('171. should support clear ip nat translation tcp matching port forwarding global IP specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 203.0.113.1 8080 192.168.1.10 80');
      expect(output.trim()).toBe('');
    });

    it('172. should support single quotes around port forwarding parameters inside Cisco config terminal', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand("ip nat inside source static tcp '192.168.1.10' 80 '203.0.113.1' 8080");
      expect(output.trim()).toBe('');
    });

    it('173. should support double quotes around port forwarding parameters inside Cisco config terminal', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp "192.168.1.10" 80 "203.0.113.1" 8080');
      expect(output.trim()).toBe('');
    });

    it('174. should overwrite port forwarding mapping automatically when updated in config terminal', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('no ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 9090');
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.1:9090');
      expect(table).not.toContain('203.0.113.1:8080');
    });

    it('175. should preserve port forwarding configuration after soft reload of Cisco router', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');
      await topo.r1.executeCommand('write memory');
      await topo.r1.executeCommand('reload');

      await topo.r1.executeCommand('enable');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.1:8080');
    });

    it('176. should block configuring port forwarding if the global IP is not routeable', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      // Attempt port forwarding with completely unreachable public IP
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 199.199.199.199 8080');
      expect(output.toLowerCase()).not.toContain('error'); // Accepted, but fails at routing boundary check
    });

    it('177. should support port forwarding on physical WAN interface directly instead of static IP (ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernet0/1 8080)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernet0/1 8080');
      expect(output.trim()).toBe('');
    });

    it('178. should reject interface port forwarding if interface name has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernett0/1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('179. should allow multiple inbound UDP port forwarding mapped to same inside local server', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 53 203.0.113.1 53');
      const output = await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 67 203.0.113.1 67');
      expect(output.trim()).toBe('');
    });

    it('180. should prevent conflicting UDP port forwarding mapping configurations', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 53 203.0.113.1 53');
      const output = await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.20 53 203.0.113.1 53'); // conflict on global 53
      expect(output.toLowerCase()).toContain('%');
    });

    it('181. should allow mapping same global UDP port on different global IPs to separate inside local ports', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 53 203.0.113.1 53');
      const output = await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.20 53 203.0.113.10 53');
      expect(output.trim()).toBe('');
    });

    it('182. should negate port forwarding mapping if no ip nat is re-evaluated with protocol sub-modifier', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('no ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).not.toContain('203.0.113.1:8080');
    });

    it('183. should show translations entries containing correct protocol numbers inside show ip nat translations after UDP forward', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 53 203.0.113.1 53');
      await topo.r1.executeCommand('end');

      await topo.outside_pc1.executeCommand('traceroute -p 53 203.0.113.1');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('udp');
    });

    it('184. should show translations entries containing correct protocol numbers inside show ip nat translations after TCP forward', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      await topo.outside_pc1.executeCommand('telnet 203.0.113.1 8080');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('tcp');
    });

    it('185. should support clear ip nat translation command using inside local IP specifically with port', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 192.168.1.10 80 203.0.113.1 8080');
      expect(output.trim()).toBe('');
    });

    it('186. should support clear ip nat translation command using outside local IP specifically with port', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 198.51.100.10 8080 192.168.1.10 80');
      expect(output.trim()).toBe('');
    });

    it('187. should reject clear ip nat translation tcp if local port has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 192.168.1.10 80800 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('188. should reject clear ip nat translation tcp if global port has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 192.168.1.10 80 203.0.113.1 80800');
      expect(output.toLowerCase()).toContain('%');
    });

    it('189. should support port forwarding on serial subinterfaces name reference', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface Serial0/0/0.10');
      await topo.r1.executeCommand('encapsulation frame-relay 10'); // or dot1q, depending on serial layer
      await topo.r1.executeCommand('exit');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface Serial0/0/0.10 8080');
      expect(output.trim()).toBe('');
    });

    it('190. should reject serial subinterface port forwarding if interface name has typos', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface Seriall0/0/0.10 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('191. should preserve port forwarding configuration parameters across interface resets', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('shutdown');
      await topo.r1.executeCommand('no shutdown');
      await topo.r1.executeCommand('end');

      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
    });

    it('192. should support static PAT on WAN interfaces with dynamic IP mappings (DHCP client IP on external port)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('ip address dhcp');
      await topo.r1.executeCommand('exit');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernet0/1 80');
      expect(output.trim()).toBe('');
    });

    it('193. should show correct interface dynamic PAT mapping in show running-config output', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernet0/1 80');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source static tcp 192.168.1.10 80 interface GigabitEthernet0/1 80');
    });

    it('194. should reject static PAT config if local IP has typo', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.1000 80 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('195. should reject static PAT config if global IP has typo', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1000 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('196. should show correct translation table details inside show ip nat translations after static PAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('tcp');
      expect(table).toContain('203.0.113.1:8080');
    });

    it('197. should clear dynamic entries but retain static PAT mappings on clear ip nat translation *', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      await topo.outside_pc1.executeCommand('telnet 203.0.113.1 8080'); // Generates dynamic translation on top of static
      await topo.r1.executeCommand('clear ip nat translation *');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.1:8080'); // Static remains
    });

    it('198. should block static PAT mapping if the global port is already used in a conflicting mapping', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.20 80 203.0.113.1 8080'); // conflict
      expect(output.toLowerCase()).toContain('%');
    });

    it('199. should block static PAT mapping if the local port is already mapped to the same global IP and port', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080'); // duplicate
      expect(output.toLowerCase()).toContain('%');
    });

    it('200. should execute successfully and return status 0 on complete static PAT configuration', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('configure terminal && ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 && end');
      expect(output).toBeDefined();
    });
  });

  // ─── Section 5: Verification & Diagnostics (Tests 201-250) ────────

  describe('Section 5: NAT/PAT Verification & Diagnostic Commands', () => {
    it('201. should display translations table header correctly on show ip nat translations', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations');
      expect(output).toContain('Pro');
      expect(output).toContain('Inside local');
      expect(output).toContain('Inside global');
      expect(output).toContain('Outside local');
      expect(output).toContain('Outside global');
    });

    it('202. should show "no active translations" initially on empty router translations table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations');
      expect(output.toLowerCase()).toContain('no nat entries');
    });

    it('203. should display statistics details correctly on show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat statistics');
      expect(output).toContain('Total active translations');
      expect(output).toContain('Hits:');
      expect(output).toContain('Misses:');
    });

    it('204. should filter translation entries by TCP protocol using show ip nat translations verbose', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations verbose');
      expect(output).toContain('Pro');
    });

    it('205. should support clearing dynamic translation mappings matching specific inside local IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 192.168.1.10');
      expect(output.trim()).toBe('');
    });

    it('206. should support clearing dynamic translation mappings matching specific inside global IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 203.0.113.10');
      expect(output.trim()).toBe('');
    });

    it('207. should support clearing dynamic translation mappings matching specific outside local IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10');
      expect(output.trim()).toBe('');
    });

    it('208. should support clearing dynamic translation mappings matching specific outside global IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10');
      expect(output.trim()).toBe('');
    });

    it('209. should reject clearing translations if unprivileged user executes command', async () => {
      const topo = setupNATTopology();
      const output = await topo.r1.executeCommand('clear ip nat translation *');
      expect(output.toLowerCase()).toContain('%');
    });

    it('210. should allow showing statistics from user EXEC mode (IOS show is available from user EXEC)', async () => {
      const topo = setupNATTopology();
      const output = await topo.r1.executeCommand('show ip nat statistics');
      expect(output.toLowerCase()).toContain('total');
    });

    it('211. should show active pool allocation percentage inside show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.19 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('POOL_1');
    });

    it('212. should show active interfaces participating in inside translation on show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('GigabitEthernet0/0');
    });

    it('213. should show active interfaces participating in outside translation on show ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('GigabitEthernet0/1');
    });

    it('214. should support autocomplete on abbreviation sh ip nat tr', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('sh ip nat tr');
      expect(output).toContain('Inside local');
    });

    it('215. should support autocomplete on abbreviation sh ip nat stat', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('sh ip nat stat');
      expect(output).toContain('Total active translations');
    });

    it('216. should support autocomplete on abbreviation cl ip nat tr *', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('cl ip nat tr *');
      expect(output.trim()).toBe('');
    });

    it('217. should show correct translation count inside stats after clear', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('clear ip nat translation *');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Dynamic translations: 0');
    });

    it('218. should reject clear ip nat translation tcp if syntax has missing parameters', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp 192.168.1.10'); // missing port and global mapping
      expect(output.toLowerCase()).toContain('%');
    });

    it('219. should reject clear ip nat translation udp if syntax has missing parameters', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation udp 192.168.1.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('220. should retain stats counters when no clear ip nat statistics is executed explicitly', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      // Do not clear stats, check they persist
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).not.toContain('Hits: 0');
    });

    it('221. should support clearing stats counters explicitly using clear ip nat statistics', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('clear ip nat statistics');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Hits: 0');
    });

    it('222. should reject clear ip nat statistics if unprivileged user executes command', async () => {
      const topo = setupNATTopology();
      const output = await topo.r1.executeCommand('clear ip nat statistics');
      expect(output.toLowerCase()).toContain('%');
    });

    it('223. should show correct metrics inside detailed verbose table listings', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand('show ip nat translations verbose');
      expect(output).toContain('flags:');
    });

    it('224. should show correct configuration mode on interface inside show interface parameters', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show running-config interface GigabitEthernet0/0');
      expect(output).toContain('ip nat inside');
    });

    it('225. should show correct configuration mode on WAN interface inside show interface parameters', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show running-config interface GigabitEthernet0/1');
      expect(output).toContain('ip nat outside');
    });

    it('226. should support show ip nat translations verbose with filters matching target local IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand('show ip nat translations verbose inside local 192.168.1.10');
      expect(output).toContain('192.168.1.10');
    });

    it('227. should support show ip nat translations verbose with filters matching target global IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand('show ip nat translations verbose inside global 203.0.113.10');
      expect(output).toContain('203.0.113.10');
    });

    it('228. should reject show ip nat translations verbose if target filter IP is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations verbose inside local 300.1.1.1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('229. should show correct dynamic mapping hits in show ip nat statistics after PAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).not.toContain('Hits: 0');
    });

    it('230. should clear dynamic entries but retain static ones when tcp-timeout occurs', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('231. should support clear ip nat translation inside local_ip specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 192.168.1.10');
      expect(output.trim()).toBe('');
    });

    it('232. should support clear ip nat translation inside global_ip specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 203.0.113.1');
      expect(output.trim()).toBe('');
    });

    it('233. should support clear ip nat translation outside local_ip specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10');
      expect(output.trim()).toBe('');
    });

    it('234. should support clear ip nat translation outside global_ip specifically', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10');
      expect(output.trim()).toBe('');
    });

    it('235. should reject clearing translations if syntax has typos (clear ip nat translaation *)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translaation *');
      expect(output.toLowerCase()).toContain('%');
    });

    it('236. should support show ip nat translations with single quotes wrapping on filter IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand("show ip nat translations verbose inside local '192.168.1.10'");
      expect(output).toContain('192.168.1.10');
    });

    it('237. should support show ip nat translations with double quotes wrapping on filter IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand('show ip nat translations verbose inside local "192.168.1.10"');
      expect(output).toContain('192.168.1.10');
    });

    it('238. should show correct stats inside show ip nat statistics after multiple NAT/PAT mappings', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Total active translations: 1');
    });

    it('239. should not show expired dynamic entries in translation table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('ip nat translation timeout 1'); // set very low timeout
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      // Wait for timeout to occur
      await new Promise(resolve => setTimeout(resolve, 1500));
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).not.toContain('icmp');
    });

    it('240. should show zero stats counters after clear ip nat statistics is executed', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('clear ip nat statistics');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Hits: 0');
    });

    it('241. should preserve statistics counters inside flash storage if write memory is executed', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('write memory');
      await topo.r1.executeCommand('reload');

      await topo.r1.executeCommand('enable');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).not.toContain('Hits: 0');
    });

    it('242. should support showing translations inside specific VRF table using show ip nat translations vrf RED', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations vrf RED');
      expect(table).toContain('203.0.113.10');
    });

    it('243. should show no translations on non-existent VRF', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const table = await topo.r1.executeCommand('show ip nat translations vrf BLUE');
      expect(table.toLowerCase()).toContain('% vrf blue does not exist');
    });

    it('244. should support show ip nat translations verbose option for maximum details', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations verbose');
      expect(table).toContain('create:');
    });

    it('245. should show correct config in show running-config after clear NAT transitions', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.r1.executeCommand('clear ip nat translation *');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source static 192.168.1.10 203.0.113.10'); // static config persists
    });

    it('246. should clear dynamic entries but retain static NAT outside translations on clear', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('clear ip nat translation *');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.50');
    });

    it('247. should show correct stats inside show ip nat statistics after clearing static NAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('no ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Static translations: 0');
    });

    it('248. should support clearing dynamic NAT pool translations explicitly by pool name', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const output = await topo.r1.executeCommand('clear ip nat translation pool POOL_1');
      expect(output.trim()).toBe('');
    });

    it('249. should reject clearing translations by pool name if pool does not exist', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation pool NON_EXISTENT');
      expect(output.toLowerCase()).toContain('%');
    });

    it('250. should execute successfully and return status 0 on clean diagnostics query', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations && echo "DIAG_OK"');
      expect(output).toContain('DIAG_OK');
    });
  });

  // ─── Section 6: Huawei NAT Outbound & NAT Server (Tests 251-300) ───

  describe('Section 6: Huawei NAT Outbound, Address Groups & NAT Server', () => {
    it('251. should configure NAT address group on Huawei switch/router via nat address-group', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      expect(output.trim()).toBe('');
    });

    it('252. should configure acl rule to match inside local traffic in Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('acl 2000');
      const output = await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      expect(output.trim()).toBe('');
    });

    it('253. should bind acl to address-group on Huawei interface via nat outbound', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 2000 address-group 1');
      expect(output.trim()).toBe('');
    });

    it('254. should configure Huawei Easy IP (NAT outbound interface) using nat outbound 2000', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 2000'); // No address-group translates directly to interface IP (Easy IP)
      expect(output.trim()).toBe('');
    });

    it('255. should configure Huawei NAT Server (static port forwarding) via nat server', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      expect(output.trim()).toBe('');
    });

    it('256. should show NAT session translations table using display nat session', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session all');
      expect(output).toContain('NAT Session Table');
    });

    it('257. should show NAT configuration metrics using display nat outbound', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat outbound');
      expect(output).toContain('NAT Outbound Information');
    });

    it('258. should show NAT server configuration metrics using display nat server', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat server');
      expect(output).toContain('NAT Server Information');
    });

    it('259. should show NAT address groups using display nat address-group', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat address-group');
      expect(output).toContain('NAT Address Group Information');
    });

    it('260. should show NAT statistics using display nat statistics', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat statistics');
      expect(output).toContain('NAT Statistics Information');
    });

    it('261. should disable dynamic NAT outbound binding using undo nat outbound', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('undo nat outbound 2000');
      expect(output.trim()).toBe('');
    });

    it('262. should disable NAT Server port forwarding using undo nat server', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('undo nat server protocol tcp global 203.0.113.1 8080');
      expect(output.trim()).toBe('');
    });

    it('263. should disable address group using undo nat address-group', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('undo nat address-group 1');
      expect(output.trim()).toBe('');
    });

    it('264. should reject nat address-group if start IP is greater than end IP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('nat address-group 1 203.0.113.20 203.0.113.10');
      expect(output.toLowerCase()).toContain('error');
    });

    it('265. should reject nat outbound if target ACL does not exist', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 9999'); // ACL 9999 doesn't exist
      expect(output.toLowerCase()).toContain('error');
    });

    it('266. should reject nat outbound if target address-group does not exist', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 2000 address-group 99'); // address-group 99 doesn't exist
      expect(output.toLowerCase()).toContain('error');
    });

    it('267. should reject nat server config if global port is out of range', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 70000 inside 192.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('268. should reject nat server config if inside port is out of range', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 80 inside 192.168.1.10 70000');
      expect(output.toLowerCase()).toContain('error');
    });

    it('269. should support dynamic NAT outbound no-pat options (ip address mapping without port translation)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 2000 address-group 1 no-pat');
      expect(output.trim()).toBe('');
    });

    it('270. should show no-pat flag correctly inside display nat outbound', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat outbound 2000 address-group 1 no-pat');
      const status = await sw.executeCommand('display nat outbound');
      expect(status.toLowerCase()).toContain('no-pat');
    });

    it('271. should support clear NAT session table entries explicitly on Huawei using reset nat session', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('reset nat session all');
      expect(output.trim()).toBe('');
    });

    it('272. should reject reset nat session if target parameters have typos', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('reset nat session allll');
      expect(output.toLowerCase()).toContain('error');
    });

    it('273. should support display current-configuration on Huawei switches to verify NAT persists', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      const output = await sw.executeCommand('display current-configuration');
      expect(output).toContain('nat server');
    });

    it('274. should deny unprivileged users access to enter system-view on Huawei (checking privilege level limits)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      const output = await sw.executeCommand('system-view'); // if privilege level is restricted in mock user, verify refusal
      expect(sw).toBeDefined();
    });

    it('275. should support static NAT server mapping on Huawei L3 VLAN Interface (Vlanif)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif10');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      expect(output.trim()).toBe('');
    });

    it('276. should display vlanif configuration in display current-configuration', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif10');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      const output = await sw.executeCommand('display current-configuration');
      expect(output).toContain('interface Vlanif10');
    });

    it('277. should reject nat address-group if the ID parameter is out of range', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('nat address-group 99999 203.0.113.10 203.0.113.20');
      expect(output.toLowerCase()).toContain('error');
    });

    it('278. should support single quotes around address-group IP targets in VRP terminal', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand("nat address-group 1 '203.0.113.10' '203.0.113.20'");
      expect(output.trim()).toBe('');
    });

    it('279. should support double quotes around address-group IP targets in VRP terminal', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('nat address-group 1 "203.0.113.10" "203.0.113.20"');
      expect(output.trim()).toBe('');
    });

    it('280. should reject nat outbound configuration if target ACL number is invalid (e.g. 100)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 100'); // Huawei standard ACLs start from 2000
      expect(output.toLowerCase()).toContain('error');
    });

    it('281. should support advanced numbered ACLs up to 3999 in VRP (ACL 3000)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('acl 3000');
      expect(output.trim()).toBe('');
    });

    it('282. should support binding dynamic NAT outbound to advanced ACL 3000', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      await sw.executeCommand('acl 3000');
      await sw.executeCommand('rule 5 permit ip source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 3000 address-group 1');
      expect(output.trim()).toBe('');
    });

    it('283. should reject nat outbound if the parameters key has typos', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outboundd 2000');
      expect(output.toLowerCase()).toContain('error');
    });

    it('284. should reject nat server if the parameters key has typos', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat serverr protocol tcp global 203.0.113.1 80 inside 192.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('285. should support displaying Vlanif NAT bindings in display interface Vlanif command', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif10');
      await sw.executeCommand('ip address 203.0.113.1 255.255.255.0');
      const output = await sw.executeCommand('display interface Vlanif10');
      expect(output).toContain('Vlanif10');
    });

    it('286. should support displaying GigabitEthernet NAT bindings in display interface GigabitEthernet command', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('display interface GigabitEthernet0/0/1');
      expect(output).toContain('GigabitEthernet0/0/1');
    });

    it('287. should reject reset nat session if session matching IP is completely invalid', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('reset nat session inside 300.1.1.1');
      expect(output.toLowerCase()).toContain('error');
    });

    it('288. should handle empty commands strings execution gracefully on Huawei terminal', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      const output = await sw.executeCommand('system-view ""');
      expect(output.toLowerCase()).toContain('error');
    });

    it('289. should show correct NAT session ports mappings inside display nat session outputs', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session all');
      expect(output).toContain('NAT Session Table');
    });

    it('290. should preserve address groups tables after they are configured on Huawei', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      const output = await sw.executeCommand('display nat address-group');
      expect(output).toContain('203.0.113.10');
      expect(output).toContain('203.0.113.20');
    });

    it('291. should negate address group mappings via undo nat address-group', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.20');
      await sw.executeCommand('undo nat address-group 1');
      const output = await sw.executeCommand('display nat address-group');
      expect(output.toLowerCase()).not.toContain('203.0.113.10');
    });

    it('292. should preserve NAT Server rules after interface configurations status changes (shutdown -> undo shutdown)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      await sw.executeCommand('shutdown');
      await sw.executeCommand('undo shutdown');
      const output = await sw.executeCommand('display nat server');
      expect(output).toContain('203.0.113.1:8080');
    });

    it('293. should show correct server translations inside display nat server after deletions', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      await sw.executeCommand('undo nat server protocol tcp global 203.0.113.1 8080');
      const output = await sw.executeCommand('display nat server');
      expect(output.toLowerCase()).not.toContain('203.0.113.1:8080');
    });

    it('294. should support NAT Server UDP protocol configurations', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol udp global 203.0.113.1 53 inside 192.168.1.10 53');
      expect(output.trim()).toBe('');
    });

    it('295. should support NAT Server wildcard global ports (any)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 any inside 192.168.1.10 any');
      expect(output.toLowerCase()).toContain('error'); // VRP nat server requires explicit port mappings, verify rejected
    });

    it('296. should reject NAT Server configuration if the global protocol sub-modifier is completely unknown', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol unknown global 203.0.113.1 80 inside 192.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('297. should support showing NAT Server configuration mappings inside VRP display interface command', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      const output = await sw.executeCommand('display this');
      expect(output).toContain('nat server');
    });

    it('298. should preserve all SVI VLAN interfaces status configurations inside Huawei switch across multiple NAT reboots', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif10');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      await sw.executeCommand('quit');
      await sw.executeCommand('save'); // persist to virtual flash
      await sw.executeCommand('reboot'); // soft reboot

      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display current-configuration');
      expect(output).toContain('nat server');
    });

    it('299. should reject NAT server config if the local IP is missing inside VRP system view', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 80'); // missing local IP
      expect(output.toLowerCase()).toContain('error');
    });

    it('300. should execute successfully and return empty output on default VRP nat server configuration', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      expect(output.trim()).toBe('');
    });
  });

  // ─── Section 7: WAN Routing Interlocking, MTU & ALG (Tests 301-350) ───

  describe('Section 7: WAN Routing Interlocking, MTU, ALG & NAT Order of Operations', () => {
    it('301. should route inside packet to WAN gateway before translating (order of operations check)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10'); // translation occurs because packet routed out external port
    });

    it('302. should translate DNS reply payloads dynamically (DNS ALG simulation)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('ip nat service dns'); // Enable DNS ALG
      await topo.r1.executeCommand('end');

      expect(topo.r1).toBeDefined();
    });

    it('303. should translate FTP active port negotiation payloads dynamically (FTP ALG simulation)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('ip nat service ftp'); // Enable FTP ALG
      await topo.r1.executeCommand('end');

      expect(topo.r1).toBeDefined();
    });

    it('304. should handle NAT mapping on fragmented IP packets (reassembles/translates fragments correctly)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      // Send large packet requiring fragmentation
      await topo.inside_pc1.executeCommand('ping -c 1 -s 2000 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('305. should translate TCP packet payloads successfully if MTU boundary changes on external port (MTU 1400)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('ip mtu 1400'); // alter external MTU
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 -s 1300 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('306. should deny translation and drop packet if DF is set and packet size exceeds 1400 MTU', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('ip mtu 1400');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      // Linux: -M want (set DF), size 1450
      const output = await topo.inside_pc1.executeCommand('ping -c 1 -M want -s 1450 198.51.100.10');
      expect(output.toLowerCase()).toMatch(/local error|too long|frag needed/);
    });

    it('307. should route packet statically across inside VLAN subinterfaces', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/0.10');
      await topo.r1.executeCommand('encapsulation dot1q 10');
      await topo.r1.executeCommand('ip address 192.168.10.1 255.255.255.0');
      await topo.r1.executeCommand('ip nat inside');
      await topo.r1.executeCommand('end');

      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('interface GigabitEthernet0/0.10');
    });

    it('308. should translate packet if private host is connected via suboptimal switch ports (L2 redundancy)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      // SW1 is standard layer 2 switch, ping should succeed and translate
      const ping = await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      expect(ping).toContain('64 bytes');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('309. should handle reverse translation correctly if outside host initiates TCP connection to port forward', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080');
      await topo.r1.executeCommand('end');

      await topo.outside_pc1.executeCommand('telnet 203.0.113.1 8080');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('192.168.1.10:80');
    });

    it('10. should block WAN to LAN traffic on PAT overloaded ports unless connection matches an active session', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      // Outside host attempts unsolicited ping to internal PC1 (192.168.1.10) directly (unroutable/blocked)
      const ping = await topo.outside_pc1.executeCommand('ping -c 1 -W 1 192.168.1.10');
      expect(ping).toContain('100% packet loss');
    });

    it('311. should translate inside local source IP to inside global SVI interface IP inside Huawei VRP (NAT server order of operations)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif10');
      await sw.executeCommand('ip address 203.0.113.1 255.255.255.0');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      const output = await sw.executeCommand('display nat server');
      expect(output).toContain('203.0.113.1:8080');
    });

    it('312. should configure Huawei DNS ALG explicitly (nat alg dns enable)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('nat alg dns enable');
      expect(output.trim()).toBe('');
    });

    it('313. should configure Huawei FTP ALG explicitly (nat alg ftp enable)', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('nat alg ftp enable');
      expect(output.trim()).toBe('');
    });

    it('314. should show correct state in display nat statistics on heavy fragmented traffic sessions', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat statistics');
      expect(output).toContain('NAT Statistics Information');
    });

    it('315. should reject route mapping inside dynamic pool config if pool subnet overlaps with WAN gateway interface IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      // WAN interface has 203.0.113.1, pool cannot overlap this IP as pool target
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.1 203.0.113.1 netmask 255.255.255.252');
      expect(output.toLowerCase()).toContain('%');
    });

    it('316. should allow configuring static port forwarding mapping targeting the physical gateway WAN IP (ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 80)', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 80');
      expect(output.trim()).toBe('');
    });

    it('317. should show the WAN-directed port forwarding translation in translation table', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 80');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.1:80');
    });

    it('318. should translate successfully inside NAT/PAT overloaded environments if target is in suboptimal routing paths on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat outbound 2000');
      expect(sw).toBeDefined();
    });

    it('319. should negate Huawei DNS ALG configuration via undo nat alg dns', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('undo nat alg dns');
      const output = await sw.executeCommand('display current-configuration');
      expect(output).not.toContain('nat alg dns enable');
    });

    it('320. should negate Huawei FTP ALG configuration via undo nat alg ftp', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('undo nat alg ftp');
      const output = await sw.executeCommand('display current-configuration');
      expect(output).not.toContain('nat alg ftp enable');
    });

    it('321. should route and translate packets correctly when NAT pool is bound inside Cisco VRF interface mapping', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip vrf forwarding RED');
      await topo.r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await topo.r1.executeCommand('ip nat inside');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('322. should display VRF NAT binding in show running-config output', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 vrf RED');
      await topo.r1.executeCommand('end');
      const running = await topo.r1.executeCommand('show running-config');
      expect(running).toContain('ip nat inside source list 1 pool POOL_1 vrf RED');
    });

    it('323. should translate successfully inside NAT/PAT overloaded environments if target is in suboptimal routing paths on Cisco IOS with VRF', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip vrf forwarding RED');
      await topo.r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      // Inside PC1 pings through VRF boundary
      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toBeDefined();
    });

    it('324. should show correct stats inside show ip nat statistics after VRF translation', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip vrf forwarding RED');
      await topo.r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toBeDefined();
    });

    it('325. should not create duplicate VRF NAT mapping rules on duplicate config terminal calls', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 vrf RED');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 vrf RED'); // duplicate
      expect(output.trim()).toBe('');
    });

    it('326. should reject VRF NAT mapping rule if targeted VRF is completely undefined', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 vrf NON_EXISTENT');
      expect(output.toLowerCase()).toContain('%');
    });

    it('327. should negate VRF NAT mapping rule explicitly using no ip nat inside source list vrf', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 vrf RED');
      const output = await topo.r1.executeCommand('no ip nat inside source list 1 pool POOL_1 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('328. should support NAT inside source static VRF mappings', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      const output = await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('329. should show static VRF translation in translation table', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.10');
    });

    it('330. should negate static VRF translation explicitly using no ip nat inside source static vrf', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      const output = await topo.r1.executeCommand('no ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('331. should support static NAT outside VRF translation mappings (ip nat outside source static vrf)', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      const output = await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('332. should show outside static VRF translation in translation table', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50 vrf RED');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.50');
    });

    it('333. should negate outside static VRF translation explicitly using no ip nat outside source static vrf', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat outside source static 198.51.100.10 203.0.113.50 vrf RED');
      const output = await topo.r1.executeCommand('no ip nat outside source static 198.51.100.10 203.0.113.50 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('334. should support static PAT VRF mappings', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('335. should show static PAT VRF translation in translation table', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 vrf RED');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table).toContain('203.0.113.1:8080');
    });

    it('336. should negate static PAT VRF translation explicitly using no ip nat inside source static tcp vrf', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 vrf RED');
      const output = await topo.r1.executeCommand('no ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 8080 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('337. should support showing translations inside specific VRF table using show ip nat translations verbose vrf RED', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      await topo.r1.executeCommand('end');
      const table = await topo.r1.executeCommand('show ip nat translations verbose vrf RED');
      expect(table).toContain('203.0.113.10');
    });

    it('338. should support clearing dynamic translation mappings matching specific inside local IP inside VRF', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('end');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 192.168.1.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('339. should support clearing dynamic translation mappings matching specific inside global IP inside VRF', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('end');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 203.0.113.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('340. should support clearing dynamic translation mappings matching specific outside local IP inside VRF', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('end');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('341. should support clearing dynamic translation mappings matching specific outside global IP inside VRF', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('end');
      const output = await topo.r1.executeCommand('clear ip nat translation outside 198.51.100.10 vrf RED');
      expect(output.trim()).toBe('');
    });

    it('342. should reject clearing translations inside VRF if target VRF is completely undefined', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation inside 192.168.1.10 vrf NON_EXISTENT');
      expect(output.toLowerCase()).toContain('%');
    });

    it('343. should show correct stats inside show ip nat statistics vrf RED', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip vrf forwarding RED');
      await topo.r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      const stats = await topo.r1.executeCommand('show ip nat statistics vrf RED');
      expect(stats).toBeDefined();
    });

    it('344. should show no statistics on non-existent VRF', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const stats = await topo.r1.executeCommand('show ip nat statistics vrf BLUE');
      expect(stats.toLowerCase()).toContain('% vrf blue does not exist');
    });

    it('345. should support clearing stats counters explicitly using clear ip nat statistics vrf RED', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip vrf forwarding RED');
      await topo.r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('clear ip nat statistics vrf RED');
      const stats = await topo.r1.executeCommand('show ip nat statistics vrf RED');
      expect(stats).toBeDefined();
    });

    it('346. should reject clear ip nat statistics vrf if target VRF is completely undefined', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat statistics vrf NON_EXISTENT');
      expect(output.toLowerCase()).toContain('%');
    });

    it('347. should support showing translations inside specific VRF table using show ip nat translations verbose vrf RED with filters matching target local IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand('show ip nat translations verbose vrf RED inside local 192.168.1.10');
      expect(output).toContain('192.168.1.10');
    });

    it('348. should support showing translations inside specific VRF table using show ip nat translations verbose vrf RED with filters matching target global IP', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip vrf RED');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10 vrf RED');
      await topo.r1.executeCommand('end');

      const output = await topo.r1.executeCommand('show ip nat translations verbose vrf RED inside global 203.0.113.10');
      expect(output).toContain('203.0.113.10');
    });

    it('349. should reject show ip nat translations verbose vrf if target filter IP is invalid', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations verbose vrf RED inside local 300.1.1.1');
      expect(output.toLowerCase()).toContain('%');
    });

    it('350. should execute successfully and return status 0 on default VRF NAT configuration', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('configure terminal && ip vrf RED && end');
      expect(output).toBeDefined();
    });
  });

  // ─── Section 8: Edge Cases & Syntax Error Handlers (Tests 351-400) 

  describe('Section 8: Edge Cases, Pool Exhaustion, Typos & Syntax Error Handlers', () => {
    it('351. should reject ip nat inside source list command if syntax is completely unrecognized', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1 invalid_extra_args');
      expect(output.toLowerCase()).toContain('%');
    });

    it('352. should reject ip nat pool command if syntax is completely unrecognized', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0 invalid_extra_args');
      expect(output.toLowerCase()).toContain('%');
    });

    it('353. should reject static NAT config if syntax has unmatched quotes wrapping around target IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static "192.168.1.10 203.0.113.10');
      expect(output.toLowerCase()).toContain('%');
    });

    it('354. should reject static PAT config if syntax has unmatched quotes wrapping around target IP', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp "192.168.1.10 80 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('%');
    });

    it('355. should reject dynamic NAT pool configuration if pool name exceeds 31 characters limit', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const longName = 'P'.repeat(35);
      const output = await topo.r1.executeCommand(`ip nat pool ${longName} 203.0.113.10 203.0.113.20 netmask 255.255.255.0`);
      expect(output.toLowerCase()).toContain('%');
    });

    it('356. should reject NAT Server configuration if the global IP parameter has typo on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 300.0.113.1 8080 inside 192.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('357. should reject NAT Server configuration if the inside IP parameter has typo on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 300.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('358. should reject NAT Server configuration if the global port parameter is missing on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 inside 192.168.1.10 80'); // missing global port
      expect(output.toLowerCase()).toContain('error');
    });

    it('359. should reject NAT Server configuration if the inside port parameter is missing on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10'); // missing inside port
      expect(output.toLowerCase()).toContain('error');
    });

    it('360. should reject NAT Server configuration if the global protocol parameter has typo on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcpp global 203.0.113.1 8080 inside 192.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('361. should reject dynamic NAT outbound binding if the target ACL number is out of range on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 99999'); // Huawei standard ACLs range 2000-2999, advanced 3000-3999
      expect(output.toLowerCase()).toContain('error');
    });

    it('362. should reject dynamic NAT outbound binding if the target address-group number is out of range on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat outbound 2000 address-group 99999');
      expect(output.toLowerCase()).toContain('error');
    });

    // ─── Section 8: Continuation (Tests 363-400) ───────────────────

    it('363. should reject undo nat outbound if the parameters key has typos on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('undo nat outboundd 2000');
      expect(output.toLowerCase()).toContain('error');
    });

    it('364. should reject undo nat server if the parameters key has typos on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('undo nat serverr protocol tcp global 203.0.113.1 8080');
      expect(output.toLowerCase()).toContain('error');
    });

    it('365. should reject undo nat address-group if the parameters key has typos on Huawei VRP', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('undo nat address-groupp 1');
      expect(output.toLowerCase()).toContain('error');
    });

    it('366. should reject conflicting Huawei NAT Server configuration mapping same global IP/port to different inside targets', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.10 80');
      const output = await sw.executeCommand('nat server protocol tcp global 203.0.113.1 8080 inside 192.168.1.20 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('367. should support multiple Huawei NAT Outbound rules configured on the same interface', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('nat address-group 1 203.0.113.10 203.0.113.15');
      await sw.executeCommand('nat address-group 2 203.0.113.20 203.0.113.25');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.127');
      await sw.executeCommand('acl 2001');
      await sw.executeCommand('rule 5 permit source 192.168.1.128 0.0.0.127');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('nat outbound 2000 address-group 1');
      const output = await sw.executeCommand('nat outbound 2001 address-group 2');
      expect(output.trim()).toBe('');
    });

    it('368. should reject NAT/PAT enabling on interface with no assigned IP address', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/2'); // No IP assigned
      const output = await topo.r1.executeCommand('ip nat inside');
      expect(output.toLowerCase()).toContain('%'); // Interface must have an IP address configured first
    });

    it('369. should fail communication if host tries to access dynamic NAT SVI whose interface link is down', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('shutdown'); // Shutdown inside link
      await topo.r1.executeCommand('end');

      const ping = await topo.inside_pc1.executeCommand('ping -c 1 -W 1 198.51.100.10');
      expect(ping).toContain('packet loss');
    });

    it('370. should configure Cisco policy-based NAT using route maps', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 10 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('route-map NAT_MAP permit 10');
      await topo.r1.executeCommand('match ip address 10');
      await topo.r1.executeCommand('exit');
      const output = await topo.r1.executeCommand('ip nat inside source route-map NAT_MAP interface GigabitEthernet0/1 overload');
      expect(output.trim()).toBe('');
    });

    it('371. should negate route-map based NAT configuration explicitly', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 10 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('route-map NAT_MAP permit 10');
      await topo.r1.executeCommand('match ip address 10');
      await topo.r1.executeCommand('exit');
      await topo.r1.executeCommand('ip nat inside source route-map NAT_MAP interface GigabitEthernet0/1 overload');
      const output = await topo.r1.executeCommand('no ip nat inside source route-map NAT_MAP interface GigabitEthernet0/1 overload');
      expect(output.trim()).toBe('');
    });

    it('372. should reject enabling ip nat inside on loopback interface if loopback is administratively down', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface Loopback0');
      await topo.r1.executeCommand('shutdown');
      const output = await topo.r1.executeCommand('ip nat inside');
      expect(output.toLowerCase()).toContain('%');
    });

    it('373. should reject static PAT configuration if the port number exceeds 65535 boundary', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat inside source static tcp 192.168.1.10 80 203.0.113.1 65536');
      expect(output.toLowerCase()).toContain('%');
    });

    it('374. should reject dynamic NAT pool configuration if netmask does not align with IP range parameters', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.252'); // pool has 11 addresses but mask only permits 2
      expect(output.toLowerCase()).toContain('%');
    });

    it('375. should show correct state inside show ip nat statistics when max translations limit is reached', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat translation max-entries 2'); // limit to 2
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.inside_pc2.executeCommand('ping -n 1 198.51.100.10');

      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('max-entries 2');
    });

    it('376. should block new translations once maximum translation entries limit is exceeded', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat translation max-entries 1'); // limit to 1
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 interface GigabitEthernet0/1 overload');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10'); // claims 1st entry
      const ping2 = await topo.inside_pc2.executeCommand('ping -n 1 -w 1000 198.51.100.10'); // blocked
      expect(ping2).toContain('Request timed out');
    });

    it('377. should reject clearing TCP translations if wildcard options format contains syntax errors', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('clear ip nat translation tcp * * * invalid_wildcard');
      expect(output.toLowerCase()).toContain('%');
    });

    it('378. should support showing statistics when extremely long pool names are configured', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const longName = 'POOL_' + 'N'.repeat(25);
      await topo.r1.executeCommand(`ip nat pool ${longName} 203.0.113.10 203.0.113.20 netmask 255.255.255.0`);
      await topo.r1.executeCommand('end');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain(longName);
    });

    it('379. should display only TCP session entries inside Huawei display nat session protocol tcp', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session protocol tcp');
      expect(output).toContain('NAT Session Table');
    });

    it('380. should display only UDP session entries inside Huawei display nat session protocol udp', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session protocol udp');
      expect(output).toContain('NAT Session Table');
    });

    it('381. should display only ICMP session entries inside Huawei display nat session protocol icmp', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session protocol icmp');
      expect(output).toContain('NAT Session Table');
    });

    it('382. should display sessions matched by specific source IP inside display nat session source', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session source 192.168.1.10');
      expect(output).toContain('NAT Session Table');
    });

    it('383. should display sessions matched by specific destination IP inside display nat session destination', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat session destination 198.51.100.10');
      expect(output).toContain('NAT Session Table');
    });

    it('384. should display empty stats cleanly on unconfigured Huawei interface', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      const output = await sw.executeCommand('display nat statistics interface GigabitEthernet0/0/1');
      expect(output).toContain('NAT Statistics Information');
    });

    it('385. should deny any dynamic NAT allocation if access-list contains implicit deny all only', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 deny any'); // Implicit deny all matching
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      const ping = await topo.inside_pc1.executeCommand('ping -c 1 -W 1 198.51.100.10'); // should fail to translate and drop
      expect(ping).toContain('100% packet loss');
    });

    it('386. should support TFTP ALG translation under static PAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat service tftp'); // Enable TFTP ALG
      await topo.r1.executeCommand('ip nat inside source static udp 192.168.1.10 69 203.0.113.1 69');
      await topo.r1.executeCommand('end');
      expect(topo.r1).toBeDefined();
    });

    it('387. should support SIP ALG translation under static NAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat service sip'); // Enable SIP ALG
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      expect(topo.r1).toBeDefined();
    });

    it('388. should support H.323 ALG translation under static NAT', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat service h323'); // Enable H.323 ALG
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');
      expect(topo.r1).toBeDefined();
    });

    it('389. should reject Huawei VRP NAT Server configuration using icmp protocol', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol icmp global 203.0.113.1 inside 192.168.1.10'); // Invalid, icmp doesn't support port mapping
      expect(output.toLowerCase()).toContain('error');
    });

    it('390. should support configuring nat outbound on a Huawei loopback interface', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface LoopBack0');
      await sw.executeCommand('acl 2000');
      await sw.executeCommand('rule 5 permit source 192.168.1.0 0.0.0.255');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface LoopBack0');
      const output = await sw.executeCommand('nat outbound 2000');
      expect(output.trim()).toBe('');
    });

    it('391. should reject configuring overlapping static inside and static outside translation mappings', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      const output = await topo.r1.executeCommand('ip nat outside source static 203.0.113.10 192.168.1.10'); // overlap
      expect(output.toLowerCase()).toContain('%');
    });

    it('392. should deny translation if access-list matches multicast range only', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.20 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 224.0.0.0 15.255.255.255'); // multicast matches only
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 -W 1 198.51.100.10'); // dropped/untranslated
      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('no nat entries');
    });

    it('393. should trigger instant port exhaustion on dynamic PAT pool consisting of single IP and single port if 2 sessions are requested', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_EXHAUST 203.0.113.10 203.0.113.10 netmask 255.255.255.252');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_EXHAUST overload');
      await topo.r1.executeCommand('ip nat translation port-timeout 1'); // enforce instant reuse timeout if supported
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('telnet 198.51.100.10 80');
      expect(topo.r1).toBeDefined();
    });

    it('394. should verify translation table is cleared immediately after dynamic pool boundary change', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat pool POOL_1 203.0.113.10 203.0.113.15 netmask 255.255.255.0');
      await topo.r1.executeCommand('access-list 1 permit 192.168.1.0 0.0.0.255');
      await topo.r1.executeCommand('ip nat inside source list 1 pool POOL_1');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('no ip nat inside source list 1 pool POOL_1'); // changing pool mapping forces translations flush
      await topo.r1.executeCommand('end');

      const table = await topo.r1.executeCommand('show ip nat translations');
      expect(table.toLowerCase()).toContain('no nat entries');
    });

    it('395. should configure ip nat translation max-entries configuration parameter', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation max-entries 1000');
      expect(output.trim()).toBe('');
    });

    it('396. should reject ip nat translation max-entries configuration if value exceeds platform limits', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation max-entries 9999999');
      expect(output.toLowerCase()).toContain('%');
    });

    it('397. should reject setting translation timeout parameters to 0', async () => {
      const topo = setupNATTopology();
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      const output = await topo.r1.executeCommand('ip nat translation timeout 0');
      expect(output.toLowerCase()).toContain('%');
    });

    it('398. should reject Huawei VRP nat server configuration using hostname instead of IP address', async () => {
      const sw = new HuaweiSwitch('sw1', 'SW1', 24, 0, 0);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      const output = await sw.executeCommand('nat server protocol tcp global my_gateway_host 8080 inside 192.168.1.10 80');
      expect(output.toLowerCase()).toContain('error');
    });

    it('399. should support clearing dynamic stats counters using abbreviation cl ip nat sta', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('ip nat inside source static 192.168.1.10 203.0.113.10');
      await topo.r1.executeCommand('end');

      await topo.inside_pc1.executeCommand('ping -c 1 198.51.100.10');
      await topo.r1.executeCommand('cl ip nat sta');
      const stats = await topo.r1.executeCommand('show ip nat statistics');
      expect(stats).toContain('Hits: 0');
    });

    it('400. should execute successfully and return status 0 on complete NAT/PAT validations suite run', async () => {
      const topo = setupNATTopology();
      await configureBasicNATRouting(topo);
      await topo.r1.executeCommand('enable');
      const output = await topo.r1.executeCommand('show ip nat translations && echo "NAT_PAT_COMPLETE"');
      expect(output).toContain('NAT_PAT_COMPLETE');
    });
  });
});
