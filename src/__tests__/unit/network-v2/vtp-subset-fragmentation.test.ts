/**
 * VTP Subset Advertisement fragmentation (docs/PRD-VTP.md §3 Phase 1).
 *
 * Real Cisco VTP fragments a Summary's Subset Advertisements once the
 * VLAN base is too large for one frame, numbering each one and telling
 * the receiver up front how many to expect via the Summary's follower
 * count. Most labs here never exceed one lot — this suite is the one
 * that actually builds a base past the threshold.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function setupAsServer(sw: CiscoSwitch, domain: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand('vtp mode server');
  await sw.executeCommand('end');
}

async function setupAsClient(sw: CiscoSwitch, domain: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vtp domain ${domain}`);
  await sw.executeCommand('vtp mode client');
  await sw.executeCommand('end');
}

async function makeTrunk(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('end');
}

/** VLAN1 (always present) + 2..46 = 46 total, i.e. two 40-VLAN lots. */
function growPastOneLot(sw: CiscoSwitch): void {
  for (let id = 2; id <= 46; id++) sw.createVLAN(id);
}

describe('VTP — Subset Advertisement fragmentation', () => {
  it('a base past the 40-VLAN threshold sends one Summary and several numbered Subsets', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const peer = new CiscoSwitch('switch-cisco', 'Peer', 8);
    new Cable('c1').connect(sw.getPort('FastEthernet0/1')!, peer.getPort('FastEthernet0/1')!);
    await setupAsServer(sw, 'LAB');
    await makeTrunk(sw, 'FastEthernet0/1');
    await makeTrunk(peer, 'FastEthernet0/1');
    growPastOneLot(sw);
    sw.getVtpAgent().onLocalVlanChange();

    const bus = new EventBus();
    sw.setEventBus(bus);
    const sent: { messageType: string }[] = [];
    bus.subscribe('vtp.frame.sent', (e) => sent.push(e.payload as { messageType: string }));
    sw.getVtpAgent().advertiseAllTrunks('periodic');

    const summaries = sent.filter(s => s.messageType.startsWith('summary:'));
    const subsets = sent.filter(s => s.messageType.startsWith('subset:'));
    expect(summaries).toHaveLength(1);
    expect(subsets.length).toBeGreaterThan(1);
  });

  it('a base within one lot still sends exactly one Subset (unchanged common case)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const peer = new CiscoSwitch('switch-cisco', 'Peer', 8);
    new Cable('c1').connect(sw.getPort('FastEthernet0/1')!, peer.getPort('FastEthernet0/1')!);
    await setupAsServer(sw, 'LAB');
    await makeTrunk(sw, 'FastEthernet0/1');
    await makeTrunk(peer, 'FastEthernet0/1');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('end');

    const bus = new EventBus();
    sw.setEventBus(bus);
    const sent: { messageType: string }[] = [];
    bus.subscribe('vtp.frame.sent', (e) => sent.push(e.payload as { messageType: string }));
    sw.getVtpAgent().advertiseAllTrunks('periodic');

    expect(sent.filter(s => s.messageType.startsWith('subset:'))).toHaveLength(1);
  });

  it('a client reassembles every fragment before applying the VLAN diff — none are lost', async () => {
    const server = new CiscoSwitch('switch-cisco', 'S1', 8);
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsServer(server, 'LAB');
    await setupAsClient(client, 'LAB');
    growPastOneLot(server);
    server.getVtpAgent().onLocalVlanChange();
    new Cable('c1').connect(server.getPort('FastEthernet0/1')!, client.getPort('FastEthernet0/1')!);
    await makeTrunk(server, 'FastEthernet0/1');
    await makeTrunk(client, 'FastEthernet0/1');

    for (const id of [2, 20, 45, 46]) {
      expect(client.getVLAN(id), `VLAN ${id} should have synced`).toBeDefined();
    }
    expect(client.getVtpAgent().getConfig().revision).toBe(server.getVtpAgent().getConfig().revision);
  });

  it('a partial (never-completed) fragment set does not corrupt the local VLAN database', async () => {
    const client = new CiscoSwitch('switch-cisco', 'S2', 8);
    await setupAsClient(client, 'LAB');
    await makeTrunk(client, 'FastEthernet0/1');
    client.createVLAN(99, 'preexisting');
    const agent = client.getVtpAgent();

    agent.handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('01:00:0c:cc:cc:cc'),
      etherType: 0x2003,
      payload: {
        type: 'vtp', version: 1, messageType: 'summary',
        domain: 'LAB', revision: 5, updater: '10.0.0.1', updateTimestamp: Date.now(),
        followers: 2, passwordHash: '', vlans: [],
      },
    });
    agent.handleFrame('FastEthernet0/1', {
      srcMAC: new MACAddress('00:11:22:33:44:55'),
      dstMAC: new MACAddress('01:00:0c:cc:cc:cc'),
      etherType: 0x2003,
      payload: {
        type: 'vtp', version: 1, messageType: 'subset',
        domain: 'LAB', revision: 5, updater: '10.0.0.1', updateTimestamp: Date.now(),
        sequenceNumber: 1, passwordHash: '',
        vlans: [{ id: 55, name: 'partial-lot', mtu: 1500, type: 'ethernet' }],
      },
    });

    expect(client.getVLAN(99)).toBeDefined();
    expect(client.getVLAN(55)).toBeUndefined();
    expect(agent.getConfig().revision).toBe(0);
  });
});
