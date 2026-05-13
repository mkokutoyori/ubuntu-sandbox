/**
 * TDD Tests for Huawei VRP Router — OSPF & IPSec Feature Parity with Cisco IOS
 *
 * OSPF features tested:
 *   - Interface OSPF commands (cost, priority, hello/dead timers, network-type, authentication)
 *   - OSPF view commands (area range, virtual-link, import-route, filter-policy, timers, graceful-restart, log-peer-change)
 *   - Display commands (peer verbose, lsdb typed, interface brief, vlink, abr-asbr, statistics)
 *   - Running-config OSPF output
 *
 * IPSec features tested:
 *   - IPSec profile + tunnel protection
 *   - Security policy (SPD)
 *   - Anti-replay / ESN
 *   - Debug/reset commands
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPAddress, SubnetMask,
  resetCounters,
} from '@/network/core/types';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// OSPF BATCH 1: Interface OSPF Commands
// ═══════════════════════════════════════════════════════════════════

describe('OSPF Batch 1: Interface OSPF Commands', () => {

  it('should set OSPF cost on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const result = await r.executeCommand('ospf cost 50');
    expect(result).toBe('');
    const display = await r.executeCommand('display ospf interface');
    expect(display).toContain('Cost: 50');
  });

  it('should set OSPF DR priority on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const result = await r.executeCommand('ospf dr-priority 200');
    expect(result).toBe('');
    const display = await r.executeCommand('display ospf interface');
    expect(display).toContain('Priority: 200');
  });

  it('should set OSPF hello and dead timers on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('ospf timer hello 5');
    const result = await r.executeCommand('ospf timer dead 20');
    expect(result).toBe('');
    const display = await r.executeCommand('display ospf interface');
    expect(display).toContain('Hello: 5');
    expect(display).toContain('Dead: 20');
  });

  it('should set OSPF network type on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const result = await r.executeCommand('ospf network-type p2p');
    expect(result).toBe('');
    const display = await r.executeCommand('display ospf interface');
    expect(display).toContain('p2p');
  });

  it('should set OSPF authentication on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    const result = await r.executeCommand('ospf authentication-mode md5 1 cipher MySecret');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// OSPF BATCH 2: OSPF View Additional Commands
// ═══════════════════════════════════════════════════════════════════

describe('OSPF Batch 2: OSPF View Additional Commands', () => {

  it('should configure area range for route aggregation', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    const result = await r.executeCommand('abr-summary 10.0.0.0 255.255.0.0');
    expect(result).toBe('');
  });

  it('should configure virtual-link', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 1');
    const result = await r.executeCommand('vlink-peer 2.2.2.2');
    expect(result).toBe('');
  });

  it('should configure import-route static', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('import-route static');
    expect(result).toBe('');
  });

  it('should configure import-route connected', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('import-route direct');
    expect(result).toBe('');
  });

  it('should configure filter-policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('filter-policy 2000 import');
    expect(result).toBe('');
  });

  it('should configure SPF timers', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('spf-schedule-interval millisecond 200 1000 5000');
    expect(result).toBe('');
  });

  it('should configure graceful restart', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('graceful-restart');
    expect(result).toBe('');
  });

  it('should configure log-peer-change', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('log-peer-change');
    expect(result).toBe('');
  });

  it('should configure stub-router on startup', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('stub-router on-startup 300');
    expect(result).toBe('');
  });

  it('should configure lsa-max-count', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('lsa-originate-count 10000');
    expect(result).toBe('');
  });

  it('should configure peer (NBMA neighbor)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    const result = await r.executeCommand('peer 10.0.0.2');
    expect(result).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// OSPF BATCH 3: Display Commands
// ═══════════════════════════════════════════════════════════════════

describe('OSPF Batch 3: Display Commands', () => {

  it('should display ospf peer verbose (neighbor detail)', async () => {
    const r1 = new HuaweiRouter('R1');
    const r2 = new HuaweiRouter('R2');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.configureInterface('GE0/0/0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const cable = new Cable('c1');
    cable.connect(r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);
    await r1.executeCommand('system-view');
    await r1.executeCommand('ospf 1');
    await r1.executeCommand('area 0');
    await r1.executeCommand('network 10.0.0.0 0.0.0.255');
    await r1.executeCommand('return');
    await r2.executeCommand('system-view');
    await r2.executeCommand('ospf 1');
    await r2.executeCommand('area 0');
    await r2.executeCommand('network 10.0.0.0 0.0.0.255');
    await r2.executeCommand('return');
    const output = await r1.executeCommand('display ospf peer verbose');
    expect(output).toContain('Neighbor');
    expect(output).toContain('State');
  });

  it('should display ospf lsdb router', async () => {
    const r = new HuaweiRouter('R1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ospf lsdb router');
    expect(output).toContain('Router');
  });

  it('should display ospf interface brief', async () => {
    const r = new HuaweiRouter('R1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ospf interface brief');
    expect(output).toContain('Interface');
    expect(output).toContain('Area');
    expect(output).toContain('Cost');
  });

  it('should display ospf vlink', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 1');
    await r.executeCommand('vlink-peer 2.2.2.2');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ospf vlink');
    expect(output).toContain('2.2.2.2');
  });

  it('should display ospf abr-asbr', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ospf abr-asbr');
    expect(output).not.toContain('Error');
  });

  it('should display ospf statistics', async () => {
    const r = new HuaweiRouter('R1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ospf statistics');
    expect(output).toContain('SPF');
  });

  it('should display ip routing-table protocol ospf', async () => {
    const r = new HuaweiRouter('R1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ip routing-table protocol ospf');
    expect(output).not.toContain('Error');
  });
});

// ═══════════════════════════════════════════════════════════════════
// OSPF BATCH 4: Running-Config OSPF Output
// ═══════════════════════════════════════════════════════════════════

describe('OSPF Batch 4: Running-Config OSPF Output', () => {

  it('should include OSPF section in display current-configuration', async () => {
    const r = new HuaweiRouter('R1');
    r.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1');
    await r.executeCommand('router-id 1.1.1.1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display current-configuration');
    expect(output).toContain('ospf 1');
    expect(output).toContain('router-id 1.1.1.1');
    expect(output).toContain('area 0');
    expect(output).toContain('network 10.0.0.0 0.0.0.255');
  });
});

// ═══════════════════════════════════════════════════════════════════
// IPSec BATCH 1: Additional IPSec Features
// ═══════════════════════════════════════════════════════════════════

describe('IPSec Batch 1: IPSec Profile & Tunnel Protection', () => {

  it('should create and configure an ipsec profile', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec profile MyProfile');
    expect(result).toBe('');
    const quitResult = await r.executeCommand('quit');
    expect(quitResult).toBe('');
  });

  it('should apply ipsec profile on tunnel interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    // Create a transform set first
    await r.executeCommand('ipsec proposal myprop');
    await r.executeCommand('esp encryption-algorithm aes-128');
    await r.executeCommand('esp authentication-algorithm sha1');
    await r.executeCommand('quit');
    // Create profile
    await r.executeCommand('ipsec profile MyProfile');
    await r.executeCommand('proposal myprop');
    await r.executeCommand('quit');
    // Apply to tunnel interface
    await r.executeCommand('interface Tunnel0');
    const result = await r.executeCommand('ipsec profile MyProfile');
    expect(result).toBe('');
  });
});

describe('IPSec Batch 2: Security Policy & Additional Commands', () => {

  it('should configure ipsec security-policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec security-policy MyPolicy protect outbound source 10.0.0.0 0.0.0.255 destination 20.0.0.0 0.0.0.255');
    expect(result).toBe('');
  });

  it('should display ipsec security-policy', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ipsec security-policy MyPolicy protect outbound source 10.0.0.0 0.0.0.255 destination 20.0.0.0 0.0.0.255');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ipsec security-policy');
    expect(output).not.toContain('Error');
  });

  it('should configure sa duration globally (global-lifetime)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ipsec sa global-duration time-based 7200');
    expect(result).toBe('');
  });

  it('should reset ipsec sa with peer filter', async () => {
    const r = new HuaweiRouter('R1');
    const result = await r.executeCommand('reset ipsec sa');
    expect(result).toContain('Info');
  });

  it('should support debugging ike/ipsec', async () => {
    const r = new HuaweiRouter('R1');
    const result1 = await r.executeCommand('debugging ike');
    expect(result1).not.toContain('Error');
    const result2 = await r.executeCommand('debugging ipsec');
    expect(result2).not.toContain('Error');
    const result3 = await r.executeCommand('undo debugging all');
    expect(result3).not.toContain('Error');
  });
});

// ═══════════════════════════════════════════════════════════════════
// OSPF BATCH 5: OSPFv3 (IPv6 OSPF) Commands
// ═══════════════════════════════════════════════════════════════════

describe('OSPF Batch 5: OSPFv3 Commands', () => {

  it('should enable OSPFv3 process', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const result = await r.executeCommand('ospfv3 1');
    expect(result).toBe('');
  });

  it('should set OSPFv3 router-id', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospfv3 1');
    const result = await r.executeCommand('router-id 1.1.1.1');
    expect(result).toBe('');
  });

  it('should configure OSPFv3 on interface', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospfv3 1');
    await r.executeCommand('quit');
    await r.executeCommand('interface GE0/0/0');
    await r.executeCommand('ipv6 enable');
    const result = await r.executeCommand('ospfv3 1 area 0');
    expect(result).toBe('');
  });

  it('should display ospfv3 peer', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospfv3 1');
    await r.executeCommand('return');
    const output = await r.executeCommand('display ospfv3 peer');
    expect(output).not.toContain('Error');
  });
});
