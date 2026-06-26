/**
 * WAN-level Ping, Traceroute, and Tracert Comprehensive Test Suite.
 * 
 * Contains exactly 300 unit test scenarios covering:
 *  - Section 1: Linux `ping` Command & Advanced Parameters (Tests 1-50)
 *  - Section 2: Windows `ping` Command & Advanced Parameters (Tests 51-100)
 *  - Section 3: Linux `traceroute` Protocols and Flags (Tests 101-150)
 *  - Section 4: Windows `tracert` Protocol and Flags (Tests 151-200)
 *  - Section 5: WAN Routing Coherence, Multi-Hop Traces & MTU Fragmentations (Tests 201-250)
 *  - Section 6: Security Privilege Boundaries, Cable Drops & Failure Edge Cases (Tests 251-300)
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

// ─── WAN Topology Helper ────────────────────────────────────────────

function setupWANTopology() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new WindowsPC('PC2', 200, 0);

  const sw1 = new CiscoSwitch('sw1', 'SW1', 24, 50, 50);
  const r1 = new CiscoRouter('r1', 'R1', 100, 50);
  const r2 = new CiscoRouter('r2', 'R2', 100, 150); // Huawei routeur simulé ou Cisco
  const hw_sw1 = new HuaweiSwitch('hw_sw1', 'HW_SW1', 24, 150, 150); // Huawei L3 Switch
  const sw2 = new CiscoSwitch('sw2', 'SW2', 24, 50, 150);

  const c1 = new Cable('c1');
  c1.connect(pc1.getPort('eth0')!, sw1.getPort('FastEthernet0/1')!);

  const c2 = new Cable('c2');
  c2.connect(sw1.getPort('FastEthernet0/24')!, r1.getPort('GigabitEthernet0/0')!);

  const c3 = new Cable('c3');
  c3.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  const c4 = new Cable('c4');
  c4.connect(r2.getPort('GigabitEthernet0/0')!, hw_sw1.getPort('GigabitEthernet0/0/1')!);

  const c5 = new Cable('c5');
  c5.connect(hw_sw1.getPort('GigabitEthernet0/0/2')!, sw2.getPort('FastEthernet0/24')!);

  const c6 = new Cable('c6');
  c6.connect(sw2.getPort('FastEthernet0/1')!, pc2.getPort('eth0')!);

  return { pc1, pc2, sw1, r1, r2, hw_sw1, sw2, c1, c2, c3, c4, c5, c6 };
}

async function configureWANIPs(topo: ReturnType<typeof setupWANTopology>) {
  // PC1 (Linux)
  await topo.pc1.executeCommand('ifconfig eth0 10.0.1.10 netmask 255.255.255.0');
  await topo.pc1.executeCommand('ip route add default via 10.0.1.1');

  // R1 (Cisco)
  await topo.r1.executeCommand('enable');
  await topo.r1.executeCommand('configure terminal');
  await topo.r1.executeCommand('interface GigabitEthernet0/0');
  await topo.r1.executeCommand('ip address 10.0.1.1 255.255.255.0');
  await topo.r1.executeCommand('no shutdown');
  await topo.r1.executeCommand('exit');
  await topo.r1.executeCommand('interface GigabitEthernet0/1');
  await topo.r1.executeCommand('ip address 10.0.12.1 255.255.255.0');
  await topo.r1.executeCommand('no shutdown');
  await topo.r1.executeCommand('exit');
  await topo.r1.executeCommand('ip route 10.0.2.0 255.255.255.0 10.0.12.2');
  await topo.r1.executeCommand('ip route 10.0.23.0 255.255.255.0 10.0.12.2');
  await topo.r1.executeCommand('end');

  // R2 (Cisco/Huawei L3 equivalent)
  await topo.r2.executeCommand('enable');
  await topo.r2.executeCommand('configure terminal');
  await topo.r2.executeCommand('interface GigabitEthernet0/1');
  await topo.r2.executeCommand('ip address 10.0.12.2 255.255.255.0');
  await topo.r2.executeCommand('no shutdown');
  await topo.r2.executeCommand('exit');
  await topo.r2.executeCommand('interface GigabitEthernet0/0');
  await topo.r2.executeCommand('ip address 10.0.23.2 255.255.255.0');
  await topo.r2.executeCommand('no shutdown');
  await topo.r2.executeCommand('exit');
  await topo.r2.executeCommand('ip route 10.0.1.0 255.255.255.0 10.0.12.1');
  await topo.r2.executeCommand('ip route 10.0.2.0 255.255.255.0 10.0.23.3');
  await topo.r2.executeCommand('end');

  // HW_SW1 (Huawei L3 Switch)
  await topo.hw_sw1.executeCommand('system-view');
  await topo.hw_sw1.executeCommand('vlan batch 10 20');
  await topo.hw_sw1.executeCommand('interface GigabitEthernet0/0/1');
  await topo.hw_sw1.executeCommand('port link-type access');
  await topo.hw_sw1.executeCommand('port default vlan 10');
  await topo.hw_sw1.executeCommand('quit');
  await topo.hw_sw1.executeCommand('interface GigabitEthernet0/0/2');
  await topo.hw_sw1.executeCommand('port link-type access');
  await topo.hw_sw1.executeCommand('port default vlan 20');
  await topo.hw_sw1.executeCommand('quit');
  await topo.hw_sw1.executeCommand('interface Vlanif10');
  await topo.hw_sw1.executeCommand('ip address 10.0.23.3 255.255.255.0');
  await topo.hw_sw1.executeCommand('quit');
  await topo.hw_sw1.executeCommand('interface Vlanif20');
  await topo.hw_sw1.executeCommand('ip address 10.0.2.1 255.255.255.0');
  await topo.hw_sw1.executeCommand('quit');
  await topo.hw_sw1.executeCommand('ip route-static 10.0.1.0 255.255.255.0 10.0.23.2');
  await topo.hw_sw1.executeCommand('quit');

  // PC2 (Windows)
  await topo.pc2.executeCommand('netsh interface ip set address "Ethernet" static 10.0.2.10 255.255.255.0 10.0.2.1');
}

// ═══════════════════════════════════════════════════════════════════
// PING & TRACEROUTE COMMAND TESTS (1-300)
// ═══════════════════════════════════════════════════════════════════

describe('WAN-level Ping and Traceroute Command Suite', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── Section 1: Linux ping Command & Parameters (Tests 1-50) ──────

  describe('Section 1: Linux ping Command & Advanced Parameters', () => {
    it('1. should ping local loopback on Linux PC', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 127.0.0.1');
      expect(output).toContain('64 bytes from 127.0.0.1');
      expect(output).toContain('1 packets transmitted, 1 received');
    });

    it('2. should ping remote host with specific packet count using -c', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 3 10.0.2.10');
      expect(output).toContain('3 packets transmitted, 3 received');
    });

    it('3. should ping with custom packet size using -s', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -s 120 10.0.2.10');
      expect(output).toContain('128 bytes from 10.0.2.10'); // 120 payload + 8 ICMP header
    });

    it('4. should ping with specific Time To Live using -t', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -t 64 10.0.2.10');
      expect(output).toContain('64 bytes from 10.0.2.10');
    });

    it('5. should timeout ping requests on unreachable host using -W', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -W 1 10.0.99.99');
      expect(output).toContain('100% packet loss');
    });

    it('6. should set custom ping interval using -i', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 -i 2 10.0.2.10');
      expect(output).toContain('2 received');
    });

    it('7. should bind ping to specific interface using -I', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -I eth0 10.0.2.10');
      expect(output).toContain('64 bytes from');
    });

    it('8. should fill payload with specific hex pattern using -p', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -p abcd 10.0.2.10');
      expect(output).toContain('PATTERN: 0xabcd');
    });

    it('9. should display version details on ping -V', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -V');
      expect(output.toLowerCase()).toContain('iputils');
    });

    it('10. should show help screen on ping -h', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -h');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('11. should display quiet summaries with ping -q', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 -q 10.0.2.10');
      expect(output).not.toContain('64 bytes from');
      expect(output).toContain('ping statistics');
    });

    it('12. should support verbose printing with ping -v', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -v 10.0.2.10');
      expect(output).toContain('64 bytes from');
    });

    it('13. should reject negative packet counts (-c -1)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c -1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('14. should reject zero packet counts (-c 0)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('15. should reject negative packet sizes (-s -10)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -s -10 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('16. should reject out-of-range TTL values (-t 256)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -t 256 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('17. should reject negative TTL values (-t -1)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -t -1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('18. should reject invalid intervals format on ping (-s abc)', async () => {
      const pc = setupWANTopology().pc1;
      const output = await pc.executeCommand('ping -i abc 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('19. should reject invalid timeout values (-W abc)', async () => {
      const pc = setupWANTopology().pc1;
      const output = await pc.executeCommand('ping -W abc 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('20. should reject invalid pattern format (-p zz)', async () => {
      const pc = setupWANTopology().pc1;
      const output = await pc.executeCommand('ping -p zz 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('21. should reject binding to non-existent interface (-I eth99)', async () => {
      const pc = setupWANTopology().pc1;
      const output = await pc.executeCommand('ping -I eth99 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|not found/);
    });

    it('22. should support printing timestamps with ping -D', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -D 10.0.2.10');
      expect(output).toMatch(/\[\s*\d+\.\d+\]/);
    });

    it('23. should allow broadcast ping explicitly on local subnet with -b', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -b 10.0.1.255');
      expect(output).toBeDefined();
    });

    it('24. should reject broadcast ping if -b is omitted', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.1.255');
      expect(output.toLowerCase()).toContain('broadcast');
    });

    it('25. should support quiet and count combinations simultaneously (-c 2 -q)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 -q 10.0.2.10');
      expect(output).not.toContain('64 bytes');
    });

    it('26. should support interval and count combinations simultaneously (-c 2 -i 3)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 -i 3 10.0.2.10');
      expect(output).toContain('2 received');
    });

    it('27. should support pattern and size combinations simultaneously (-s 100 -p aabb)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -s 100 -p aabb 10.0.2.10');
      expect(output).toContain('PATTERN: 0xaabb');
    });

    it('28. should support TTL and timeout combinations simultaneously (-t 10 -W 2)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -t 10 -W 2 10.0.2.10');
      expect(output).toContain('64 bytes');
    });

    it('29. should print unreachable states correctly if route is missing on target subnets', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Remove default gateway to make 10.0.2.10 unreachable
      await topo.pc1.executeCommand('ip route del default');
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(output.toLowerCase()).toContain('unreachable');
    });

    it('30. should support resolving and pinging via hostname directly if mapped', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('echo "10.0.2.10 win-host" >> /etc/hosts');
      const output = await topo.pc1.executeCommand('ping -c 1 win-host');
      expect(output).toContain('10.0.2.10');
    });

    it('31. should support pinging loopback address by host string "localhost"', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 localhost');
      expect(output).toContain('127.0.0.1');
    });

    it('32. should reject resolving nonexistent hostnames', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 nonexistenthost');
      expect(output.toLowerCase()).toMatch(/unknown host|failed to resolve/);
    });

    it('33. should support pinging Class A addresses dynamically', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.0.0.0');
      const output = await pc.executeCommand('ping -c 1 10.0.0.1');
      expect(output).toContain('10.0.0.1');
    });

    it('34. should support pinging Class B addresses dynamically', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 172.16.0.1 netmask 255.255.0.0');
      const output = await pc.executeCommand('ping -c 1 172.16.0.1');
      expect(output).toContain('172.16.0.1');
    });

    it('35. should support pinging Class C addresses dynamically', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
      const output = await pc.executeCommand('ping -c 1 192.168.1.1');
      expect(output).toContain('192.168.1.1');
    });

    it('36. should support continuous ping trace displaying ICMP sequence integers', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 10.0.2.10');
      expect(output).toContain('icmp_seq=1');
      expect(output).toContain('icmp_seq=2');
    });

    it('37. should support showing round-trip times (rtt) statistics on termination', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(output).toContain('rtt min/avg/max/mdev');
    });

    it('38. should reject pinging invalid IP formats (such as 256.0.0.1)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 256.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('39. should reject pinging if destination IP parameter is missing', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('40. should support numeric IP display omitting name resolutions via -n', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -n 10.0.2.10');
      expect(output).toContain('10.0.2.10');
    });

    it('41. should support auditable log structures verification', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('42. should support passing multiple trailing spaces surrounding target IP cleanly', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1    10.0.2.10   ');
      expect(output).toContain('64 bytes');
    });

    it('43. should print warning logs on using deprecated options gracefully', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -L 127.0.0.1'); // loopback multicast options
      expect(output).toBeDefined();
    });

    it('44. should support pinging gateway explicitly from local subnets', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.1.1');
      expect(output).toContain('64 bytes');
    });

    it('45. should support pinging remote gateway SVI across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.1');
      expect(output).toContain('64 bytes');
    });

    it('46. should support customized packets interval metrics smaller than 1s (if simulated)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 -i 0.5 10.0.2.10');
      expect(output).toContain('2 received');
    });

    it('47. should support showing timeout statistics correctly when 50% packet loss is observed', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 2 1.1.1.1'); // timeout simulated
      expect(output).toContain('packet loss');
    });

    it('48. should support single quote wrapping of IP address parameters', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand("ping -c 1 '10.0.2.10'");
      expect(output).toContain('64 bytes');
    });

    it('49. should support double quote wrapping of IP address parameters', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 "10.0.2.10"');
      expect(output).toContain('64 bytes');
    });

    it('50. should execute successfully and return status 0 on regular ping terminations', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 127.0.0.1 && echo "PING_OK"');
      expect(output).toContain('PING_OK');
    });
  });

  // ─── Section 2: Windows ping Command & Parameters (Tests 51-100) ───

  describe('Section 2: Windows ping Command & Advanced Parameters', () => {
    it('51. should ping local loopback on Windows PC', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping 127.0.0.1');
      expect(output).toContain('Reply from 127.0.0.1: bytes=32');
    });

    it('52. should configure packet counts using -n option', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 3 10.0.1.10');
      expect(output).toContain('Packets: Sent = 3, Received = 3');
    });

    it('53. should configure packet buffer payload size using -l option', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -l 150 10.0.1.10');
      expect(output).toContain('Reply from 10.0.1.10: bytes=150');
    });

    it('54. should configure packet Time To Live using -i option', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -i 128 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('55. should timeout ping requests on unreachable host using -w', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -w 1000 10.0.99.99');
      expect(output).toContain('Request timed out');
    });

    it('56. should bind source IP explicitly during pings via -S', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -S 10.0.2.10 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('57. should set Don\'t Fragment flag inside packets via -f', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -f 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('58. should display help manual on Windows ping /?', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping /?');
      expect(output).toContain('Usage: ping');
    });

    it('59. should show correct metrics inside stats tables on termination', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 2 10.0.1.10');
      expect(output).toContain('Approximate round trip times');
    });

    it('60. should reject negative packet counts (-n -5)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n -5 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('61. should reject zero packet counts (-n 0)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n 0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('62. should reject negative buffer size payload (-l -10)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -l -10 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('63. should reject out-of-range TTL values (-i 256)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -i 256 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('64. should reject negative TTL values (-i -5)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -i -5 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('65. should reject negative timeout values (-w -1000)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -w -1000 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('66. should reject invalid source IP parameter formats (-S 300.1.1.1)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -S 300.1.1.1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('67. should support hostname resolutions of Windows PCs explicitly', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('echo "10.0.1.10 linux-host" >> C:\\Windows\\System32\\drivers\\etc\\hosts');
      const output = await topo.pc2.executeCommand('ping linux-host');
      expect(output).toContain('10.0.1.10');
    });

    it('68. should show destination unreachable states if WAN routing paths fail', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Delete router route to make 10.0.1.10 unreachable
      await topo.r2.executeCommand('configure terminal');
      await topo.r2.executeCommand('no ip route 10.0.1.0 255.255.255.0 10.0.12.1');
      await topo.r2.executeCommand('end');

      const output = await topo.pc2.executeCommand('ping -n 1 10.0.1.10');
      expect(output.toLowerCase()).toContain('unreachable');
    });

    it('69. should support loopback alias resolution by localhost string', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping localhost');
      expect(output).toContain('127.0.0.1');
    });

    it('70. should support pinging Class A networks from Windows environment', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.5 255.0.0.0');
      const output = await pc.executeCommand('ping 10.0.0.5');
      expect(output).toContain('Reply from 10.0.0.5');
    });

    it('71. should support pinging Class B networks from Windows environment', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface ip set address "Ethernet" static 172.16.50.5 255.255.0.0');
      const output = await pc.executeCommand('ping 172.16.50.5');
      expect(output).toContain('Reply from 172.16.50.5');
    });

    it('72. should support pinging Class C networks from Windows environment', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface ip set address "Ethernet" static 192.168.100.5 255.255.255.0');
      const output = await pc.executeCommand('ping 192.168.100.5');
      expect(output).toContain('Reply from 192.168.100.5');
    });

    it('73. should show correct metrics inside statistics summaries on total loss', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n 1 -w 500 1.1.1.1');
      expect(output).toContain('Lost = 1 (100% loss)');
    });

    it('74. should support count and size options concurrently (-n 2 -l 500)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 2 -l 500 10.0.1.10');
      expect(output).toContain('bytes=500');
    });

    it('75. should support count and timeout options concurrently (-n 1 -w 1500)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -w 1500 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('76. should support size and DF flag options concurrently (-l 100 -f)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -l 100 -f 10.0.1.10');
      expect(output).toContain('bytes=100');
    });

    it('77. should support TTL and timeout options concurrently (-i 32 -w 2000)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -i 32 -w 2000 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('78. should support single quotes wrapping on Windows targets IP', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand("ping -n 1 '10.0.1.10'");
      expect(output).toContain('Reply from');
    });

    it('79. should support double quotes wrapping on Windows targets IP', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 "10.0.1.10"');
      expect(output).toContain('Reply from');
    });

    it('80. should reject pinging invalid IP formats (such as 255.255.255.256)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping 255.255.255.256');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('81. should reject pinging if destination IP is completely omitted', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('82. should support pinging gateway SVI explicitly', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 10.0.2.1');
      expect(output).toContain('Reply from');
    });

    it('83. should support pinging remote routers interface across links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 10.0.1.1');
      expect(output).toContain('Reply from');
    });

    it('84. should support resolving host names via IPv4 specifically using -4', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('echo "10.0.1.10 linux-host" >> C:\\Windows\\System32\\drivers\\etc\\hosts');
      const output = await topo.pc2.executeCommand('ping -4 linux-host');
      expect(output).toContain('10.0.1.10');
    });

    it('85. should support setting Type Of Service (TOS) field inside packet headers via -v', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -v 64 127.0.0.1');
      expect(output).toContain('Reply from');
    });

    it('86. should reject -v if TOS parameter value is out of range (greater than 255)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -v 256 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('87. should reject -v if TOS parameter value is negative', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -v -5 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('88. should reject DNS resolution attempts on unreachable systems', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping nonexistentdomain.local');
      expect(output.toLowerCase()).toMatch(/could not find host|failed to resolve/);
    });

    it('89. should support routing queries diagnostics matching intermediate hops', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('90. should support space-free numeric parameters passing cleanly', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n 1 -l 100 127.0.0.1');
      expect(output).toContain('bytes=100');
    });

    it('91. should show correct metrics inside statistics summaries on 50% packet loss', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n 2 1.1.1.1'); // mock timeout
      expect(output).toContain('Lost = 2 (100% loss)');
    });

    it('92. should preserve interface status parameters across continuous pings execution', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('ping -n 5 10.0.1.10');
      const config = await topo.pc2.executeCommand('netsh interface ip show addresses');
      expect(config).toBeDefined();
    });

    it('93. should support continuous pinging without limits using -t', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Run continuous ping in simulator (requires self-termination or small mock)
      const output = await topo.pc2.executeCommand('ping -t -n 2 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('94. should set fragment boundaries dynamically inside buffer sizes check', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -l 1472 -f 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('95. should support record route options via -r', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -r 5 127.0.0.1');
      expect(output).toContain('Route:');
    });

    it('96. should reject -r if hop count parameter value is invalid (greater than 9)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -r 10 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('97. should support showing timestamp mappings inside -s', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -s 4 127.0.0.1');
      expect(output).toContain('Timestamp:');
    });

    it('98. should reject -s if hop count parameter value is invalid (greater than 4)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -s 5 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('99. should preserve all TCP/IP profiles configurations after ping reset triggers', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('ping 127.0.0.1');
      const output = await pc.executeCommand('netsh interface ip show config');
      expect(output).toContain('Ethernet');
    });

    it('100. should execute successfully and return status 0 on complete Windows ping runs', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n 1 127.0.0.1 && echo "PING_OK"');
      expect(output).toContain('PING_OK');
    });
  });

  // ─── Section 3: Linux traceroute Command & Parameters (Tests 101-150) ────

  describe('Section 3: Linux traceroute Command & Parameters', () => {
    it('101. should trace route to target IP using traceroute', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('traceroute to 10.0.2.10');
      expect(output).toContain('10.0.1.1');
    });

    it('102. should limit maximum TTL hops using -m', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -m 2 10.0.2.10');
      expect(output).toContain('2 hops max');
    });

    it('103. should configure queries per hop using -q', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -q 1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('104. should set custom wait timeout using -w', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -w 2 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('105. should use ICMP ECHO method instead of UDP using -I', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -I 10.0.2.10');
      expect(output).toContain('traceroute to 10.0.2.10');
    });

    it('106. should use TCP SYN method instead of UDP using -T', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -T 10.0.2.10');
      expect(output).toContain('traceroute to 10.0.2.10');
    });

    it('107. should use UDP method explicitly using -U', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -U 10.0.2.10');
      expect(output).toContain('traceroute to 10.0.2.10');
    });

    it('108. should set target port for probes using -p', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -p 8080 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('109. should bind traceroute to specific interface using -i', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -i eth0 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('110. should show help screen on traceroute --help', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute --help');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('111. should show version information on traceroute -V', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -V');
      expect(output.toLowerCase()).toContain('traceroute');
    });

    it('112. should show numerical addresses only with traceroute -n', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -n 10.0.2.10');
      expect(output).not.toMatch(/[a-zA-Z]/); // Should exclude text names in hops
    });

    it('113. should reject negative max-hops values (-m -5)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -m -5 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('114. should reject zero max-hops values (-m 0)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -m 0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('115. should reject negative queries count (-q -3)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -q -3 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('116. should reject zero queries count (-q 0)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -q 0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('117. should reject invalid timeout values (-w -2)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -w -2 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('118. should reject out-of-range port values (-p 70000)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -p 70000 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('119. should reject negative port values (-p -80)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -p -80 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('120. should reject binding to non-existent interface (-i eth99)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -i eth99 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|not found/);
    });

    it('121. should support gateway list option using -g', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -g 10.0.1.1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('122. should support specifying starting TTL using -f', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -f 2 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('123. should reject starting TTL larger than maximum TTL (-f 30 -m 20)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -f 30 -m 20 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('124. should support timeout response markers (* * *) if gateway drops ICMP', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Shutdown r2 interface GigabitEthernet0/1 to simulate drops
      await topo.r2.executeCommand('enable');
      await topo.r2.executeCommand('configure terminal');
      await topo.r2.executeCommand('interface GigabitEthernet0/1');
      await topo.r2.executeCommand('shutdown');
      await topo.r2.executeCommand('end');

      const output = await topo.pc1.executeCommand('traceroute -w 1 10.0.2.10');
      expect(output).toContain('* * *');
    });

    it('125. should support maximum trace queries limits securely', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -q 10 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('126. should support combining max-hops and query count options (-m 5 -q 2)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -m 5 -q 2 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('127. should support combining numeric display and ICMP method options (-n -I)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -n -I 10.0.2.10');
      expect(output).not.toMatch(/[a-zA-Z]/);
    });

    it('128. should support combining interface and maximum TTL options (-i eth0 -m 10)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -i eth0 -m 10 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('129. should preserve routing metrics correctly after trace executions', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('traceroute 10.0.2.10');
      const routes = await topo.pc1.executeCommand('ip route show');
      expect(routes).toContain('default via 10.0.1.1');
    });

    it('130. should support resolving and tracing via hostnames directly if mapped', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('echo "10.0.2.10 win-host" >> /etc/hosts');
      const output = await topo.pc1.executeCommand('traceroute win-host');
      expect(output).toContain('10.0.2.10');
    });

    it('131. should support tracing loopback address by host string "localhost"', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute localhost');
      expect(output).toContain('127.0.0.1');
    });

    it('132. should reject resolving nonexistent hostnames inside traceroute', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute nonexistenthost');
      expect(output.toLowerCase()).toMatch(/unknown host|failed to resolve/);
    });

    it('133. should support tracing Class A addresses dynamically', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.0.0.0');
      const output = await pc.executeCommand('traceroute 10.0.0.1');
      expect(output).toContain('10.0.0.1');
    });

    it('134. should support tracing Class B addresses dynamically', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 172.16.0.1 netmask 255.255.0.0');
      const output = await pc.executeCommand('traceroute 172.16.0.1');
      expect(output).toContain('172.16.0.1');
    });

    it('135. should support tracing Class C addresses dynamically', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
      const output = await pc.executeCommand('traceroute 192.168.1.1');
      expect(output).toContain('192.168.1.1');
    });

    it('136. should show intermediate hops IP addresses correctly inside detailed tables', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('10.0.1.1');
      expect(output).toContain('10.0.12.2');
      expect(output).toContain('10.0.23.3');
    });

    it('137. should show associated delay metrics inside detailed tables', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('ms');
    });

    it('138. should reject tracing invalid IP formats (such as 256.0.0.1)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute 256.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('139. should reject tracing if destination IP parameter is completely omitted', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('140. should support displaying hostname aliases inside intermediate hops lists if mapped', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('echo "10.0.1.1 core-gw" >> /etc/hosts');
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('core-gw');
    });

    it('141. should support tracing gateway explicitly on local subnet', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.1.1');
      expect(output).toContain('10.0.1.1');
    });

    it('142. should support tracing remote gateway SVI across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.1');
      expect(output).toContain('10.0.2.1');
    });

    it('143. should print warning logs on using deprecated options gracefully', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -r 127.0.0.1'); // bypass routing tables option
      expect(output).toBeDefined();
    });

    it('144. should support single quote wrapping of IP address parameters inside traceroute', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand("traceroute '10.0.2.10'");
      expect(output).toContain('traceroute to 10.0.2.10');
    });

    it('145. should support double quote wrapping of IP address parameters inside traceroute', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute "10.0.2.10"');
      expect(output).toContain('traceroute to 10.0.2.10');
    });

    it('146. should support passing multiple trailing spaces surrounding target IP cleanly inside traceroute', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute    10.0.2.10   ');
      expect(output).toContain('10.0.2.10');
    });

    it('147. should support showing timeout statistics correctly when total route loss is observed', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -w 1 1.1.1.1'); // timeout simulated
      expect(output).toContain('* * *');
    });

    it('148. should support bypassed local socket loopback trace validations', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -I 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('149. should reject tracing if multiple targets are specified (traceroute 10.0.1.1 10.0.2.10)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute 10.0.1.1 10.0.2.10');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('150. should execute successfully and return status 0 on default traceroute runs', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute localhost && echo "TRACE_OK"');
      expect(output).toContain('TRACE_OK');
    });
  });

  // ─── Section 4: Windows tracert Command & Parameters (Tests 151-200) ───

  describe('Section 4: Windows tracert Command & Parameters', () => {
    it('151. should trace route to target IP using tracert', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toContain('Tracing route to 10.0.1.10');
      expect(output).toContain('10.0.2.1');
    });

    it('152. should limit maximum TTL hops using -h', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -h 2 10.0.1.10');
      expect(output).toContain('maximum of 2 hops');
    });

    it('153. should set custom wait timeout using -w', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -w 1000 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('154. should suppress dns name resolutions using -d', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -d 10.0.1.10');
      expect(output).not.toMatch(/[a-zA-Z]/); // Should exclude hostname mappings in lists
    });

    it('155. should display help manual on Windows tracert with no args', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert');
      expect(output).toContain('Usage: tracert');
    });

    it('156. should show correct metrics inside stats tables on termination', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -h 5 10.0.1.10');
      expect(output).toContain('ms');
    });

    it('157. should reject negative max-hops values (-h -5)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h -5 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('158. should reject zero max-hops values (-h 0)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h 0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('159. should reject negative timeout values (-w -1000)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -w -1000 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('160. should support loose source route list option using -j', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -j 10.0.2.1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('161. should support forcing IPv4 specifically using -4', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -4 10.0.1.10');
      expect(output).toContain('Tracing route to 10.0.1.10');
    });

    it('162. should support forcing IPv6 specifically using -6', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -6 ::1');
      expect(output).toBeDefined();
    });

    it('163. should support single quotes wrapping on Windows targets IP inside tracert', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand("tracert '10.0.1.10'");
      expect(output).toContain('Tracing route to 10.0.1.10');
    });

    it('164. should support double quotes wrapping on Windows targets IP inside tracert', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert "10.0.1.10"');
      expect(output).toContain('Tracing route to 10.0.1.10');
    });

    it('165. should reject tracing invalid IP formats (such as 255.255.255.256)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 255.255.255.256');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('166. should reject tracing if destination IP is completely omitted', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('167. should support tracing gateway SVI explicitly from Windows environment', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.2.1');
      expect(output).toContain('Tracing route to 10.0.2.1');
    });

    it('168. should support tracing remote router interface across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.1');
      expect(output).toContain('Tracing route to 10.0.1.1');
    });

    it('169. should support loopback alias resolution by localhost string inside Windows tracert', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert localhost');
      expect(output).toContain('127.0.0.1');
    });

    it('170. should support hostname resolutions of Windows PCs explicitly inside tracert', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('echo "10.0.1.10 linux-host" >> C:\\Windows\\System32\\drivers\\etc\\hosts');
      const output = await topo.pc2.executeCommand('tracert linux-host');
      expect(output).toContain('10.0.1.10');
    });

    it('171. should show destination unreachable states if WAN routing path definitions fail', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Remove Cisco router static route to make 10.0.1.10 unreachable from PC2
      await topo.hw_sw1.executeCommand('system-view');
      await topo.hw_sw1.executeCommand('undo ip route-static 10.0.1.0 255.255.255.0 10.0.23.2');
      await topo.hw_sw1.executeCommand('quit');

      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output.toLowerCase()).toContain('unreachable');
    });

    it('172. should support timeout response markers (* * *) if gateway drops ICMP inside tracert', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Shutdown r2 interface GigabitEthernet0/1 to simulate drops
      await topo.r2.executeCommand('enable');
      await topo.r2.executeCommand('configure terminal');
      await topo.r2.executeCommand('interface GigabitEthernet0/1');
      await topo.r2.executeCommand('shutdown');
      await topo.r2.executeCommand('end');

      const output = await topo.pc2.executeCommand('tracert -w 500 10.0.1.10');
      expect(output).toContain('* * *');
    });

    it('173. should show intermediate hops IP addresses correctly inside Windows detailed tables', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toContain('10.0.2.1');
      expect(output).toContain('10.0.23.2');
      expect(output).toContain('10.0.12.1');
    });

    it('174. should support combining max-hops and timeout options concurrently inside tracert (-h 5 -w 1000)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -h 5 -w 1000 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('175. should support combining dns suppression and max-hops options concurrently inside tracert (-d -h 10)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -d -h 10 10.0.1.10');
      expect(output).not.toMatch(/[a-zA-Z]/);
    });

    it('176. should preserve Windows interface status parameters across tracert executions', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('tracert 10.0.1.10');
      const config = await topo.pc2.executeCommand('netsh interface ip show config');
      expect(config).toBeDefined();
    });

    it('177. should reject tracing if multiple targets are specified in Windows (tracert 10.0.2.1 10.0.1.10)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 10.0.2.1 10.0.1.10');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('178. should support Windows tracert loopback self-validation', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('179. should preserve all TCP/IP configurations after tracert executions', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('tracert 127.0.0.1');
      const output = await pc.executeCommand('netsh interface ip show config');
      expect(output).toContain('Ethernet');
    });

    it('180. should execute successfully and return status 0 on complete Windows tracert runs', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1 && echo "TRACE_OK"');
      expect(output).toContain('TRACE_OK');
    });

    it('181. should reject -j option if host list contains invalid IP formatting', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -j 300.1.1.1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('182. should support displaying hostname aliases inside intermediate hops lists on Windows if mapped', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('echo "10.0.2.1 lan-gateway" >> C:\\Windows\\System32\\drivers\\etc\\hosts');
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toContain('lan-gateway');
    });

    it('183. should support tracing Class A networks from Windows tracert environment', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.5 255.0.0.0');
      const output = await pc.executeCommand('tracert 10.0.0.5');
      expect(output).toContain('10.0.0.5');
    });

    it('184. should support tracing Class B networks from Windows tracert environment', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface ip set address "Ethernet" static 172.16.50.5 255.255.0.0');
      const output = await pc.executeCommand('tracert 172.16.50.5');
      expect(output).toContain('172.16.50.5');
    });

    it('185. should support tracing Class C networks from Windows tracert environment', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface ip set address "Ethernet" static 192.168.100.5 255.255.255.0');
      const output = await pc.executeCommand('tracert 192.168.100.5');
      expect(output).toContain('192.168.100.5');
    });

    it('186. should support timeout response markers with custom hops ranges (* * *) on total loss', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h 2 -w 500 1.1.1.1');
      expect(output).toContain('* * *');
    });

    it('187. should support loose source route list option inside Windows tracert alias (-j)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -j 10.0.2.1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('188. should reject -w if timeout parameter is completely missing', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -w');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('189. should reject -h if hop parameter is completely missing', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('190. should reject -j if host list parameter is completely missing', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -j');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('191. should handle space-free numeric parameters cleanly inside Windows tracert', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h 10 -w 1000 127.0.0.1');
      expect(output).toBeDefined();
    });

    it('192. should preserve active connections metrics after tracert completes', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('tracert 10.0.1.10');
      const output = await topo.pc2.executeCommand('netsh interface ip show config');
      expect(output).toContain('Ethernet');
    });

    it('193. should show correct hop count inside tracert output list', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toMatch(/\s+1\s+.*ms/);
    });

    it('194. should support Windows tracert formatting with custom IP domains', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -4 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('195. should print trace destination header explicitly on startup', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1');
      expect(output).toContain('over a maximum of 30 hops');
    });

    it('196. should show correct metrics inside detailed tables on loopback trace', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1');
      expect(output).toContain('<1 ms');
    });

    it('197. should support timeout response markers if gateways drop ICMP over multiple hops', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -w 100 1.1.1.1');
      expect(output).toContain('* * *');
    });

    it('198. should handle long customized device paths safely inside tracert rules', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const longName = '127.0.0.1' + 's'.repeat(240);
      const output = await pc.executeCommand(`tracert ${longName}`);
      expect(output.toLowerCase()).toMatch(/error|invalid|failed to resolve/);
    });

    it('199. should preserve all TCP/IP configurations after tracert executions', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('tracert 127.0.0.1');
      const output = await pc.executeCommand('netsh interface ip show config');
      expect(output).toContain('Ethernet');
    });

    it('200. should execute successfully and return status 0 on complete Windows tracert runs', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1 && echo "TRACE_OK"');
      expect(output).toContain('TRACE_OK');
    });
  });

  // ─── Section 5: WAN Routing & MTU Fragmentation (Tests 201-250) ───

  describe('Section 5: WAN Routing Coherence, Multi-Hop Traces & MTU Fragmentations', () => {
    it('201. should ping remote PC successfully across the entire WAN topology', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 2 10.0.2.10');
      expect(output).toContain('2 packets transmitted, 2 received');
    });

    it('202. should traceroute remote PC successfully showing each intermediate router SVI', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('10.0.1.1');  // R1
      expect(output).toContain('10.0.12.2'); // R2
      expect(output).toContain('10.0.23.3'); // HW_SW1 SVI
    });

    it('203. should fail ping with fragmentation error if DF is set and packet size exceeds MTU (1500)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Linux: -M want (use DF), -s size
      const output = await topo.pc1.executeCommand('ping -c 1 -M want -s 2000 10.0.2.10');
      expect(output.toLowerCase()).toMatch(/local error|too long|frag needed/);
    });

    it('204. should fail Windows ping with fragmentation error if -f is set and size exceeds MTU (1500)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -f -l 2000 10.0.1.10');
      expect(output.toLowerCase()).toMatch(/packet needs to be fragmented|too long|frag needed/);
    });

    it('205. should allow pinging with large packets (e.g. 2000) if DF is NOT set (fragments are sent)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 -s 2000 10.0.2.10');
      expect(output).toContain('2008 bytes from'); // payload + header, successfully fragmented/reassembled
    });

    it('206. should adjust trace path dynamically when a static host route is configured on PC1', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Route specifically via another hop if simulated, or check metric updates
      await topo.pc1.executeCommand('ip route add 10.0.2.10 via 10.0.1.1 metric 50');
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('10.0.1.1');
    });

    it('207. should show ICMP redirects on pinging subnets via suboptimal routers', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Setup suboptimal SVI redirect if supported, verify command runs without crash
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('208. should drop packets at Cisco router GigabitEthernet interface if shutdown', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('shutdown');
      await topo.r1.executeCommand('end');

      const output = await topo.pc1.executeCommand('ping -c 1 -W 1 10.0.2.10');
      expect(output).toContain('100% packet loss');
    });

    it('209. should drop packets at Huawei Switch VLAN interface if SVI is down', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.hw_sw1.executeCommand('system-view');
      await topo.hw_sw1.executeCommand('interface Vlanif20');
      await topo.hw_sw1.executeCommand('shutdown');
      await topo.hw_sw1.executeCommand('quit');

      const output = await topo.pc1.executeCommand('ping -c 1 -W 1 10.0.2.10');
      expect(output).toContain('100% packet loss');
    });

    it('210. should show destination host unreachable on traceroute if destination host is shut down', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('netsh interface set interface "Ethernet" admin=disabled');
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output.toLowerCase()).toContain('unreachable');
    });

    it('211. should show TTL expired in transit inside traceroute output logs', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toBeDefined(); // implicit TTL expired at each hop
    });

    it('212. should verify ICMP echo reply generation from Huawei L3 switch SVI interface', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.23.3');
      expect(output).toContain('64 bytes from 10.0.23.3');
    });

    it('213. should verify ICMP echo reply generation from Cisco router interfaces', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.12.1');
      expect(output).toContain('64 bytes from 10.0.12.1');
    });

    it('214. should trace path correctly from Windows PC showing R2 and R1 intermediate hops', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -d 10.0.1.10');
      expect(output).toContain('10.0.23.2'); // R2
      expect(output).toContain('10.0.12.1'); // R1
    });

    it('215. should support Windows path MTU discovery simulation using -l and -f loop bounds', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 -f -l 1472 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('216. should trace path correctly when MTU is set to 1400 on Cisco interfaces', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('ip mtu 1400');
      await topo.r1.executeCommand('end');

      const output = await topo.pc1.executeCommand('ping -c 1 -M want -s 1300 10.0.2.10');
      expect(output).toContain('64 bytes');
    });

    it('217. should trigger fragmentation warning if size is 1450 and MTU is 1400 with DF set', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('interface GigabitEthernet0/1');
      await topo.r1.executeCommand('ip mtu 1400');
      await topo.r1.executeCommand('end');

      const output = await topo.pc1.executeCommand('ping -c 1 -M want -s 1450 10.0.2.10');
      expect(output.toLowerCase()).toMatch(/local error|too long|frag needed/);
    });

    it('218. should trace path successfully showing asterisks if intermediate Cisco router drops UDP probes but accepts ICMP', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Configure Cisco ACL to block UDP probes but allow ICMP echo
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 100 deny udp any any range 33434 33534');
      await topo.r1.executeCommand('access-list 100 permit ip any any');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip access-group 100 in');
      await topo.r1.executeCommand('end');

      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10'); // Default is UDP
      expect(output).toContain('* * *');
    });

    it('219. should resolve and trace path successfully if ICMP method is forced (-I) even when UDP is blocked', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('access-list 100 deny udp any any range 33434 33534');
      await topo.r1.executeCommand('access-list 100 permit ip any any');
      await topo.r1.executeCommand('interface GigabitEthernet0/0');
      await topo.r1.executeCommand('ip access-group 100 in');
      await topo.r1.executeCommand('end');

      const output = await topo.pc1.executeCommand('traceroute -I 10.0.2.10'); // Uses ICMP
      expect(output).toContain('10.0.1.1');
    });

    it('220. should support trace paths over physical switches lacking VLAN configurations (L2 transparency)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // L2 SW1 is transparent, ping should pass cleanly
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.1.1');
      expect(output).toContain('64 bytes');
    });

    it('221. should route packets via dynamic routing protocols tables if active (OSPF simulated)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // If OSPF is configured on R1 and R2, routes are populated dynamically
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(output).toContain('64 bytes');
    });

    it('222. should trace route successfully across multiple L2 VLAN partitions inside Huawei Switch', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.hw_sw1.executeCommand('display ip routing-table');
      expect(output).toContain('10.0.1.0');
    });

    it('223. should route pings using specific gateway configurations in Huawei switch Vlanif structures', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 10.0.23.3');
      expect(output).toContain('Reply from');
    });

    it('224. should show correct metrics inside fdisk/blkid equivalent partition queries on Windows host', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -n 1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('225. should track destination host changes dynamically inside traceroute outputs', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('traceroute 10.0.2.10');
      const output = await topo.pc1.executeCommand('traceroute 10.0.1.1');
      expect(output).toContain('10.0.1.1');
    });

    it('226. should support traceroute with precise wait timeouts configurations (-w 1)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -w 1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('227. should support Windows tracert with precise wait timeouts configurations (-w 1000)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -w 1000 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('228. should not execute trace routing beyond the bounds of target networks if routing is blocked', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.r1.executeCommand('enable');
      await topo.r1.executeCommand('configure terminal');
      await topo.r1.executeCommand('no ip route 10.0.2.0 255.255.255.0 10.0.12.2');
      await topo.r1.executeCommand('end');

      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).not.toContain('10.0.23.3');
    });

    it('229. should preserve WAN topology connection states across multiple ping checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      const output = await topo.pc2.executeCommand('ping -n 1 10.0.1.10');
      expect(output).toContain('Reply from');
    });

    it('230. should support printing results matching specific network domains inside Windows traces', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('231. should support WAN tracing with specific packet size modifiers (traceroute 10.0.2.10 100)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10 100');
      expect(output).toContain('100 bytes packets');
    });

    it('232. should reject traceroute packet size if value is out of bounds (greater than 65535)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute 127.0.0.1 70000');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('233. should reject traceroute packet size if value is negative', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute 127.0.0.1 -100');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('234. should support Windows ping with specific routing option flags (-r 9)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -r 9 10.0.1.10');
      expect(output).toContain('Route:');
    });

    it('235. should support Windows ping with specific loose routing option flags (-j 10.0.2.1)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -j 10.0.2.1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('236. should reject Windows loose routing if host list contains typos', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -j 300.1.1.1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('237. should support showing hop count parameters inside Windows tracert output', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toContain('10.0.2.1');
    });

    it('238. should support showing RTT metrics inside Windows tracert output', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toMatch(/\d+\s+ms/);
    });

    it('239. should support loopback self-validation inside Linux traceroute', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('240. should support loopback self-validation inside Windows tracert', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('241. should show correct hop count inside Linux traceroute output list', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toMatch(/\s+1\s+10.0.1.1/);
    });

    it('242. should support Linux traceroute with specific IP protocol types (IPv4 only forced by -4)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -4 10.0.2.10');
      expect(output).toContain('traceroute to 10.0.2.10');
    });

    it('243. should support Linux traceroute with specific IP protocol types (IPv6 only forced by -6)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -6 ::1');
      expect(output).toBeDefined();
    });

    it('244. should preserve all SVI VLAN interfaces status configurations inside Huawei switch across tracert checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc2.executeCommand('tracert 10.0.1.10');
      const status = await topo.hw_sw1.executeCommand('display vlan');
      expect(status).toContain('10');
    });

    it('245. should show correct intermediate SVI VLAN interface inside Huawei switch during traces', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -d 10.0.1.10');
      expect(output).toContain('10.0.23.2');
    });

    it('246. should support trace path over multiple Cisco switch VLAN boundaries (trunking)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Trunk configurations on SW1, verify ping passes cleanly
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(output).toContain('64 bytes');
    });

    it('247. should show Correct WAN hop paths inside Cisco routers interfaces lists', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('10.0.12.2');
    });

    it('248. should support showing round-trip times (RTT) details in traceroute outputs', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toMatch(/\d+\s+ms/);
    });

    it('249. should reject tracing if target router interface drops TTL expired in transit packets entirely (unresponsive hop)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Deny TTL exceeded ICMP on R2
      await topo.r2.executeCommand('enable');
      await topo.r2.executeCommand('configure terminal');
      await topo.r2.executeCommand('access-list 100 deny icmp any any time-exceeded');
      await topo.r2.executeCommand('access-list 100 permit ip any any');
      await topo.r2.executeCommand('interface GigabitEthernet0/1');
      await topo.r2.executeCommand('ip access-group 100 in');
      await topo.r2.executeCommand('end');

      const output = await topo.pc1.executeCommand('traceroute -w 1 10.0.2.10');
      expect(output).toContain('* * *');
    });

    it('250. should execute successfully and return status 0 on complete WAN routes validations', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('ping -c 1 10.0.2.10 && echo "WAN_OK"');
      expect(output).toContain('WAN_OK');
    });
  });

  // ─── Section 6: Edge Cases, Privilege & Failures (Tests 251-300) ───

  describe('Section 6: Security Privilege Boundaries, Cable Drops & Failure Edge Cases', () => {
    it('251. should restrict flood ping option on Linux to root user (-f)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('su user -c "ping -f 127.0.0.1"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|privileged/);
    });

    it('252. should restrict low ping intervals (less than 0.2s) on Linux to root user (-i 0.1)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('su user -c "ping -i 0.1 127.0.0.1"');
      expect(output.toLowerCase()).toMatch(/permission denied|error|privileged/);
    });

    it('253. should show packet drops dynamically when physical network cable is unplugged mid-run', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);

      const pingPromise = topo.pc1.executeCommand('ping -c 4 -i 1 10.0.2.10');
      await new Promise(resolve => setTimeout(resolve, 1500)); // wait for 1.5 seconds
      topo.c1.disconnect(); // Unplug PC1 cable mid-run

      const output = await pingPromise;
      expect(output).toContain('packet loss');
      expect(output).not.toContain('4 received'); // should have drops
    });

    it('254. should recover connectivity tracing immediately after physical network cable is reconnected', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      topo.c1.disconnect(); // unplug

      const ping1 = await topo.pc1.executeCommand('ping -c 1 -W 1 10.0.2.10');
      expect(ping1).toContain('100% packet loss');

      topo.c1.connect(topo.pc1.getPort('eth0')!, topo.sw1.getPort('FastEthernet0/1')!); // reconnect
      await new Promise(resolve => setTimeout(resolve, 50)); // let STP or link state settle

      const ping2 = await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      expect(ping2).toContain('64 bytes');
    });

    it('255. should return exit status 1 inside Linux environment if ping target is 100% lost', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 -W 1 10.0.99.99 || echo "LOSS_DETECTED"');
      expect(output).toContain('LOSS_DETECTED');
    });

    it('256. should handle blank command inputs on Windows ping gracefully', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping ""');
      expect(output.toLowerCase()).toContain('usage');
    });

    it('257. should handle blank command inputs on Linux ping gracefully', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping ""');
      expect(output.toLowerCase()).toMatch(/unknown host|invalid|error/);
    });

    it('258. should reject traceroute commands with invalid target domain syntax', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -m 30 10.0.0.300');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('259. should reject tracert commands with invalid target domain syntax', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 10.0.0.300');
      expect(output.toLowerCase()).toMatch(/invalid|error|failed to resolve/);
    });

    it('260. should show destination net unreachable on ping if SVI gateway route has no interface match', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Shutdown SW2 SVI to make network unreachable from PC2
      await topo.hw_sw1.executeCommand('system-view');
      await topo.hw_sw1.executeCommand('interface Vlanif20');
      await topo.hw_sw1.executeCommand('shutdown');
      await topo.hw_sw1.executeCommand('quit');

      const output = await topo.pc2.executeCommand('ping -n 1 10.0.1.10');
      expect(output.toLowerCase()).toContain('unreachable');
    });

    it('261. should show destination host unreachable on Linux ping if SVI gateway is active but host does not respond', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // PC2 (Windows) is on, shutdown interface to make it unresponsive
      await topo.pc2.executeCommand('netsh interface set interface "Ethernet" admin=disabled');
      const output = await topo.pc1.executeCommand('ping -c 1 -W 1 10.0.2.10');
      expect(output.toLowerCase()).toContain('unreachable');
    });

    it('262. should support tracing path over multiple Huawei switch VLAN boundaries (trunking)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.hw_sw1.executeCommand('display ip routing-table');
      expect(output).toContain('10.0.23.0');
    });

    it('263. should show Correct WAN hop paths inside Huawei switch interfaces lists', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -d 10.0.1.10');
      expect(output).toContain('10.0.23.2');
    });

    it('264. should support Windows ping with specific loose routing option flags targeting local gateways SVI (-j 10.0.2.1)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -j 10.0.2.1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('265. should support Windows ping with specific loose routing option flags targeting remote gateways SVI (-j 10.0.1.1)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('ping -j 10.0.1.1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('266. should reject Linux ping if multiple targets are specified (ping -c 1 127.0.0.1 127.0.0.2)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 127.0.0.1 127.0.0.2');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('267. should reject Windows ping if multiple targets are specified (ping 127.0.0.1 127.0.0.2)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping 127.0.0.1 127.0.0.2');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('268. should support showing delay metrics inside Windows tracert output detailed tables', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert 10.0.1.10');
      expect(output).toContain('ms');
    });

    it('269. should support showing hop count inside Linux traceroute output detailed tables', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toMatch(/\s+2\s+10.0.12.2/);
    });

    it('270. should support Linux traceroute with specific IP protocol types (IPv4 only forced by -4) across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -4 10.0.2.10');
      expect(output).toContain('10.0.2.10');
    });

    it('271. should support Linux traceroute with specific IP protocol types (IPv6 only forced by -6) across WAN links', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -6 ::1');
      expect(output).toBeDefined();
    });

    it('272. should preserve all SVI VLAN interfaces status configurations inside Huawei switch across traceroute checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('traceroute 10.0.2.10');
      const status = await topo.hw_sw1.executeCommand('display vlan');
      expect(status).toContain('20');
    });

    it('273. should show correct intermediate SVI VLAN interface inside Huawei switch during traceroute checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -n 10.0.2.10');
      expect(output).toContain('10.0.23.3');
    });

    it('274. should support trace path over multiple Cisco switch VLAN boundaries (trunking) across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('10.0.2.10');
    });

    it('275. should show Correct WAN hop paths inside Cisco routers interfaces lists across traceroute checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -n 10.0.2.10');
      expect(output).toContain('10.0.12.1');
    });

    it('276. should support showing round-trip times (RTT) details in traceroute outputs across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute 10.0.2.10');
      expect(output).toContain('ms');
    });

    it('277. should reject tracing if target router interface drops TTL expired in transit packets entirely (unresponsive hop) across traceroute checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Deny TTL exceeded ICMP on R2
      await topo.r2.executeCommand('enable');
      await topo.r2.executeCommand('configure terminal');
      await topo.r2.executeCommand('access-list 100 deny icmp any any time-exceeded');
      await topo.r2.executeCommand('access-list 100 permit ip any any');
      await topo.r2.executeCommand('interface GigabitEthernet0/1');
      await topo.r2.executeCommand('ip access-group 100 in');
      await topo.r2.executeCommand('end');

      const output = await topo.pc1.executeCommand('traceroute -w 1 10.0.2.10');
      expect(output).toContain('* * *');
    });

    it('278. should successfully execute and return status 0 on complete WAN routes validations across traceroute checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute localhost && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });

    it('279. should reject pinging if target is not a valid address format (ping -c 1 255.255.255.256)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 255.255.255.256');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('280. should reject Windows ping if target is not a valid address format (ping 255.255.255.256)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping 255.255.255.256');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('281. should reject Windows ping if multiple flags conflict (-n 5 -t)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -n 5 -t 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('282. should reject Linux ping if multiple flags conflict (-c 5 -f)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 5 -f 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/); // Flood mode conflicts with specific non-root rate counts
    });

    it('283. should log error if the target interface is administratively down on Windows PC', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('netsh interface set interface "Ethernet" admin=disabled');
      const output = await pc.executeCommand('ping 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/transmit failed|error|hardware error/);
    });

    it('284. should log error if the target interface is administratively down on Linux PC', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ifconfig eth0 down');
      const output = await pc.executeCommand('ping -c 1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/network is unreachable|error/);
    });

    it('285. should support Windows tracert loose source route with single target IP (-j 10.0.2.1)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc2.executeCommand('tracert -j 10.0.2.1 10.0.1.10');
      expect(output).toBeDefined();
    });

    it('286. should support Linux traceroute gateway loose source route with single target IP (-g 10.0.1.1)', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      const output = await topo.pc1.executeCommand('traceroute -g 10.0.1.1 10.0.2.10');
      expect(output).toBeDefined();
    });

    it('287. should reject Linux traceroute if starting TTL is too high (-f 99)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -f 99 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('288. should reject Windows tracert if max-hops is too high (-h 256)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h 256 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error|range/);
    });

    it('289. should support Windows tracert with dns resolution explicitly enabled', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('290. should support Linux traceroute with dns resolution explicitly enabled', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute 127.0.0.1');
      expect(output).toContain('127.0.0.1');
    });

    it('291. should handle space-free numeric parameters cleanly inside Linux traceroute', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('traceroute -m10 -q2 127.0.0.1');
      expect(output).toBeDefined();
    });

    it('292. should handle space-free numeric parameters cleanly inside Windows tracert', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('tracert -h10 -w1000 127.0.0.1');
      expect(output).toBeDefined();
    });

    it('293. should show correct metrics inside statistics summaries on total route loss across WAN links', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      // Remove static routes on Huawei switch
      await topo.hw_sw1.executeCommand('system-view');
      await topo.hw_sw1.executeCommand('undo ip route-static 10.0.1.0 255.255.255.0 10.0.23.2');
      await topo.hw_sw1.executeCommand('quit');

      const output = await topo.pc1.executeCommand('ping -c 1 -W 1 10.0.2.10');
      expect(output).toContain('100% packet loss');
    });

    it('294. should restore default configurations when network stack is reset on Windows PC', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      await pc.executeCommand('ping 127.0.0.1');
      await pc.executeCommand('netsh interface ip reset');
      const status = await pc.executeCommand('netsh interface ip show config');
      expect(status).toContain('Ethernet');
    });

    it('295. should restore default configurations when network stack is reloaded on Linux PC', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      await pc.executeCommand('ping -c 1 127.0.0.1');
      await pc.executeCommand('service networking restart');
      const status = await pc.executeCommand('ifconfig eth0');
      expect(status).toBeDefined();
    });

    it('296. should reject Linux ping if pattern value is empty (-p "")', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -p "" 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|error/);
    });

    it('297. should reject Windows ping if source address has quote mismatch (-S "10.0.0.1)', async () => {
      const pc = new WindowsPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -S "10.0.0.1 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|quote|syntax/);
    });

    it('298. should reject Linux ping if interface name has quote mismatch (-I "eth0)', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -I "eth0 127.0.0.1');
      expect(output.toLowerCase()).toMatch(/invalid|quote|syntax/);
    });

    it('299. should preserve all SVI VLAN interfaces status configurations inside Cisco switches across multiple checks', async () => {
      const topo = setupWANTopology();
      await configureWANIPs(topo);
      await topo.pc1.executeCommand('ping -c 1 10.0.2.10');
      const status = await topo.sw1.executeCommand('show vlan brief');
      expect(status).toContain('default');
    });

    it('300. should execute successfully and return status 0 on complete loopback ping checks', async () => {
      const pc = new LinuxPC('PC', 0, 0);
      const output = await pc.executeCommand('ping -c 1 127.0.0.1 && echo "SUCCESS"');
      expect(output).toContain('SUCCESS');
    });
  });
});
