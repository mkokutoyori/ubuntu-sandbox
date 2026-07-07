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

async function trunkPort(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('end');
}

describe('VTP — syncing must not wait for the next server-side VLAN change', () => {
  it('GUI order — cable first, then configure: trunking the ports completes the sync', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    new Cable('w').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vtp domain LAB');
    await server.executeCommand('vlan 10');
    await server.executeCommand('exit');
    await server.executeCommand('vlan 20');
    await server.executeCommand('end');

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('vtp mode client');
    await client.executeCommand('vtp domain LAB');
    await client.executeCommand('end');

    await trunkPort(server, 'FastEthernet0/1');
    await trunkPort(client, 'FastEthernet0/1');

    expect(client.getVLAN(10)).toBeDefined();
    expect(client.getVLAN(20)).toBeDefined();
  });

  it('a client that corrects a wrong domain pulls the database immediately', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vtp domain LAB');
    await server.executeCommand('vlan 10');
    await server.executeCommand('end');
    await trunkPort(server, 'FastEthernet0/1');

    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('vtp mode client');
    await client.executeCommand('vtp domain WRONG');
    await client.executeCommand('end');
    await trunkPort(client, 'FastEthernet0/1');

    new Cable('w').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    expect(client.getVLAN(10)).toBeUndefined();

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('vtp domain LAB');
    await client.executeCommand('end');

    expect(client.getVLAN(10)).toBeDefined();
  });

  it('a late server joining an established domain pulls the higher-revision database on trunking', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const late = new CiscoSwitch('switch-cisco', 'S3', 8);
    new Cable('w').connect(server.getPort('FastEthernet0/1')!, late.getPort('FastEthernet0/1')!);

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vtp domain LAB');
    await server.executeCommand('vlan 10');
    await server.executeCommand('end');

    await late.executeCommand('enable');
    await late.executeCommand('configure terminal');
    await late.executeCommand('vtp domain LAB');
    await late.executeCommand('end');

    await trunkPort(server, 'FastEthernet0/1');
    await trunkPort(late, 'FastEthernet0/1');

    expect(late.getVLAN(10)).toBeDefined();
  });
});
