/**
 * TDD — router operational show commands must project REAL engine
 * state (RIP RIB, CEF FIB, saved config), and report the honest
 * "not configured" state for protocols with no engine (BGP/EIGRP) —
 * never "Invalid input", never fabricated tables.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco router operational show (real state)', () => {
  it('show ip cef projects the real routing table', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('ip route 10.0.0.0 255.0.0.0 192.168.1.2');
    await r.executeCommand('end');

    const cef = await r.executeCommand('show ip cef');
    expect(cef).not.toMatch(/Invalid input/);
    expect(cef).toContain('192.168.1.0/24');
    expect(cef).toContain('10.0.0.0/8');
    expect(cef).toContain('192.168.1.2');
  });

  it('show ip rip database reflects real RIP config', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show ip rip database')).not.toMatch(/Invalid input/);
    await r.executeCommand('configure terminal');
    await r.executeCommand('router rip');
    await r.executeCommand('version 2');
    await r.executeCommand('network 192.168.1.0');
    await r.executeCommand('end');
    const db = await r.executeCommand('show ip rip database');
    expect(db).not.toMatch(/Invalid input/);
    expect(db).toContain('192.168.1.0');
  });

  it('show startup-config reflects real saved state', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show startup-config'))
      .toMatch(/startup-config is not present/);
    await r.executeCommand('configure terminal');
    await r.executeCommand('hostname SAVED-R1');
    await r.executeCommand('end');
    await r.executeCommand('write memory');
    const start = await r.executeCommand('show startup-config');
    expect(start).not.toMatch(/not present|Invalid input/);
    expect(start).toContain('SAVED-R1');
  });

  it('BGP/EIGRP report honest not-configured state (no stub table)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    for (const c of ['show ip bgp', 'show ip bgp summary', 'show bgp']) {
      const out = await r.executeCommand(c);
      expect(out, c).not.toMatch(/Invalid input/);
      expect(out, c).toMatch(/BGP not active/);
    }
    for (const c of ['show ip eigrp neighbors', 'show ip eigrp topology']) {
      const out = await r.executeCommand(c);
      expect(out, c).not.toMatch(/Invalid input/);
      expect(out, c).toMatch(/EIGRP not running/);
    }
  });
});
