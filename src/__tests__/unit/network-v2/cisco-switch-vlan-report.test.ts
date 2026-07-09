import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function freshSwitch(): CiscoSwitch {
  return new CiscoSwitch('switch-cisco', 'Switch3', 24, 0, 0);
}

async function priv(sw: CiscoSwitch): Promise<CiscoSwitch> {
  await sw.executeCommand('enable');
  return sw;
}

describe('VLAN report — rejected valid commands (Cat 1)', () => {
  it('show interfaces FastEthernet0/1 status is implemented per-interface', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show interfaces FastEthernet0/1 status');
    expect(out).not.toContain('% Invalid input');
    expect(out).toContain('Fa0/1');
    expect(out).toContain('Port');
  });

  it('show vtp devices reflects real CDP-discovered switches (not a stub)', async () => {
    const sw = await priv(freshSwitch());
    expect(await sw.executeCommand('show vtp devices')).toContain('No device found');

    const peer = new CiscoSwitch('switch-cisco', 'Peer', 24, 0, 0);
    new Cable('c1').connect(sw.getPort('FastEthernet0/1')!, peer.getPort('FastEthernet0/1')!);
    expect(sw.getCdpAgent().getNeighbors().some(n => n.remoteHost === 'Peer')).toBe(true);
    const out = await sw.executeCommand('show vtp devices');
    expect(out).not.toContain('% Invalid input');
    expect(out).toContain('Peer');
  });
});

describe('VLAN report — factually correct output (Cat 2)', () => {
  it('show vtp status uses dotted MAC for Device ID and an IP for updater', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show vtp status');
    expect(out).toMatch(/Device ID\s+:\s+[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
    expect(out).not.toMatch(/Device ID\s+:\s+[0-9a-f]{2}:/);
    expect(out).toContain('Configuration last modified by 0.0.0.0');
    expect(out).toContain('Local updater ID is 0.0.0.0');
  });

  it('interface status shows auto/auto for a notconnect port (no a-full/a-100)', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show interfaces status');
    const fa1 = out.split('\n').find(l => l.startsWith('Fa0/1'));
    expect(fa1).toBeDefined();
    expect(fa1).toContain('notconnect');
    expect(fa1).toContain('auto');
    expect(fa1).not.toContain('a-full');
    expect(fa1).not.toContain('a-100');
  });

  it('interface status shows a-full/a-100 once a link is connected', async () => {
    const sw = freshSwitch();
    const pc = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    await priv(sw);
    const out = await sw.executeCommand('show interfaces status');
    const fa1 = out.split('\n').find(l => l.startsWith('Fa0/1'));
    expect(fa1).toContain('connected');
    expect(fa1).toContain('a-full');
  });

  it('spanning-tree detail never prints "disabled disabled"', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show spanning-tree detail');
    expect(out).not.toContain('disabled disabled');
  });

  it('spanning-tree summary root list matches the VLANs the switch is root for', async () => {
    const sw = await priv(freshSwitch());
    for (const c of ['configure terminal', 'vlan 10', 'exit', 'vlan 20', 'end']) {
      await sw.executeCommand(c);
    }
    const summary = await sw.executeCommand('show spanning-tree summary');
    const rootLine = summary.split('\n').find(l => l.startsWith('Root bridge for:'));
    expect(rootLine).toContain('VLAN0001');
    expect(rootLine).toContain('VLAN0010');
    expect(rootLine).toContain('VLAN0020');
  });
});

describe('VLAN report — complete output (Cat 3)', () => {
  it('show vlan carries the Type/SAID/MTU detail absent from show vlan brief', async () => {
    const sw = await priv(freshSwitch());
    const full = await sw.executeCommand('show vlan');
    const brief = await sw.executeCommand('show vlan brief');
    expect(full).toContain('SAID');
    expect(full).toContain('100001');
    expect(full).toContain('Remote SPAN VLANs');
    expect(brief).not.toContain('SAID');
    expect(full).not.toBe(brief);
  });

  it('show mac address-table count returns per-VLAN counters, not "No entries"', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show mac address-table count');
    expect(out).toContain('Mac Address Count');
    expect(out).not.toContain('No entries.');
  });

  it('show mac address-table aging-time returns the configured aging value', async () => {
    const sw = await priv(freshSwitch());
    const out = await sw.executeCommand('show mac address-table aging-time');
    expect(out).toContain('Aging Time');
    expect(out).toContain('300');
    expect(out).not.toContain('No entries.');
  });
});
