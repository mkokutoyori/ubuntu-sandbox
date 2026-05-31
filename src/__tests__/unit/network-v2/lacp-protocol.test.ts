import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ETHERTYPE_LACP, LACP_SLOW_MAC, compareSystemId } from '@/network/lacp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function configureChannelGroup(sw: CiscoSwitch, port: string, group: number, mode: 'active' | 'passive' | 'on'): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand(`channel-group ${group} mode ${mode}`);
  await sw.executeCommand('end');
}

describe('LACP — pure helpers', () => {
  it('system ID comparator prioritises lower system priority', () => {
    expect(compareSystemId({ priority: 100, id: 'aa:aa:aa:aa:aa:aa' },
                            { priority: 200, id: '00:00:00:00:00:00' })).toBeLessThan(0);
    expect(compareSystemId({ priority: 100, id: 'aa:aa:aa:aa:aa:aa' },
                            { priority: 100, id: 'bb:bb:bb:bb:bb:bb' })).toBeLessThan(0);
  });
});

describe('LACP — single switch', () => {
  it('channel-group adds the port to a logical group', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await configureChannelGroup(sw, 'FastEthernet0/0', 1, 'active');
    const info = sw.getLacpAgent().getPortInfo('FastEthernet0/0');
    expect(info?.groupId).toBe(1);
    expect(info?.mode).toBe('active');
  });

  it('static mode "on" bundles a port immediately on link-up', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const peer = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configureChannelGroup(sw, 'FastEthernet0/0', 1, 'on');
    new Cable('w').connect(sw.getPort('FastEthernet0/0')!,
                            peer.getPort('FastEthernet0/0')!);
    const info = sw.getLacpAgent().getPortInfo('FastEthernet0/0');
    expect(info?.bundled).toBe(true);
    expect(info?.state).toBe('bundled');
  });

  it('no channel-group removes the port from the group', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await configureChannelGroup(sw, 'FastEthernet0/0', 1, 'active');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('no channel-group');
    await sw.executeCommand('end');
    expect(sw.getLacpAgent().getPortInfo('FastEthernet0/0')).toBeUndefined();
  });
});

describe('LACP — negotiation across a cable', () => {
  it('active/active bundles both ports', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'active');
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);
    const i1 = s1.getLacpAgent().getPortInfo('FastEthernet0/0');
    const i2 = s2.getLacpAgent().getPortInfo('FastEthernet0/0');
    expect(i1?.bundled).toBe(true);
    expect(i2?.bundled).toBe(true);
  });

  it('active/passive bundles both ports', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'passive');
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);
    expect(s1.getLacpAgent().getPortInfo('FastEthernet0/0')?.bundled).toBe(true);
    expect(s2.getLacpAgent().getPortInfo('FastEthernet0/0')?.bundled).toBe(true);
  });

  it('passive/passive stays standalone (neither side advertises)', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'passive');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'passive');
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);
    expect(s1.getLacpAgent().getPortInfo('FastEthernet0/0')?.bundled).toBe(false);
    expect(s2.getLacpAgent().getPortInfo('FastEthernet0/0')?.bundled).toBe(false);
  });

  it('two member ports in the same group bundle together (active/active)', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s1, 'FastEthernet0/1', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/1', 1, 'active');
    new Cable('a').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    const members = s1.getLacpAgent().getGroupMembers(1);
    expect(members.length).toBe(2);
    expect(members.every(m => m.bundled)).toBe(true);
  });
});

describe('LACP — reactive bus', () => {
  it('lacp.port.bundled fires when active/active negotiates', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const bundled: Array<{ deviceId: string; port: string }> = [];
    bus.subscribe('lacp.port.bundled', (e) => bundled.push(e.payload));

    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'active');
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);

    expect(bundled.some(b => b.deviceId === s1.id)).toBe(true);
    expect(bundled.some(b => b.deviceId === s2.id)).toBe(true);
  });

  it('lacp.port.unbundled fires on link-down', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'active');
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);

    const unbundled: Array<{ deviceId: string; cause: string }> = [];
    bus.subscribe('lacp.port.unbundled', (e) => unbundled.push(e.payload));
    s1.getPort('FastEthernet0/0')!.setUp(false);
    expect(unbundled.some(u => u.deviceId === s1.id && u.cause === 'link-down')).toBe(true);
  });
});

describe('LACP — wire format', () => {
  it('LACPDU uses the slow-protocols multicast and ethertype 0x8809', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const cable = new Cable('w');
    cable.setEventBus(bus);

    let seen: { dst: string; ether: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.frame.etherType === ETHERTYPE_LACP) {
        seen = {
          dst: e.payload.frame.dstMAC.toString().toLowerCase(),
          ether: e.payload.frame.etherType,
        };
      }
    });
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'active');
    cable.connect(s1.getPort('FastEthernet0/0')!,
                  s2.getPort('FastEthernet0/0')!);

    expect(seen).not.toBeNull();
    expect(seen!.dst).toBe(LACP_SLOW_MAC);
    expect(seen!.ether).toBe(ETHERTYPE_LACP);
  });
});

describe('LACP — show etherchannel', () => {
  it('show etherchannel summary reports bundled ports', async () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configureChannelGroup(s1, 'FastEthernet0/0', 1, 'active');
    await configureChannelGroup(s2, 'FastEthernet0/0', 1, 'active');
    new Cable('w').connect(s1.getPort('FastEthernet0/0')!,
                            s2.getPort('FastEthernet0/0')!);
    const out = await s1.executeCommand('show etherchannel summary');
    expect(out).toMatch(/Number of channel-groups in use: 1/);
    expect(out).toMatch(/1\s+Port-channel1\s+LACP/);
    expect(out).toMatch(/Fa0\/0\(P\)/);
  });

  it('running-config emits channel-group lines', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await configureChannelGroup(sw, 'FastEthernet0/0', 5, 'active');
    const out = await sw.executeCommand('show running-config');
    expect(out).toMatch(/channel-group 5 mode active/);
  });
});

describe('LACP — Huawei Eth-Trunk parity', () => {
  it('eth-trunk on member port drives the LACP agent', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface Eth-Trunk 1');
    await sw.executeCommand('mode lacp-dynamic');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('eth-trunk 1');
    await sw.executeCommand('quit');
    await sw.executeCommand('quit');
    const info = sw.getLacpAgent().getPortInfo('GigabitEthernet0/0/0');
    expect(info?.groupId).toBe(1);
    expect(info?.mode).toBe('active');
  });

  it('two Huawei switches with lacp-dynamic bundle their members', async () => {
    const s1 = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s2 = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    for (const sw of [s1, s2]) {
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Eth-Trunk 1');
      await sw.executeCommand('mode lacp-dynamic');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/0');
      await sw.executeCommand('eth-trunk 1');
      await sw.executeCommand('quit');
      await sw.executeCommand('quit');
    }
    new Cable('w').connect(s1.getPort('GigabitEthernet0/0/0')!,
                            s2.getPort('GigabitEthernet0/0/0')!);
    expect(s1.getLacpAgent().getPortInfo('GigabitEthernet0/0/0')?.bundled).toBe(true);
    expect(s2.getLacpAgent().getPortInfo('GigabitEthernet0/0/0')?.bundled).toBe(true);
  });

  it('Huawei interop with Cisco: lacp-dynamic ↔ channel-group active', async () => {
    const huawei = new HuaweiSwitch('switch-huawei', 'HW1', 8);
    const cisco = new CiscoSwitch('switch-cisco', 'CSCO1', 8);
    await huawei.executeCommand('system-view');
    await huawei.executeCommand('interface Eth-Trunk 1');
    await huawei.executeCommand('mode lacp-dynamic');
    await huawei.executeCommand('quit');
    await huawei.executeCommand('interface GigabitEthernet0/0/0');
    await huawei.executeCommand('eth-trunk 1');
    await huawei.executeCommand('quit');
    await huawei.executeCommand('quit');
    await configureChannelGroup(cisco, 'FastEthernet0/0', 1, 'active');
    new Cable('w').connect(huawei.getPort('GigabitEthernet0/0/0')!,
                            cisco.getPort('FastEthernet0/0')!);
    expect(huawei.getLacpAgent().getPortInfo('GigabitEthernet0/0/0')?.bundled).toBe(true);
    expect(cisco.getLacpAgent().getPortInfo('FastEthernet0/0')?.bundled).toBe(true);
  });
});
