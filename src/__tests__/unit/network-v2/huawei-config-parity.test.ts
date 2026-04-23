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
