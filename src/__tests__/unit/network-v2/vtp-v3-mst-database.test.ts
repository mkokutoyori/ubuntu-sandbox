/**
 * VTP v3 MST database propagation (docs/PRD-VTP.md §3 Phase 2).
 *
 * Real VTP v3 synchronizes an MST region config (name/revision/instance
 * table) between switches in the same domain, independently of the
 * standard VLAN database. This suite configures the MST region on a VTP
 * server and verifies a client adopts the same region without manual
 * reconfiguration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function setupAsServer(sw: CiscoSwitch, domain: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand('vtp version 3');
  await sw.executeCommand('vtp mode server');
  await sw.executeCommand('end');
}

async function setupAsClient(sw: CiscoSwitch, domain: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand('vtp version 3');
  await sw.executeCommand('vtp mode client');
  await sw.executeCommand('end');
}

async function makeTrunk(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('end');
}

async function configureMstRegion(sw: CiscoSwitch, name: string, revision: number): Promise<void> {
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('spanning-tree mode mst');
  await sw.executeCommand('spanning-tree mst configuration');
  await sw.executeCommand(`name ${name}`);
  await sw.executeCommand(`revision ${revision}`);
  await sw.executeCommand('instance 1 vlan 10,20-25');
  await sw.executeCommand('exit');
  await sw.executeCommand('end');
}

describe('VTP v3 — MST database propagation', () => {
  it('a client adopts the server\'s MST region (name/revision/instances) over VTP, with no manual config', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    await configureMstRegion(server, 'REGION-A', 5);

    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');

    const clientRegion = client.getStpAgent().getMstRegion();
    expect(clientRegion.name).toBe('REGION-A');
    expect(clientRegion.revision).toBe(5);
    expect(clientRegion.instances.get(1)).toBe('vlan 10,20-25');
  });

  it('a later region change on the server re-syncs the client automatically', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    await configureMstRegion(server, 'REGION-B', 1);

    expect(client.getStpAgent().getMstRegion().name).toBe('REGION-B');

    await server.executeCommand('configure terminal');
    await server.executeCommand('spanning-tree mst configuration');
    await server.executeCommand('revision 9');
    await server.executeCommand('exit');
    await server.executeCommand('end');

    const clientRegion = client.getStpAgent().getMstRegion();
    expect(clientRegion.revision).toBe(9);
    expect(clientRegion.name).toBe('REGION-B');
  });

  it('the MST database syncs independently of the VLAN database revision counter', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');
    await configureMstRegion(server, 'REGION-C', 2);

    await server.executeCommand('configure terminal');
    await server.executeCommand('vlan 50');
    await server.executeCommand('end');

    expect(client.getVLAN(50), 'VLAN db should still sync').toBeDefined();
    expect(client.getStpAgent().getMstRegion().name).toBe('REGION-C');
    expect(client.getVtpAgent().getConfig().revision).not.toBe(client.getVtpAgent().getConfig().mstDatabaseRevision);
  });

  it('a VTP v1/v2 domain never emits an MST-database frame', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const peer = new CiscoSwitch('switch-cisco', 'Peer', 8);
    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, peer.getPort('FastEthernet0/1')!);
    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('vtp domain LAB');
    await server.executeCommand('vtp mode server');
    await server.executeCommand('end');
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(peer, 'FastEthernet0/1');
    await configureMstRegion(server, 'REGION-D', 3);

    const bus = new EventBus();
    server.setEventBus(bus);
    const sent: { messageType: string }[] = [];
    bus.subscribe('vtp.frame.sent', (e) => sent.push(e.payload as { messageType: string }));
    server.getVtpAgent().advertiseAllTrunks('periodic');

    // v1 (default): only the VLAN database's summary+subset pair, no MST frames.
    expect(sent).toHaveLength(2);
  });
});
