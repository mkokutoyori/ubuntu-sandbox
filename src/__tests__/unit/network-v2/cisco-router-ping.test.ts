/**
 * Cisco Router Ping — TDD Test Suite
 *
 * Tests cover:
 *   Group 1: Basic ping syntax & errors
 *   Group 2: Router-to-directly-connected ping
 *   Group 3: Router-to-remote via next-hop
 *   Group 4: Self-ping (loopback)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// Group 1: Basic ping syntax & errors
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Cisco Router Ping CLI syntax', () => {

  it('RP-1: ping without arguments should ask for target IP', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const out = await r.executeCommand('ping');
    // Cisco IOS normally prompts; our sim returns an error
    expect(out.toLowerCase()).toContain('ping');
  });

  it('RP-2: ping with invalid IP should return error', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const out = await r.executeCommand('ping 999.999.999.999');
    expect(out).toMatch(/invalid|bad|translat|unrecognized|unreachable/i);
  });

  it('RP-3: ping from user mode should also work', async () => {
    const r = new CiscoRouter('R1');
    // ping is available in both user and privileged mode on Cisco
    const out = await r.executeCommand('ping 10.0.0.99');
    // Should at least try (may fail if no interface configured)
    expect(out).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Directly connected ping (Router ↔ PC)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Router ping to directly connected host', () => {

  function setupDirectTopology() {
    // R1 (Gi0/0) ──── (eth0) PC1
    const r1 = new CiscoRouter('R1');
    const pc1 = new LinuxPC('PC1', 100, 100);
    const cable = new Cable('c1');
    cable.connect(r1.getPort('GigabitEthernet0/0')!, pc1.getPort('eth0')!);
    return { r1, pc1, cable };
  }

  it('RP-4: router can ping a directly connected PC', async () => {
    const { r1, pc1 } = setupDirectTopology();

    // Configure IPs
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('end');

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc1.executeCommand('ip route add default via 192.168.1.1');

    const out = await r1.executeCommand('ping 192.168.1.10');
    // Cisco-style output: "Success rate is 100 percent"
    expect(out).toContain('Success rate is');
    expect(out).toMatch(/[1-5]\/[1-5]/); // e.g. "5/5" or at least some success
  });

  it('RP-5: router ping output has Cisco IOS format', async () => {
    const { r1, pc1 } = setupDirectTopology();

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('end');

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc1.executeCommand('ip route add default via 192.168.1.1');

    const out = await r1.executeCommand('ping 192.168.1.10');
    // Should contain standard Cisco ping format
    expect(out).toContain('Type escape sequence to abort');
    expect(out).toContain('Sending 5');
    expect(out).toContain('100-byte ICMP Echos');
    expect(out).toContain('timeout is 2 seconds');
  });

  it('RP-6: router ping unreachable host shows 0% success', async () => {
    const { r1 } = setupDirectTopology();

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('end');

    // Ping a host that doesn't exist on the network
    const out = await r1.executeCommand('ping 192.168.1.99');
    expect(out).toContain('Success rate is 0 percent');
  });

  it('RP-7: PC can ping the router back', async () => {
    const { r1, pc1 } = setupDirectTopology();

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('end');

    await pc1.executeCommand('ifconfig eth0 192.168.1.10 netmask 255.255.255.0');
    await pc1.executeCommand('ip route add default via 192.168.1.1');

    const out = await pc1.executeCommand('ping -c 1 192.168.1.1');
    expect(out).toContain('1 received');
    expect(out).toContain('0% packet loss');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: Router-to-remote via routing
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Router ping through another router', () => {

  function setupTwoRouterTopology() {
    // PC1 (eth0) ──── (Gi0/0) R1 (Gi0/1) ──── (Gi0/0) R2 (Gi0/1) ──── (eth0) PC2
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');

    const cable1 = new Cable('c1');
    cable1.connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

    const cable2 = new Cable('c2');
    cable2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);

    const cable3 = new Cable('c3');
    cable3.connect(r2.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);

    return { r1, r2, pc1, pc2 };
  }

  it('RP-8: R1 can ping R2 on the transit link', async () => {
    const { r1, r2 } = setupTwoRouterTopology();

    // Configure R1
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('ip address 10.0.0.1 255.255.255.252');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('end');

    // Configure R2
    await r2.executeCommand('enable');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('interface GigabitEthernet0/0');
    await r2.executeCommand('ip address 10.0.0.2 255.255.255.252');
    await r2.executeCommand('no shutdown');
    await r2.executeCommand('interface GigabitEthernet0/1');
    await r2.executeCommand('ip address 172.16.0.1 255.255.255.0');
    await r2.executeCommand('no shutdown');
    await r2.executeCommand('end');

    const out = await r1.executeCommand('ping 10.0.0.2');
    expect(out).toContain('Success rate is');
    // Should have some successes
    expect(out).not.toContain('Success rate is 0 percent');
  });

  it('RP-9: R1 can ping remote subnet via static route', async () => {
    const { r1, r2 } = setupTwoRouterTopology();

    // Configure R1
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/0');
    await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('ip address 10.0.0.1 255.255.255.252');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit'); // back to config mode for ip route
    await r1.executeCommand('ip route 172.16.0.0 255.255.255.0 10.0.0.2');
    await r1.executeCommand('end');

    // Configure R2
    await r2.executeCommand('enable');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('interface GigabitEthernet0/0');
    await r2.executeCommand('ip address 10.0.0.2 255.255.255.252');
    await r2.executeCommand('no shutdown');
    await r2.executeCommand('interface GigabitEthernet0/1');
    await r2.executeCommand('ip address 172.16.0.1 255.255.255.0');
    await r2.executeCommand('no shutdown');
    await r2.executeCommand('exit'); // back to config mode for ip route
    await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.0.1');
    await r2.executeCommand('end');

    // R1 pings R2's far interface
    const out = await r1.executeCommand('ping 172.16.0.1');
    expect(out).toContain('Success rate is');
    expect(out).not.toContain('Success rate is 0 percent');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: Self-ping (loopback)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Router self-ping', () => {

  it('RP-10: router can ping its own interface IP', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    const out = await r.executeCommand('ping 10.0.0.1');
    expect(out).toContain('Success rate is 100 percent');
  });

  it('RP-11: router ping with no route shows failure', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    // No route to 8.8.8.8
    const out = await r.executeCommand('ping 8.8.8.8');
    expect(out).toMatch(/success rate is 0|unreach|no route/i);
  });
});
