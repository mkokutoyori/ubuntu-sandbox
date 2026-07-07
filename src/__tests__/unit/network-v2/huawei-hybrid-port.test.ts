import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import type { TaggedEthernetFrame } from '@/network/devices/Switch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function untaggedFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

function taggedFrame(vid: number, src: MACAddress, dst: MACAddress): TaggedEthernetFrame {
  return {
    srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4,
    payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid },
  };
}

function sniff(sw: HuaweiSwitch, portName: string): { frames: EthernetFrame[] } {
  const sniffer = new Port(`sniff-${portName}`);
  const box = { frames: [] as EthernetFrame[] };
  sniffer.onFrame((_n, f) => {
    if (f.etherType === ETHERTYPE_IPV4 && (f.payload as { type?: string })?.type === 'test') box.frames.push(f);
  });
  new Cable(`c-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return box;
}

async function hybridLab(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
  await sw.executeCommand('system-view');
  await sw.executeCommand('vlan batch 10 20 30 100');
  await sw.executeCommand('interface GigabitEthernet0/0/1');
  await sw.executeCommand('port link-type hybrid');
  await sw.executeCommand('port hybrid pvid vlan 10');
  await sw.executeCommand('port hybrid untagged vlan 10 20 30');
  await sw.executeCommand('port hybrid tagged vlan 100');
  await sw.executeCommand('quit');
  await sw.executeCommand('interface GigabitEthernet0/0/2');
  await sw.executeCommand('port link-type access');
  await sw.executeCommand('port default vlan 20');
  await sw.executeCommand('quit');
  await sw.executeCommand('interface GigabitEthernet0/0/3');
  await sw.executeCommand('port link-type access');
  await sw.executeCommand('port default vlan 30');
  await sw.executeCommand('quit');
  await sw.executeCommand('interface GigabitEthernet0/0/4');
  await sw.executeCommand('port link-type access');
  await sw.executeCommand('port default vlan 100');
  await sw.executeCommand('quit');
  for (const p of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3', 'GigabitEthernet0/0/4']) {
    for (const v of [10, 20, 30, 100]) sw.setStpVlanState(p, v, 'forwarding');
  }
  return sw;
}

describe('Huawei hybrid port — configuration model', () => {
  it('port hybrid pvid/tagged/untagged populate the real port config', async () => {
    const sw = await hybridLab();
    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/1')!;
    expect(cfg.mode).toBe('hybrid');
    expect(cfg.hybridPvid).toBe(10);
    expect([...cfg.hybridUntaggedVlans!].sort((a, b) => a - b)).toEqual([1, 10, 20, 30]);
    expect([...cfg.hybridTaggedVlans!]).toEqual([100]);
  });

  it('display port vlan reflects the hybrid untagged/tagged sets', async () => {
    const sw = await hybridLab();
    await sw.executeCommand('return');
    const out = await sw.executeCommand('display port vlan');
    const row = out.split('\n').find(l => l.startsWith('GigabitEthernet0/0/1'))!;
    expect(row).toContain('hybrid');
    expect(row).toContain('10');
    expect(row).toMatch(/U: 1 10 20 30/);
    expect(row).toMatch(/T: 100/);
  });
});

describe('Huawei hybrid port — ingress datapath', () => {
  it('an untagged frame lands on the PVID', async () => {
    const sw = await hybridLab();
    const mac = new MACAddress('aa:bb:cc:00:00:01');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(untaggedFrame(mac, new MACAddress('aa:bb:cc:00:00:99')));
    const entry = sw.getMACTable().find(e => e.mac === mac.toString().toLowerCase());
    expect(entry?.vlan).toBe(10);
  });

  it('a tagged frame on a member VLAN is accepted; a non-member VLAN is dropped', async () => {
    const sw = await hybridLab();
    const okMac = new MACAddress('aa:bb:cc:00:00:02');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(taggedFrame(100, okMac, new MACAddress('aa:bb:cc:00:00:98')));
    expect(sw.getMACTable().find(e => e.mac === okMac.toString().toLowerCase())?.vlan).toBe(100);

    const badMac = new MACAddress('aa:bb:cc:00:00:03');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(taggedFrame(999, badMac, new MACAddress('aa:bb:cc:00:00:97')));
    expect(sw.getMACTable().find(e => e.mac === badMac.toString().toLowerCase())).toBeUndefined();
  });
});

describe('Huawei hybrid port — egress datapath', () => {
  it('two different VLANs both leave the same hybrid port untagged (the point of hybrid mode)', async () => {
    const sw = await hybridLab();
    const hybrid = sniff(sw, 'GigabitEthernet0/0/1');

    sw.getPort('GigabitEthernet0/0/2')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:04'), MACAddress.broadcast()));
    sw.getPort('GigabitEthernet0/0/3')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:05'), MACAddress.broadcast()));

    expect(hybrid.frames.length).toBe(2);
    expect((hybrid.frames[0] as TaggedEthernetFrame).dot1q).toBeUndefined();
    expect((hybrid.frames[1] as TaggedEthernetFrame).dot1q).toBeUndefined();
  });

  it('a VLAN in the tagged list leaves the hybrid port tagged', async () => {
    const sw = await hybridLab();
    const hybrid = sniff(sw, 'GigabitEthernet0/0/1');
    sw.getPort('GigabitEthernet0/0/4')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:06'), MACAddress.broadcast()));
    expect(hybrid.frames.length).toBe(1);
    expect((hybrid.frames[0] as TaggedEthernetFrame).dot1q?.vid).toBe(100);
  });

  it('a VLAN in neither list does not leave the hybrid port', async () => {
    const sw = await hybridLab();
    await sw.executeCommand('interface GigabitEthernet0/0/5');
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 40');
    await sw.executeCommand('quit');
    sw.setStpVlanState('GigabitEthernet0/0/5', 40, 'forwarding');
    sw.setStpVlanState('GigabitEthernet0/0/1', 40, 'forwarding');

    const hybrid = sniff(sw, 'GigabitEthernet0/0/1');
    sw.getPort('GigabitEthernet0/0/5')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:07'), MACAddress.broadcast()));
    expect(hybrid.frames.length).toBe(0);
  });
});
