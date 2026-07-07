import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Voice VLAN — Cisco CDP auto-config TLV', () => {
  it('a switch port with a voice VLAN advertises it in its CDP TLV so a peer can auto-configure', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await sw1.executeCommand('enable');
    await sw1.executeCommand('configure terminal');
    await sw1.executeCommand('interface FastEthernet0/1');
    await sw1.executeCommand('switchport mode access');
    await sw1.executeCommand('switchport access vlan 10');
    await sw1.executeCommand('switchport voice vlan 100');
    await sw1.executeCommand('end');

    new Cable('w').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    const nbr = sw2.getCdpAgent().getNeighbors().find(n => n.remoteHost === 'SW1');
    expect(nbr).toBeDefined();
    expect(nbr!.remoteVoiceVlan).toBe(100);
  });

  it('a port with no voice VLAN configured advertises no voice VLAN TLV — unaffected', async () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    new Cable('w').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    const nbr = sw2.getCdpAgent().getNeighbors().find(n => n.remoteHost === 'SW1');
    expect(nbr).toBeDefined();
    expect(nbr!.remoteVoiceVlan).toBeUndefined();
  });
});
