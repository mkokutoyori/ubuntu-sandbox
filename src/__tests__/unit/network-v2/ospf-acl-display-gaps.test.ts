import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

describe('OSPF/ACL display gaps', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
  });

  it('Huawei "display ospf peer last-nbr-down" is accepted', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1 router-id 1.1.1.1');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('quit');
    const out = await r.executeCommand('display ospf peer last-nbr-down');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('Router ID');
  });

  it('Huawei "display current-configuration configuration ospf" shows ospf block', async () => {
    const r = new HuaweiRouter('R2');
    await r.executeCommand('system-view');
    await r.executeCommand('ospf 1 router-id 2.2.2.2');
    await r.executeCommand('area 0');
    await r.executeCommand('network 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    const out = await r.executeCommand('display current-configuration configuration ospf');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('ospf 1');
  });

  it('Huawei "display traffic-filter applied-record" reflects applied filters', async () => {
    const r = new HuaweiRouter('R3');
    await r.executeCommand('system-view');
    await r.executeCommand('acl number 3000');
    await r.executeCommand('rule permit source 10.0.0.0 0.0.0.255');
    await r.executeCommand('quit');
    await r.executeCommand('interface GigabitEthernet0/0/3');
    await r.executeCommand('traffic-filter inbound acl 3000');
    await r.executeCommand('quit');
    const out = await r.executeCommand('display traffic-filter applied-record');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('inbound');
    expect(out).toContain('3000');
  });

  it('Cisco switch "show errdisable recovery" is accepted', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show errdisable recovery');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('ErrDisable Reason');
  });
});
