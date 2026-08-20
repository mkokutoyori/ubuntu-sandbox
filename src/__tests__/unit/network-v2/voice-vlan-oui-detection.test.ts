import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import type { EthernetFrame } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

function untaggedFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

async function huaweiAutoVoicePort(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
  await sw.executeCommand('system-view');
  await sw.executeCommand('voice-vlan mac-address 0013-2049-0000 mask ffff-ff00-0000');
  await sw.executeCommand('vlan batch 10 100');
  await sw.executeCommand('interface GigabitEthernet0/0/1');
  await sw.executeCommand('port link-type access');
  await sw.executeCommand('port default vlan 10');
  await sw.executeCommand('voice-vlan 100 enable');
  await sw.executeCommand('voice-vlan mode auto');
  await sw.executeCommand('quit');
  sw.setStpVlanState('GigabitEthernet0/0/1', 10, 'forwarding');
  sw.setStpVlanState('GigabitEthernet0/0/1', 100, 'forwarding');
  return sw;
}

describe('Voice VLAN — Huawei OUI auto-detection', () => {
  it('an untagged frame from a MAC matching the recognized OUI joins the voice VLAN automatically', async () => {
    const sw = await huaweiAutoVoicePort();
    const phoneMac = new MACAddress('00:13:20:aa:bb:cc');
    const dst = new MACAddress('aa:bb:cc:00:00:01');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(untaggedFrame(phoneMac, dst));

    const entry = sw.getMACTable().find(e => e.mac === phoneMac.toString().toLowerCase());
    expect(entry).toBeDefined();
    expect(entry!.vlan).toBe(100);
  });

  it('an untagged frame from a MAC not matching any recognized OUI stays on the data VLAN', async () => {
    const sw = await huaweiAutoVoicePort();
    const pcMac = new MACAddress('aa:bb:cc:11:22:33');
    const dst = new MACAddress('aa:bb:cc:00:00:02');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(untaggedFrame(pcMac, dst));

    const entry = sw.getMACTable().find(e => e.mac === pcMac.toString().toLowerCase());
    expect(entry).toBeDefined();
    expect(entry!.vlan).toBe(10);
  });

  it('OUI auto-detection is inert without "voice-vlan mode auto" (manual mode) — unaffected', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('voice-vlan mac-address 0013-2049-0000 mask ffff-ff00-0000');
    await sw.executeCommand('vlan batch 10 100');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 10');
    await sw.executeCommand('voice-vlan 100 enable');
    await sw.executeCommand('quit');
    sw.setStpVlanState('GigabitEthernet0/0/1', 10, 'forwarding');
    sw.setStpVlanState('GigabitEthernet0/0/1', 100, 'forwarding');

    const phoneMac = new MACAddress('00:13:20:aa:bb:cc');
    const dst = new MACAddress('aa:bb:cc:00:00:03');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(untaggedFrame(phoneMac, dst));

    const entry = sw.getMACTable().find(e => e.mac === phoneMac.toString().toLowerCase());
    expect(entry).toBeDefined();
    expect(entry!.vlan).toBe(10);
  });
});
