/**
 * TDD — Cisco switchport extras, VLAN range/list, EtherChannel, related
 * show commands (L2-only, switch-specific). From cisco-vlan-interface.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function cfg(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  return sw;
}

describe('Cisco VLAN range / list', () => {
  it('vlan 30-35 and vlan 100,200,300 create multiple VLANs', async () => {
    const sw = await cfg();
    expect(await sw.executeCommand('vlan 30-35')).not.toMatch(/Invalid input/);
    expect(await sw.executeCommand('vlan 100,200,300')).not.toMatch(/Invalid input/);
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show vlan brief');
    for (const v of ['30', '35', '100', '200', '300']) expect(out).toContain(v);
  });
});

describe('Cisco switchport extras', () => {
  it('trunk encapsulation / nonegotiate / voice / port-security recognized', async () => {
    const sw = await cfg();
    await sw.executeCommand('interface GigabitEthernet0/1');
    for (const c of ['switchport trunk encapsulation dot1q',
      'switchport mode trunk', 'switchport nonegotiate',
      'switchport trunk allowed vlan add 200']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode access');
    for (const c of ['switchport voice vlan 50', 'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security violation shutdown',
      'switchport port-security mac-address sticky']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    const out = await sw.executeCommand('do show running-config interface FastEthernet0/2');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('port-security');
  });
});

describe('Cisco EtherChannel', () => {
  it('channel-group + Port-channel + show etherchannel summary', async () => {
    const sw = await cfg();
    await sw.executeCommand('interface FastEthernet0/21');
    expect(await sw.executeCommand('channel-group 1 mode active'))
      .not.toMatch(/Invalid input|Unrecognized/);
    await sw.executeCommand('exit');
    expect(await sw.executeCommand('interface Port-channel1'))
      .not.toMatch(/Invalid input|Unrecognized/);
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('end');
    expect(await sw.executeCommand('show etherchannel summary'))
      .not.toMatch(/Invalid input/);
  });
});

describe('Cisco L2 show commands', () => {
  it('show interfaces switchport / trunk / mac vlan recognized', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    await sw.executeCommand('enable');
    for (const c of ['show interfaces FastEthernet0/1 switchport',
      'show interfaces trunk', 'show mac address-table vlan 10']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
  });
});
