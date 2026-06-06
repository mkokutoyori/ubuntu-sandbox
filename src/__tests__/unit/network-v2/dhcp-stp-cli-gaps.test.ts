import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

describe('DHCP/STP CLI gaps', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
  });

  it('Huawei "debugging dhcp server all" and undo are accepted', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    const on = await r.executeCommand('debugging dhcp server all');
    const off = await r.executeCommand('undo debugging dhcp server all');
    expect(on).not.toMatch(/Invalid input|Unrecognized/);
    expect(off).not.toMatch(/Invalid input|Unrecognized/);
  });

  it('Huawei "undo static-bind ip-address" removes the binding', async () => {
    const r = new HuaweiRouter('R2');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool P1');
    await r.executeCommand('network 10.2.2.0 mask 255.255.255.0');
    await r.executeCommand('static-bind ip-address 10.2.2.60 mac-address 0011-2233-4455');
    expect(r._getDHCPServerInternal().getStaticBindings('P1').length).toBe(1);
    const undo = await r.executeCommand('undo static-bind ip-address 10.2.2.60');
    expect(undo).not.toMatch(/Invalid input/);
    expect(r._getDHCPServerInternal().getStaticBindings('P1').length).toBe(0);
  });

  it('Huawei "display current-configuration configuration dhcp" includes ip pool block', async () => {
    const r = new HuaweiRouter('R3');
    await r.executeCommand('system-view');
    await r.executeCommand('dhcp enable');
    await r.executeCommand('ip pool LANP');
    await r.executeCommand('network 10.2.2.0 mask 255.255.255.0');
    await r.executeCommand('quit');
    const out = await r.executeCommand('display current-configuration configuration dhcp');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('ip pool LANP');
    expect(out).toContain('dhcp enable');
  });

  it('Huawei switch "stp edged-port default" is accepted', async () => {
    const sw = new HuaweiSwitch('SW1');
    await sw.executeCommand('system-view');
    const out = await sw.executeCommand('stp edged-port default');
    expect(out).not.toMatch(/Invalid input|Unrecognized/);
  });

  it('Cisco switch "clear spanning-tree" subcommands are accepted', async () => {
    const sw = new CiscoSwitch('SW2');
    await sw.executeCommand('enable');
    const a = await sw.executeCommand('clear spanning-tree detected-protocols');
    const b = await sw.executeCommand('clear spanning-tree counters');
    expect(a).not.toMatch(/Invalid input/);
    expect(b).not.toMatch(/Invalid input/);
  });
});
