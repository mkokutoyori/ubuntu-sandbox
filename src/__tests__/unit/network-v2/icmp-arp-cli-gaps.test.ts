import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

describe('ICMP/ARP CLI gaps', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
  });

  it('Cisco "ip unreachables" affirmative is accepted', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    const off = await r.executeCommand('no ip unreachables');
    const on = await r.executeCommand('ip unreachables');
    expect(off).not.toMatch(/Invalid input/);
    expect(on).not.toMatch(/Invalid input/);
  });

  it('Huawei "debugging ip icmp" is accepted in user view', async () => {
    const r = new HuaweiRouter('R2');
    const out = await r.executeCommand('debugging ip icmp');
    expect(out).not.toMatch(/Invalid input/);
    expect(out.toLowerCase()).toContain('icmp');
  });

  it('Huawei "display icmp statistics" and "display ip statistics" render', async () => {
    const r = new HuaweiRouter('R3');
    const icmp = await r.executeCommand('display icmp statistics');
    const ip = await r.executeCommand('display ip statistics');
    expect(icmp).not.toMatch(/Invalid input/);
    expect(icmp).toContain('ICMP statistics');
    expect(ip).not.toMatch(/Invalid input/);
    expect(ip).toContain('IP');
  });

  it('Huawei "undo arp expire-time" resets to default', async () => {
    const r = new HuaweiRouter('R4');
    await r.executeCommand('system-view');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    await r.executeCommand('arp expire-time 600');
    const undo = await r.executeCommand('undo arp expire-time');
    expect(undo).not.toMatch(/Invalid input/);
    const port = r.getPort('GE0/0/0');
    expect(port?.getArpTimeoutSec()).toBe(4 * 60 * 60);
  });
});
