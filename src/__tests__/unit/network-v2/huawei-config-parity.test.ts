/**
 * TDD Tests for Huawei VRP Router — Configuration & Display Feature Parity with Cisco IOS
 *
 * Covers remaining gaps after OSPF/IPSec parity work:
 *   Batch 1 — save command
 *   Batch 2 — DHCP pool completeness (lease, domain-name)
 *   Batch 3 — DHCP display commands
 *   Batch 4 — display current-configuration completeness (DHCP + ARP static + IPSec section)
 *   Batch 5 — Tunnel interface configuration (source, destination, tunnel-protocol)
 *   Batch 6 — display arp filtered (static, dynamic)
 *   Batch 7 — display ip routing-table statistics
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask,
  resetCounters,
} from '@/network/core/types';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 1: save command
// ═══════════════════════════════════════════════════════════════════

describe('Batch 1: save command', () => {
  it('should respond to save in user view', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('save');
    expect(result).toMatch(/The current configuration will be written to the device\.|Info:|OK/i);
  });

  it('should respond to save in system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('save');
    expect(result).toMatch(/The current configuration will be written to the device\.|Info:|OK/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 2: DHCP pool completeness (lease, domain-name)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 2: DHCP pool completeness', () => {
  it('should configure lease duration in dhcp-pool mode', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool TESTPOOL');
    const result = await r.executeCommand('lease day 7');
    expect(result).toBe('');
    const display = await r.executeCommand('quit');
    const poolDisplay = await r.executeCommand('display ip pool name TESTPOOL');
    expect(poolDisplay).toContain('7');
  });

  it('should configure domain-name in dhcp-pool mode', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool TESTPOOL');
    const result = await r.executeCommand('domain-name example.com');
    expect(result).toBe('');
    await r.executeCommand('quit');
    const poolDisplay = await r.executeCommand('display ip pool name TESTPOOL');
    expect(poolDisplay).toContain('example.com');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 3: DHCP display commands
// ═══════════════════════════════════════════════════════════════════

describe('Batch 3: DHCP display commands', () => {
  it('should display dhcp-server binding all', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display dhcp-server binding all');
    expect(result).toContain('IP address');
  });

  it('should display dhcp statistics', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display dhcp statistics');
    expect(result).toContain('Address pools');
  });

  it('should display dhcp-server binding from system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('display dhcp-server binding all');
    expect(result).toContain('IP address');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 4: display current-configuration completeness
// ═══════════════════════════════════════════════════════════════════

describe('Batch 4: display current-configuration completeness', () => {
  it('should include DHCP pool details in current-config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool MYPOOL');
    await r.executeCommand('network 192.168.10.0 mask 255.255.255.0');
    await r.executeCommand('gateway-list 192.168.10.1');
    await r.executeCommand('dns-list 8.8.8.8');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ip pool MYPOOL');
    expect(cfg).toContain('network 192.168.10.0');
    expect(cfg).toContain('gateway-list 192.168.10.1');
    expect(cfg).toContain('dns-list 8.8.8.8');
  });

  it('should include ARP static entries in current-config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('arp static 10.0.0.99 aabb-ccdd-eeff');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('arp static 10.0.0.99');
  });

  it('should include IKE proposal section in current-config when configured', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike proposal 10');
    await r.executeCommand('encryption-algorithm aes-cbc-128');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ike proposal 10');
    expect(cfg).toContain('encryption-algorithm aes-cbc-128');
  });

  it('should include IPSec proposal section in current-config when configured', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipsec proposal PROP1');
    await r.executeCommand('transform esp');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ipsec proposal PROP1');
    expect(cfg).toContain('transform esp');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 5: Tunnel interface configuration
// ═══════════════════════════════════════════════════════════════════

describe('Batch 5: Tunnel interface configuration', () => {
  it('should configure tunnel source IP address', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface Tunnel0');
    const result = await r.executeCommand('source 10.0.0.1');
    expect(result).toBe('');
    const display = await r.executeCommand('display interface Tunnel0');
    expect(display).toContain('10.0.0.1');
  });

  it('should configure tunnel destination IP address', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface Tunnel0');
    const result = await r.executeCommand('destination 10.0.0.2');
    expect(result).toBe('');
    const display = await r.executeCommand('display interface Tunnel0');
    expect(display).toContain('10.0.0.2');
  });

  it('should configure tunnel-protocol gre', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface Tunnel0');
    const result = await r.executeCommand('tunnel-protocol gre');
    expect(result).toBe('');
  });

  it('should include tunnel source/destination in running-config interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface Tunnel0');
    await r.executeCommand('source 1.1.1.1');
    await r.executeCommand('destination 2.2.2.2');
    await r.executeCommand('ip address 172.16.0.1 255.255.255.252');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration interface Tunnel0');
    expect(cfg).toContain('source 1.1.1.1');
    expect(cfg).toContain('destination 2.2.2.2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 6: display arp filtered (static, dynamic)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 6: display arp filtered', () => {
  it('should display only static ARP entries with display arp static', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('arp static 192.168.1.100 aabb-ccdd-eeff');
    const result = await r.executeCommand('display arp static');
    expect(result).toContain('192.168.1.100');
    expect(result).toContain('static');
  });

  it('should display arp dynamic without static entries', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('arp static 192.168.1.100 aabb-ccdd-eeff');
    const result = await r.executeCommand('display arp dynamic');
    expect(result).not.toContain('192.168.1.100');
  });

  it('should display reset arp dynamic clears only dynamic entries', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('arp static 10.0.0.1 aaaa-bbbb-cccc');
    await r.executeCommand('quit');
    const resetResult = await r.executeCommand('reset arp dynamic');
    expect(resetResult).toBe('');
    const arpTable = await r.executeCommand('display arp');
    expect(arpTable).toContain('10.0.0.1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 7: display ip routing-table statistics
// ═══════════════════════════════════════════════════════════════════

describe('Batch 7: display ip routing-table statistics', () => {
  it('should display routing table statistics', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ip routing-table statistics');
    expect(result).toContain('Total');
  });

  it('should show correct counts after adding routes', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
    await r.executeCommand('quit');
    await r.executeCommand('ip route-static 192.168.0.0 255.255.255.0 10.1.1.2');
    const result = await r.executeCommand('display ip routing-table statistics');
    expect(result).toContain('Static');
    expect(result).toContain('1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 8: DHCP debug and clear commands
// ═══════════════════════════════════════════════════════════════════

describe('Batch 8: DHCP debug and clear commands', () => {
  it('should enable and disable DHCP server packet debugging', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    let result = await r.executeCommand('debugging dhcp server packet');
    expect(result).toBe('');
    result = await r.executeCommand('undo debugging dhcp server packet');
    expect(result).toBe('');
  });

  it('should clear all DHCP bindings with reset ip dhcp binding all', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('reset ip dhcp binding all');
    expect(result).toBe('');
  });

  it('should clear DHCP statistics with reset ip dhcp statistics', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('reset ip dhcp statistics');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 9: display ip protocols (routing protocol info)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 9: display ip protocols', () => {
  it('should display ip protocols when RIP is configured', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('rip 1');
    await r.executeCommand('network 10.0.0.0');
    const result = await r.executeCommand('display ip protocols');
    expect(result).toContain('rip');
    expect(result).toContain('10.0.0.0');
  });

  it('should show no routing protocol when none configured', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ip protocols');
    expect(result).toMatch(/no routing protocol|not configured/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 10: display current-configuration completeness (tunnel in full config)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 10: display current-configuration tunnel interface', () => {
  it('should include tunnel source and destination in full current-config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface Tunnel0');
    await r.executeCommand('ip address 172.16.0.1 255.255.255.252');
    await r.executeCommand('source 10.0.0.1');
    await r.executeCommand('destination 10.0.0.2');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('interface Tunnel0');
    expect(cfg).toContain('source 10.0.0.1');
    expect(cfg).toContain('destination 10.0.0.2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 11: IPSec display completeness
// ═══════════════════════════════════════════════════════════════════

describe('Batch 11: IPSec display completeness', () => {
  it('should display ipsec sa verbose', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ipsec sa verbose');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should display ipsec profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipsec profile PROF1');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display ipsec profile');
    expect(result).toContain('PROF1');
  });

  it('should display ike peer configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike peer PEER1');
    await r.executeCommand('remote-address 10.0.0.2');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display ike peer');
    expect(result).toContain('PEER1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 12: DHCP forbidden-ip and excluded addresses display
// ═══════════════════════════════════════════════════════════════════

describe('Batch 12: DHCP forbidden-ip and excluded addresses', () => {
  it('should accept dhcp server forbidden-ip in system-view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    const result = await r.executeCommand('dhcp server forbidden-ip 10.0.0.1 10.0.0.10');
    expect(result).toBe('');
  });

  it('should display dhcp server forbidden-ip list', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('dhcp server forbidden-ip 10.0.0.1 10.0.0.10');
    const result = await r.executeCommand('display dhcp server forbidden-ip');
    expect(result).toContain('10.0.0.1');
    expect(result).toContain('10.0.0.10');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 13: display debugging / debugging status
// ═══════════════════════════════════════════════════════════════════

describe('Batch 13: display debugging status', () => {
  it('should display current debugging flags', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display debugging');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should reflect debugging state after enable', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('debugging dhcp server packet');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display debugging');
    expect(result).toContain('DHCP');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 14: display current-configuration with DHCP relay on interfaces
// ═══════════════════════════════════════════════════════════════════

describe('Batch 14: display current-configuration DHCP relay', () => {
  it('should include dhcp relay server-ip in current-config interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('dhcp select relay');
    await r.executeCommand('dhcp relay server-ip 10.0.0.254');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('dhcp relay server-ip 10.0.0.254');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 15: IPv6 display commands
// ═══════════════════════════════════════════════════════════════════

describe('Batch 15: IPv6 display commands', () => {
  it('should display ipv6 routing-table', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ipv6 routing-table');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result).toContain('IPv6');
  });

  it('should display ipv6 interface brief', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ipv6 interface brief');
    expect(result).toBeDefined();
    expect(result).toContain('Interface');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 16: display current-configuration with IPSec applied to interfaces
// ═══════════════════════════════════════════════════════════════════

describe('Batch 16: display current-configuration IPSec on interfaces', () => {
  it('should include ipsec policy applied to interface in running-config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('ipsec policy MYPOL');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ipsec policy MYPOL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 17: display ip pool (all pools, without name filter)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 17: display ip pool (all pools)', () => {
  it('should display all DHCP pools without name filter', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool POOL1');
    await r.executeCommand('network 10.0.0.0 mask 255.255.255.0');
    await r.executeCommand('quit');
    await r.executeCommand('ip pool POOL2');
    await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display ip pool');
    expect(result).toContain('POOL1');
    expect(result).toContain('POOL2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 18: RIP view mode test
// ═══════════════════════════════════════════════════════════════════

describe('Batch 18: RIP view mode', () => {
  it('should enter rip view with rip 1 and configure network', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('rip 1');
    expect(result).toBe('');
    await r.executeCommand('network 172.16.0.0');
    await r.executeCommand('quit');
    const display = await r.executeCommand('display rip');
    expect(display).toContain('172.16.0.0');
  });

  it('should support undo rip to disable RIP', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('rip 1');
    await r.executeCommand('network 10.0.0.0');
    await r.executeCommand('quit');
    await r.executeCommand('undo rip');
    await r.executeCommand('quit');
    const display = await r.executeCommand('display rip');
    expect(display).toContain('not enabled');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 19: ACL display all (display acl all)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 19: display acl all', () => {
  it('should display all configured ACLs with display acl all', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('acl 3000');
    await r.executeCommand('rule deny ip source 192.168.1.0 0.0.0.255 destination 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display acl all');
    expect(result).toContain('2000');
    expect(result).toContain('3000');
  });

  it('should show empty message when no ACLs exist', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display acl all');
    expect(result).toMatch(/no ACL|Total 0/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 20: ACL running-config completeness (ACL in current-config)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 20: ACL in current-configuration', () => {
  it('should include ACL rules in display current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('acl number 2000');
    expect(cfg).toContain('rule');
    expect(cfg).toContain('permit');
  });

  it('should include traffic-filter applied to interface in current-config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source any');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('traffic-filter inbound acl 2000');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('traffic-filter inbound acl 2000');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 21: DHCP conflict display (Huawei equivalent)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 21: DHCP snooping display', () => {
  it('should display dhcp-snooping user-bind all from user view', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display dhcp-snooping user-bind all');
    expect(result).toContain('DHCP Snooping');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 22: shutdown clears IPSec SAs on interface
// ═══════════════════════════════════════════════════════════════════

describe('Batch 22: shutdown clears IPSec SAs on interface', () => {
  it('should clear IPSec SAs when interface is shut down', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('ipsec policy TESTPOL');
    await r.executeCommand('shutdown');
    const result = await r.executeCommand('quit');
    expect(result).toBe('');
    const saResult = await r.executeCommand('display ipsec sa');
    expect(saResult).not.toContain('GE0/0/0');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 23: ip forward-protocol udp equivalent (udp-helper)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 23: Huawei udp-helper (ip forward-protocol udp equiv)', () => {
  it('should accept ip forward-protocol udp equivalent on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const result = await r.executeCommand('ip helper-address 10.0.0.254');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 24: service dhcp enable/disable equivalence
// ═══════════════════════════════════════════════════════════════════

describe('Batch 24: dhcp enable/disable and display dhcp conflict', () => {
  it('should disable DHCP with undo dhcp enable', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    const result = await r.executeCommand('undo dhcp enable');
    expect(result).toBe('');
  });

  it('should display dhcp conflict equivalent (display dhcp server conflict all)', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display dhcp server conflict all');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 25: OSPF interface parity (demand-circuit, mtu-ignore)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 25: OSPF interface commands parity', () => {
  it('should accept ospf demand-circuit on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ospf demand-circuit');
    expect(result).toBe('');
  });

  it('should accept ospf mtu-enable on interface (mtu-ignore equiv)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ospf mtu-enable');
    expect(result).toBe('');
  });

  it('should accept ospf bfd enable on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ospf bfd enable');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 26: IPSec SA global config parity (anti-replay, ESN, aggressive-mode)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 26: IPSec global config parity', () => {
  it('should set ipsec anti-replay window size', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec sa anti-replay window 128');
    expect(result).toBe('');
  });

  it('should disable ike aggressive mode', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ike aggressive-mode disable');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 27: DHCP client-identifier deny equivalent
// ═══════════════════════════════════════════════════════════════════

describe('Batch 27: DHCP pool client-identifier deny', () => {
  it('should accept dhcp pool client-identifier deny', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool TESTPOOL');
    await r.executeCommand('network 10.0.0.0 mask 255.255.255.0');
    const result = await r.executeCommand('excluded-ip-address 10.0.0.1 10.0.0.5');
    expect(result).toBe('');
    await r.executeCommand('quit');
    const poolDisplay = await r.executeCommand('display ip pool name TESTPOOL');
    expect(poolDisplay).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 28: Named ACL support (acl name)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 28: Named ACL support', () => {
  it('should create named basic ACL with acl name', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('acl name MY_ACL basic');
    expect(result).toBe('');
  });

  it('should create named advanced ACL with acl name', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('acl name EXTENDED_ACL advanced');
    expect(result).toBe('');
  });

  it('should add rules to named ACL and display them', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl name MY_ACL basic');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display acl all');
    expect(result).toContain('MY_ACL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 29: OSPF display enhancements (display ospf routing)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 29: display ospf routing', () => {
  it('should display ospf routing table', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ospf routing');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 30: display current-configuration completeness (ACL + named ACL)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 30: display current-config with named ACL', () => {
  it('should include named ACL in current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl name FIREWALL basic');
    await r.executeCommand('rule deny source 192.168.0.0 0.0.255.255');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('acl name FIREWALL');
    expect(cfg).toContain('deny');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 31: IPSec clear/reset commands and debug from user view
// ═══════════════════════════════════════════════════════════════════

describe('Batch 31: IPSec reset/debug from user view', () => {
  it('should clear IKE SAs with reset ike sa from user view', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('reset ike sa');
    expect(typeof result).toBe('string');
  });

  it('should clear IPSec SAs with reset ipsec sa from user view', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('reset ipsec sa');
    expect(typeof result).toBe('string');
  });

  it('should enable ike debugging from system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('debugging ike');
    expect(typeof result).toBe('string');
  });

  it('should disable all debugging with undo debugging all', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('debugging ike');
    const result = await r.executeCommand('undo debugging all');
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 32: OSPF advanced config commands parity
// ═══════════════════════════════════════════════════════════════════

describe('Batch 32: OSPF advanced config commands', () => {
  it('should accept bfd all-interfaces in ospf view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('bfd all-interfaces enable');
    expect(result).toBe('');
  });

  it('should accept summary address (abr-summary) in ospf view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('asbr-summary 192.168.0.0 255.255.0.0');
    expect(result).toBe('');
  });

  it('should accept capability opaque in ospf view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('opaque-capability enable');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 33: IPv6 ACL (Huawei ipv6 access-list equivalent)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 33: IPv6 ACL support', () => {
  it('should create IPv6 ACL with acl ipv6', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('acl ipv6 name IPV6_ACL');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 34: IPSec IKE peer local-address and nat traversal
// ═══════════════════════════════════════════════════════════════════

describe('Batch 34: IKE peer local-address and nat traversal', () => {
  it('should accept local-address in ike peer view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike peer PEER1');
    const result = await r.executeCommand('local-address 10.0.0.1');
    expect(result).toBe('');
  });

  it('should accept nat traversal in ike peer view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike peer PEER1');
    const result = await r.executeCommand('nat traversal');
    expect(result).toBe('');
  });

  it('should accept dpd type in ike peer view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike peer PEER1');
    const result = await r.executeCommand('dpd type periodic');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 35: display version and display counters from system view
// ═══════════════════════════════════════════════════════════════════

describe('Batch 35: display version and counters from system view', () => {
  it('should display version from system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('display version');
    expect(result).toContain('VRP');
  });

  it('should display counters from system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('display counters');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should display ip routing-table from system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('display ip routing-table');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 36: OSPF remaining parity (OSPFv3 redistribute, distribute-list, bfd)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 36: OSPFv3 advanced commands', () => {
  it('should accept redistribute in ospfv3 view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospfv3 1');
    const result = await r.executeCommand('default-route-advertise always');
    expect(result).toBe('');
  });

  it('should accept redistribute static in ospfv3 view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospfv3 1');
    const result = await r.executeCommand('import-route static');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 37: OSPF interface OSPFv3 and frame-relay parity
// ═══════════════════════════════════════════════════════════════════

describe('Batch 37: OSPF interface advanced', () => {
  it('should accept ospfv3 cost on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ospfv3 cost 100');
    expect(result).toBe('');
  });

  it('should accept ospfv3 priority on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ospfv3 priority 200');
    expect(result).toBe('');
  });

  it('should accept ospfv3 network-type on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ospfv3 network-type broadcast');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 38: ACL show/display parity improvements
// ═══════════════════════════════════════════════════════════════════

describe('Batch 38: ACL display parity', () => {
  it('should display named ACL by name', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl name TEST_ACL basic');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display acl name TEST_ACL');
    expect(result).toContain('TEST_ACL');
    expect(result).toContain('permit');
  });

  it('should remove named ACL with undo acl name', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl name DELME basic');
    await r.executeCommand('rule permit source any');
    await r.executeCommand('quit');
    const result = await r.executeCommand('undo acl name DELME');
    expect(result).toBe('');
    const aclResult = await r.executeCommand('display acl all');
    expect(aclResult).not.toContain('DELME');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 39: IPSec proposal encapsulation-mode and ESP alg in running config
// ═══════════════════════════════════════════════════════════════════

describe('Batch 39: IPSec proposal encapsulation + ESP in current-config', () => {
  it('should include ipsec proposal encapsulation-mode in current-config', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipsec proposal TESTPROP');
    await r.executeCommand('transform esp');
    await r.executeCommand('encapsulation-mode tunnel');
    await r.executeCommand('esp encryption-algorithm aes-128');
    await r.executeCommand('esp authentication-algorithm sha2-256');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ipsec proposal TESTPROP');
    expect(cfg).toContain('encapsulation-mode tunnel');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 40: OSPF display ospf lsdb typed queries
// ═══════════════════════════════════════════════════════════════════

describe('Batch 40: display ospf lsdb typed queries', () => {
  it('should display ospf lsdb router', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ospf lsdb router');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should display ospf lsdb network', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ospf lsdb network');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 41: IPSec policy detail in current-config (ike-peer, proposal, pfs, sa duration)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 41: IPSec policy detail in current-config', () => {
  it('should include ipsec policy with ike-peer and proposal references', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipsec proposal PROP1');
    await r.executeCommand('transform esp');
    await r.executeCommand('quit');
    await r.executeCommand('ike peer MYPEER');
    await r.executeCommand('remote-address 10.0.0.2');
    await r.executeCommand('quit');
    await r.executeCommand('ipsec policy POL1 10 isakmp');
    await r.executeCommand('ike-peer MYPEER');
    await r.executeCommand('proposal PROP1');
    await r.executeCommand('quit');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).toContain('ipsec policy POL1');
    expect(cfg).toContain('ike-peer MYPEER');
    expect(cfg).toContain('proposal PROP1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 42: OSPF show/display remaining parity (border-routers, statistics, route ospf)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 42: OSPF display remaining parity', () => {
  it('should display ospf abr-asbr (border routers)', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ospf abr-asbr');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should display ospf statistics', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ospf statistics');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should display ip routing-table protocol ospf', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ip routing-table protocol ospf');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should display ospf vlink', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ospf vlink');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 43: OSPF interface remaining (frame-relay, ip routing)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 43: OSPF config remaining', () => {
  it('should accept ip routing in system view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ip routing');
    expect(result).toBe('');
  });

  it('should accept ipv6 unicast-routing equivalent', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipv6');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 44: IPSec SA global config remaining (ESN, global lifetime display)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 44: IPSec global SA config', () => {
  it('should set global ipsec sa lifetime seconds', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec sa global-duration time-based 3600');
    expect(result).toBe('');
  });

  it('should set global ipsec sa lifetime kilobytes', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec sa global-duration traffic-based 4096');
    expect(result).toBe('');
  });

  it('should display ipsec statistics', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ipsec statistics');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 45: IPSec security-policy (SPD) parity
// ═══════════════════════════════════════════════════════════════════

describe('Batch 45: IPSec security-policy', () => {
  it('should create ipsec security-policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec security-policy TESTPOL');
    expect(result).toBe('');
  });

  it('should display ipsec security-policy', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ipsec security-policy');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 46: Cisco config-if commands parity (no interface, no ip address)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 46: Interface config commands parity', () => {
  it('should switch interfaces from within interface view', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const result = await r.executeCommand('interface GE0/0/1');
    expect(result).toBe('');
    const result2 = await r.executeCommand('ip address 10.0.1.1 255.255.255.0');
    expect(result2).toBe('');
  });

  it('should support no description on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('description Test Interface');
    const result = await r.executeCommand('undo description');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 47: ACL interface parity (display show access-lists equivalent)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 47: ACL show equivalence', () => {
  it('should display acl 2000 with rules', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('acl 2000');
    await r.executeCommand('rule permit source 192.168.0.0 0.0.0.255');
    await r.executeCommand('rule deny source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    const result = await r.executeCommand('display acl 2000');
    expect(result).toContain('Basic ACL 2000');
    expect(result).toContain('permit');
    expect(result).toContain('deny');
    expect(result).toContain('rule 0');
    expect(result).toContain('rule 5');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 48: IKEv2 equivalents — Huawei ike v2 proposal/profile
// ═══════════════════════════════════════════════════════════════════

describe('Batch 48: IKEv2 equivalents', () => {
  it('should create ike v2 proposal', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ike v2 proposal MYPROP');
    expect(result).toBe('');
  });

  it('should configure encryption in ike v2 proposal', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 proposal MYPROP');
    const result = await r.executeCommand('encryption-algorithm aes-256');
    expect(result).toBe('');
  });

  it('should create ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ike v2 profile MYPROF');
    expect(result).toBe('');
  });

  it('should configure match in ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 profile MYPROF');
    const result = await r.executeCommand('match remote identity address 10.0.0.1');
    expect(result).toBe('');
  });

  it('should create ike v2 keyring', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ike v2 keyring MYKR');
    expect(result).toBe('');
  });

  it('should configure peer in ike v2 keyring', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 keyring MYKR');
    const result = await r.executeCommand('peer SITE1');
    expect(result).toBe('');
  });

  it('should remove ike v2 proposal', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 proposal MYPROP');
    await r.executeCommand('quit');
    const result = await r.executeCommand('undo ike v2 proposal MYPROP');
    expect(result).toBe('');
  });

  it('should display ike v2 proposal', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ike v2 proposal');
    expect(typeof result).toBe('string');
  });

  it('should display ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ike v2 profile');
    expect(typeof result).toBe('string');
  });

  it('should display ike v2 sa', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ike v2 sa');
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 49: IKEv2 sub-mode commands (keyring peer, profile auth)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 49: IKEv2 sub-mode commands', () => {
  it('should set address on ike v2 keyring peer', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 keyring MYKR');
    await r.executeCommand('peer SITE1');
    const result = await r.executeCommand('address 10.0.0.2');
    expect(result).toBe('');
  });

  it('should set pre-shared-key on ike v2 keyring peer', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 keyring MYKR');
    await r.executeCommand('peer SITE1');
    const result = await r.executeCommand('pre-shared-key cisco123');
    expect(result).toBe('');
  });

  it('should set authentication local in ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 profile MYPROF');
    const result = await r.executeCommand('authentication-method local pre-share');
    expect(result).toBe('');
  });

  it('should set authentication remote in ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 profile MYPROF');
    const result = await r.executeCommand('authentication-method remote pre-share');
    expect(result).toBe('');
  });

  it('should set keyring in ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 profile MYPROF');
    const result = await r.executeCommand('keyring MYKR');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 50: ESN, no arp, ip forward-protocol udp parity
// ═══════════════════════════════════════════════════════════════════

describe('Batch 50: Misc Cisco parity commands', () => {
  it('should support ipsec sa esn enable', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec sa esn enable');
    expect(result).toBe('');
  });

  it('should support undo ipsec sa esn', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('undo ipsec sa esn');
    expect(result).toBe('');
  });

  it('should support undo arp on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('arp static 10.0.0.5 aa-bb-cc-dd-ee-ff');
    const result = await r.executeCommand('undo arp 10.0.0.5');
    expect(result).toBe('');
  });

  it('should support ip forward-protocol udp on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GE0/0/0');
    const result = await r.executeCommand('ip forward-protocol udp 67');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 51: OSPF view missing commands (auto-cost, max-lsa, log equiv)
// ═══════════════════════════════════════════════════════════════════

describe('Batch 51: OSPF view remaining equivalents', () => {
  it('should support ospf max-lsa equivalent (lsa-originate-count)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('lsa-originate-count 5000');
    expect(result).toBe('');
  });

  it('should support ospf log-adjacency-changes equivalent (log-peer-change)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('log-peer-change');
    expect(result).toBe('');
  });

  it('should support ospf auto-cost equivalent (bandwidth-reference)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('bandwidth-reference 1000');
    expect(result).toBe('');
  });

  it('should support ospf stub-router (max-metric equivalent)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('stub-router on-startup 300');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 52: DHCP client-identifier deny equivalent
// ═══════════════════════════════════════════════════════════════════

describe('Batch 52: DHCP advanced commands', () => {
  it('should support dhcp server denied-mac in pool', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ip pool TESTPOOL');
    await r.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    const result = await r.executeCommand('denied-mac aa-bb-cc-dd-ee-ff');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 53: IKEv2 display and clear commands
// ═══════════════════════════════════════════════════════════════════

describe('Batch 53: IKEv2 display and clear', () => {
  it('should display ike v2 sa verbose', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ike v2 sa verbose');
    expect(typeof result).toBe('string');
  });

  it('should reset ike v2 sa', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('reset ike v2 sa');
    expect(typeof result).toBe('string');
  });

  it('should support debugging ike v2', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('debugging ike v2');
    expect(typeof result).toBe('string');
  });

  it('should support undo debugging ike v2', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('undo debugging ike v2');
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BATCH 54: IKEv2 policy, undo profile/keyring
// ═══════════════════════════════════════════════════════════════════

describe('Batch 54: IKEv2 policy and removal', () => {
  it('should create ike v2 policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ike v2 policy MYPOL');
    expect(result).toBe('');
  });

  it('should configure proposal in ike v2 policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 policy MYPOL');
    const result = await r.executeCommand('proposal MYPROP');
    expect(result).toBe('');
  });

  it('should remove ike v2 profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 profile MYPROF');
    await r.executeCommand('quit');
    const result = await r.executeCommand('undo ike v2 profile MYPROF');
    expect(result).toBe('');
  });

  it('should remove ike v2 keyring', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 keyring MYKR');
    await r.executeCommand('quit');
    const result = await r.executeCommand('undo ike v2 keyring MYKR');
    expect(result).toBe('');
  });

  it('should remove ike v2 policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ike v2 policy MYPOL');
    await r.executeCommand('quit');
    const result = await r.executeCommand('undo ike v2 policy MYPOL');
    expect(result).toBe('');
  });

  it('should display ike v2 policy', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('display ike v2 policy');
    expect(typeof result).toBe('string');
  });
});
