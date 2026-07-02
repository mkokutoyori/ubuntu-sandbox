import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('show spanning-tree subcommands', () => {
  it('root/bridge/vlan/blockedports/detail reflect real STP state', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    new Cable('a').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);
    new Cable('b').connect(s1.getPort('FastEthernet0/2')!, s2.getPort('FastEthernet0/2')!);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('spanning-tree vlan 1 priority 4096');
    await s1.executeCommand('end');
    await s2.executeCommand('enable');

    const root = await s2.executeCommand('show spanning-tree root');
    expect(root).toContain('VLAN0001');
    expect(root).toContain('0200.0000.0001');
    expect(root).not.toContain('% Invalid');

    const bridge = await s2.executeCommand('show spanning-tree bridge');
    expect(bridge).toContain('Bridge ID');
    expect(bridge).not.toContain('% Invalid');

    const vlan = await s2.executeCommand('show spanning-tree vlan 1');
    expect(vlan).toContain('VLAN0001');
    expect(vlan).not.toContain('% Invalid');

    const blocked = await s2.executeCommand('show spanning-tree blockedports');
    expect(blocked).toContain('Number of blocked ports');
    expect(blocked).toMatch(/Fa0\/[12]/);

    const detail = await s2.executeCommand('show spanning-tree detail');
    expect(detail).toContain('executing the');
    expect(detail).not.toContain('% Invalid');

    expect(await s2.executeCommand('show debugging')).toBe('No debugging is enabled');
    expect(await s2.executeCommand('debug spanning-tree events')).toContain('debugging is on');
    const dbg = await s2.executeCommand('show debugging');
    expect(dbg).toContain('Spanning Tree');
    expect(dbg).toContain('is on');
    await s2.executeCommand('no debug all');
    expect(await s2.executeCommand('show debugging')).toBe('No debugging is enabled');
  });
});
