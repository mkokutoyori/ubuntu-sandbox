/**
 * TDD Tests for Huawei VRP Router — Feature Parity with Cisco IOS
 *
 * Batch 1: Core CLI features missing from Huawei that Cisco already has.
 *   - Interface description
 *   - Loopback interfaces
 *   - display current-configuration interface <name>
 *   - Ping with source IP option (-a)
 *   - ARP clear (reset arp)
 *   - Counters reset
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask,
  resetCounters,
} from '@/network/core/types';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 1: Interface Description
// ═══════════════════════════════════════════════════════════════════

describe('Batch 1: Interface Description', () => {

  it('should set description on a router interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('description Link-to-LAN');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display interface GE0/0/0');
    expect(output).toContain('Description: Link-to-LAN');
  });

  it('should remove description with undo description', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('description Old-Link');
    await r.executeCommand('undo description');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display interface GE0/0/0');
    expect(output).not.toContain('Old-Link');
  });

  it('should show description in display current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('description WAN-Uplink');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display current-configuration');
    expect(output).toContain('description WAN-Uplink');
  });

  it('should support multi-word description', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/1');
    await r.executeCommand('description Link to Building 3 Floor 2');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display interface GE0/0/1');
    expect(output).toContain('Description: Link to Building 3 Floor 2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 2: Loopback Interfaces
// ═══════════════════════════════════════════════════════════════════

describe('Batch 2: Loopback Interfaces', () => {

  it('should create a loopback interface via system-view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface LoopBack0');
    const prompt = r.getPrompt();
    expect(prompt).toContain('LoopBack0');
  });

  it('should configure IP on loopback interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface LoopBack0');
    await r.executeCommand('ip address 1.1.1.1 255.255.255.255');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display ip interface brief');
    expect(output).toContain('LoopBack0');
    expect(output).toContain('1.1.1.1');
  });

  it('should show loopback in display current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface LoopBack0');
    await r.executeCommand('ip address 1.1.1.1 255.255.255.255');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display current-configuration');
    expect(output).toContain('interface LoopBack0');
    expect(output).toContain('1.1.1.1');
  });

  it('should add connected route for loopback', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface LoopBack0');
    await r.executeCommand('ip address 10.255.0.1 255.255.255.255');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display ip routing-table');
    expect(output).toContain('10.255.0.1');
    expect(output).toContain('Direct');
  });

  it('should support multiple loopback interfaces', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface LoopBack0');
    await r.executeCommand('ip address 1.1.1.1 255.255.255.255');
    await r.executeCommand('quit');
    await r.executeCommand('interface LoopBack1');
    await r.executeCommand('ip address 2.2.2.2 255.255.255.255');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display ip interface brief');
    expect(output).toContain('LoopBack0');
    expect(output).toContain('1.1.1.1');
    expect(output).toContain('LoopBack1');
    expect(output).toContain('2.2.2.2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 3: display current-configuration interface <name>
// ═══════════════════════════════════════════════════════════════════

describe('Batch 3: display current-configuration interface', () => {

  it('should display per-interface configuration', async () => {
    const r = new HuaweiRouter('R1');
    r.configureInterface('GE0/0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    const output = await r.executeCommand('display current-configuration interface GE0/0/0');
    expect(output).toContain('interface GE0/0/0');
    expect(output).toContain('192.168.1.1');
    expect(output).toContain('255.255.255.0');
  });

  it('should show unconfigured interface', async () => {
    const r = new HuaweiRouter('R1');
    const output = await r.executeCommand('display current-configuration interface GE0/0/1');
    expect(output).toContain('interface GE0/0/1');
    expect(output).toContain('shutdown');
  });

  it('should show description in per-interface config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('description Core-Link');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display current-configuration interface GE0/0/0');
    expect(output).toContain('description Core-Link');
    expect(output).toContain('10.0.0.1');
  });

  it('should error for non-existent interface', async () => {
    const r = new HuaweiRouter('R1');
    const output = await r.executeCommand('display current-configuration interface GE9/9/9');
    expect(output).toContain('Error');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 4: Ping Source Option
// ═══════════════════════════════════════════════════════════════════

describe('Batch 4: Ping with Source IP', () => {

  it('should accept -a source-ip option', async () => {
    const r = new HuaweiRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC1');

    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('10.0.1.1'));

    const c = new Cable('c1');
    c.connect(r.getPort('GE0/0/0')!, pc.getPort('eth0')!);

    const output = await r.executeCommand('ping -a 10.0.2.1 10.0.1.2');
    expect(output).toContain('PING 10.0.1.2');
    expect(output).not.toContain('Error');
  });

  it('should use -c to set ping count', async () => {
    const r = new HuaweiRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC1');

    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));

    const c = new Cable('c1');
    c.connect(r.getPort('GE0/0/0')!, pc.getPort('eth0')!);

    const output = await r.executeCommand('ping -c 3 10.0.1.2');
    expect(output).toContain('3 packet(s) transmitted');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 5: ARP Clear / Reset
// ═══════════════════════════════════════════════════════════════════

describe('Batch 5: ARP Clear (reset arp)', () => {

  it('should clear dynamic ARP entries with reset arp', async () => {
    const r = new HuaweiRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC1');

    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));

    const c = new Cable('c1');
    c.connect(r.getPort('GE0/0/0')!, pc.getPort('eth0')!);

    // Trigger ARP learning via ping
    await r.executeCommand('ping 10.0.1.2');

    // Verify ARP entry exists
    let arp = await r.executeCommand('display arp');
    expect(arp).toContain('10.0.1.2');

    // Clear ARP
    await r.executeCommand('reset arp');

    // ARP table should be empty (or only static entries remain)
    arp = await r.executeCommand('display arp');
    expect(arp).not.toContain('10.0.1.2');
  });

  it('should preserve static ARP entries on reset', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('arp static 192.168.1.50 aaaa-bbbb-cccc');
    await r.executeCommand('return');

    await r.executeCommand('reset arp');

    const arp = await r.executeCommand('display arp');
    expect(arp).toContain('192.168.1.50');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 6: Counters Reset
// ═══════════════════════════════════════════════════════════════════

describe('Batch 6: Counters Reset', () => {

  it('should reset IP traffic counters', async () => {
    const r = new HuaweiRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC1');
    const pc2 = new LinuxPC('linux-pc', 'PC2');

    r.configureInterface('GE0/0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
    r.configureInterface('GE0/0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    pc2.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('10.0.1.1'));
    pc2.setDefaultGateway(new IPAddress('10.0.2.1'));

    const c1 = new Cable('c1');
    c1.connect(r.getPort('GE0/0/0')!, pc.getPort('eth0')!);
    const c2 = new Cable('c2');
    c2.connect(r.getPort('GE0/0/1')!, pc2.getPort('eth0')!);

    // Generate some traffic
    await pc.executeCommand('ping -c 1 10.0.2.2');

    // Verify counters non-zero
    let traffic = await r.executeCommand('display ip traffic');
    const counters = r.getCounters();
    expect(counters.ipForwDatagrams + counters.icmpOutMsgs + counters.ifInOctets).toBeGreaterThan(0);

    // Reset
    await r.executeCommand('reset counters');

    // Counters should be zero
    const resetCountersResult = r.getCounters();
    expect(resetCountersResult.ipForwDatagrams).toBe(0);
    expect(resetCountersResult.icmpOutMsgs).toBe(0);
    expect(resetCountersResult.ifInOctets).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 7: IPv6 Support
// ═══════════════════════════════════════════════════════════════════

describe('Batch 7: IPv6 Support', () => {

  it('should enable IPv6 routing with ipv6 in system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipv6');

    expect(r.isIPv6RoutingEnabled()).toBe(true);
  });

  it('should configure IPv6 address on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipv6');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ipv6 enable');
    await r.executeCommand('ipv6 address 2001:db8::1/64');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const port = r.getPort('GE0/0/0');
    expect(port).toBeDefined();
    const ipv6Addrs = port!.getIPv6Addresses();
    expect(ipv6Addrs.length).toBeGreaterThan(0);
  });

  it('should configure IPv6 static route', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipv6');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ipv6 enable');
    await r.executeCommand('ipv6 address 2001:db8:1::1/64');
    await r.executeCommand('quit');
    await r.executeCommand('ipv6 route-static 2001:db8:2:: 64 2001:db8:1::2');
    await r.executeCommand('return');

    const table = r.getIPv6RoutingTable();
    expect(table.length).toBeGreaterThan(0);
  });

  it('should disable IPv6 with undo ipv6', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipv6');
    expect(r.isIPv6RoutingEnabled()).toBe(true);

    await r.executeCommand('undo ipv6');
    expect(r.isIPv6RoutingEnabled()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 8: DHCP Enhancements
// ═══════════════════════════════════════════════════════════════════

describe('Batch 8: DHCP Enhancements', () => {

  it('should configure excluded IP addresses in DHCP pool', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool pool1');
    await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    await r.executeCommand('gateway-list 192.168.1.1');
    await r.executeCommand('excluded-ip-address 192.168.1.1 192.168.1.10');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const dhcp = r.getDHCPServer();
    const excluded = dhcp.getExcludedRanges();
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.some(e => e.start === '192.168.1.1')).toBe(true);
  });

  it('should configure DHCP relay (dhcp relay server-ip)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('dhcp select relay');
    await r.executeCommand('dhcp relay server-ip 10.0.0.100');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const dhcp = r.getDHCPServer();
    const helpers = dhcp.getHelperAddresses('GE0/0/0');
    expect(helpers).toContain('10.0.0.100');
  });

  it('should display DHCP excluded ranges in pool info', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool pool1');
    await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    await r.executeCommand('excluded-ip-address 192.168.1.1 192.168.1.5');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display ip pool name pool1');
    expect(output).toContain('pool1');
    expect(output).toContain('192.168.1.0');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 9: ACL (Access Control Lists) — Huawei style
// ═══════════════════════════════════════════════════════════════════

describe('Batch 9: ACL (Access Control Lists)', () => {

  it('should create a basic ACL and add rules', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    const prompt = r.getPrompt();
    expect(prompt).toContain('acl-basic-2000');

    await r.executeCommand('rule permit source 192.168.1.0 0.0.0.255');
    await r.executeCommand('rule deny');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display acl 2000');
    expect(output).toContain('2000');
    expect(output).toContain('permit');
    expect(output).toContain('deny');
  });

  it('should create an advanced ACL (3000 range)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 3000');
    const prompt = r.getPrompt();
    expect(prompt).toContain('acl-adv-3000');

    await r.executeCommand('rule permit ip source 10.0.0.0 0.0.0.255 destination 192.168.1.0 0.0.0.255');
    await r.executeCommand('rule deny ip');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display acl 3000');
    expect(output).toContain('3000');
    expect(output).toContain('permit');
  });

  it('should apply ACL to interface with traffic-filter', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');

    // Create ACL
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('rule deny');
    await r.executeCommand('quit');

    // Apply to interface
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('traffic-filter inbound acl 2000');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    // Verify binding
    const binding = r.getInterfaceACL('GE0/0/0', 'in');
    expect(binding).toBe(2000);
  });

  it('should remove ACL from interface with undo traffic-filter', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source any');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('traffic-filter inbound acl 2000');
    await r.executeCommand('undo traffic-filter inbound');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const binding = r.getInterfaceACL('GE0/0/0', 'in');
    expect(binding).toBeNull();
  });

  it('should delete ACL with undo acl', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source any');
    await r.executeCommand('quit');

    await r.executeCommand('undo acl 2000');
    await r.executeCommand('return');

    const output = await r.executeCommand('display acl 2000');
    expect(output).toContain('not exist');
  });

  it('should show ACL in display current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display current-configuration');
    expect(output).toContain('acl number 2000');
    expect(output).toContain('permit');
  });

  it('should show ACL interface binding in display current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source any');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('traffic-filter inbound acl 2000');
    await r.executeCommand('quit');
    await r.executeCommand('return');

    const output = await r.executeCommand('display current-configuration');
    expect(output).toContain('traffic-filter inbound acl 2000');
  });
});
