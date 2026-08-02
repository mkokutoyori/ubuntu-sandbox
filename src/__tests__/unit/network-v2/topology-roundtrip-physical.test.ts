/**
 * What a saved topology owes the lab it describes.
 *
 * Three whole families of state used to be dropped on the way through a
 * save/open, each of them the point of some lab:
 *
 *   - the NIC's address. Every import re-drew MACs from the generator, so
 *     a saved static ARP entry, a sticky port-security address or a DHCP
 *     reservation came back naming hardware that no longer existed. It
 *     did not always show: with the devices in their original order the
 *     generator happened to hand out the same sequence. Reorder them —
 *     which the store does as soon as a device is deleted and re-added —
 *     and the file and the machine disagreed.
 *   - what was done TO a cable. Only its two endpoints were saved, so a
 *     lab built to demonstrate a degraded link (docs/PRD-Pannes.md §F5)
 *     reloaded as a perfect one.
 *   - a port's physical layer. MTU, speed, duplex and the rest were never
 *     written down. A router recovers some of it by replaying its
 *     running-config; a Linux or Windows host has no config text, so for
 *     those nothing came back at all.
 *   - a Windows machine's filesystem. The capture was gated on
 *     `instanceof LinuxMachine`, so anything a lab put on a Windows host
 *     was dropped without a word.
 *
 * Everything below round-trips a real topology through the real
 * exporter/importer and then asks the restored machines, not the JSON.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { buildConnection, type Connection } from '@/store/networkStore';
import type { Equipment } from '@/network/equipment/Equipment';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** Save and reopen, exactly as the UI does — through JSON, not by reference. */
async function roundTrip(
  devices: Equipment[],
  connections: Connection[],
): Promise<Map<string, Equipment>> {
  const instances = new Map<string, Equipment>(devices.map((d) => [d.getId(), d]));
  const json = exportTopology('lab', instances, connections);
  const reopened = await importTopology(JSON.parse(JSON.stringify(json)));
  return reopened.deviceInstances;
}

const byName = (m: Map<string, Equipment>, name: string): Equipment =>
  [...m.values()].find((d) => d.getName() === name)!;

describe('a reloaded NIC keeps the address it had', () => {
  it('every interface comes back with its own MAC', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const before = pc.getPorts()[0].getMAC().toString();

    // Reversed on purpose: the generator issues addresses in creation
    // order, so a different order is exactly what used to reassign them.
    const back = await roundTrip([sw, pc], []);

    expect((byName(back, 'PC1') as LinuxPC).getPorts()[0].getMAC().toString()).toBe(before);
  });

  it('a static ARP entry still names a real NIC after reloading', async () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
    b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
    new Cable('c1').connect(a.getPorts()[0], b.getPorts()[0]);
    await a.executeCommand(`sudo arp -s 10.0.0.2 ${b.getPorts()[0].getMAC().toString()}`);

    const back = await roundTrip([b, a], []);
    const a2 = byName(back, 'A') as LinuxPC;
    const b2 = byName(back, 'B') as LinuxPC;

    // The saved table and the reloaded hardware must agree; a table
    // pointing at an address nobody owns is worse than an empty one,
    // because it silently blackholes.
    expect(await a2.executeCommand('arp -n'))
      .toContain(b2.getPorts()[0].getMAC().toString());
  });

  it('an address added after reloading does not collide with a restored one', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    // Push this NIC's address well past what a small topology would
    // consume, the way a session that created and deleted devices does.
    const high = new MACAddress('02:00:00:00:07:d0');
    pc.getPorts()[0].setMAC(high);

    const back = await roundTrip([pc], []);
    const fresh = new LinuxPC('linux-pc', 'LATER');

    expect(fresh.getPorts()[0].getMAC().toString()).not.toBe(high.toString());
    expect((byName(back, 'PC1') as LinuxPC).getPorts()[0].getMAC().toString())
      .toBe(high.toString());
  });
});

describe('a reloaded cable is as degraded as it was', () => {
  async function lossyLab(): Promise<Cable | null> {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
    // The store owns the cable: `buildConnection` makes it. Configuring a
    // separate one would degrade a link the topology does not contain.
    const conn = buildConnection(pc, 'eth0', sw, sw.getPorts()[0].getName(), 'ethernet')!;
    conn.cable.setPacketLossRate(0.25);
    conn.cable.setCorruptionRate(0.1);
    conn.cable.setArtificialDelayMs(40);
    const back = await roundTrip([pc, sw], [conn]);
    return (byName(back, 'PC1') as LinuxPC).getPorts()[0].getCable();
  }

  it('loss, corruption and latency all survive', async () => {
    const cable = await lossyLab();

    expect(cable).not.toBeNull();
    expect(cable!.getPacketLossRate()).toBe(0.25);
    expect(cable!.getCorruptionRate()).toBe(0.1);
    expect(cable!.getArtificialDelayMs()).toBe(40);
  });

  it('a cable left administratively down comes back down', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const conn = buildConnection(pc, 'eth0', sw, sw.getPorts()[0].getName(), 'ethernet')!;
    conn.cable.setUp(false);
    const back = await roundTrip([pc, sw], [conn]);

    expect((byName(back, 'PC1') as LinuxPC).getPorts()[0].getCable()?.getIsUp()).toBe(false);
  });

  it('a pristine cable adds nothing to the file', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const conn = buildConnection(pc, 'eth0', sw, sw.getPorts()[0].getName(), 'ethernet')!;

    const json = exportTopology('lab', new Map<string, Equipment>([[pc.getId(), pc], [sw.getId(), sw]]), [conn]);

    // An operator opening the file should see what was configured, not a
    // dump of every field's factory value.
    expect(Object.keys(json.connections[0]))
      .toEqual(['sourceDeviceId', 'sourceInterfaceId', 'targetDeviceId', 'targetInterfaceId', 'type']);
  });
});

describe('a reloaded port keeps its physical layer', () => {
  it('MTU, speed and duplex survive on a host with no config text', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getPorts()[0].setMTU(1400);
    pc.getPorts()[0].setSpeed(10);
    pc.getPorts()[0].setDuplex('half');

    const back = await roundTrip([pc], []);
    const port = (byName(back, 'PC1') as LinuxPC).getPorts()[0];

    expect(port.getMTU()).toBe(1400);
    expect(port.getSpeed()).toBe(10);
    expect(port.getDuplex()).toBe('half');
  });

  it('bandwidth and delay survive too', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getPorts()[0].setBandwidthKbps(64);
    pc.getPorts()[0].setDelayUs(20000);

    const back = await roundTrip([pc], []);
    const port = (byName(back, 'PC1') as LinuxPC).getPorts()[0];

    expect(port.getBandwidthKbps()).toBe(64);
    expect(port.getDelayUs()).toBe(20000);
  });

  it('an untouched port writes only its name, address and IP', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);

    const json = exportTopology('lab', new Map<string, Equipment>([[pc.getId(), pc]]), []);

    expect(Object.keys(json.devices[0].interfaces[0]).sort())
      .toEqual(['ipAddress', 'mac', 'name', 'subnetMask']);
  });
});

describe('a reloaded Windows host keeps its files', () => {
  it('a file created on C: comes back', async () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    await win.executeCommand('mkdir C:\\lab');
    await win.executeCommand('echo hello > C:\\lab\\notes.txt');

    const back = await roundTrip([win], []);
    const win2 = byName(back, 'WIN') as WindowsPC;

    expect(await win2.executeCommand('type C:\\lab\\notes.txt')).toContain('hello');
  });

  it('the host keeps its ssh identity across a reload', async () => {
    const win = new WindowsPC('windows-pc', 'WIN');
    const before = win.getFileSystem().readFile('C:\\ProgramData\\ssh\\ssh_host_ed25519_key');
    expect(before.ok, 'the machine boots with a host key').toBe(true);

    const back = await roundTrip([win], []);
    const win2 = byName(back, 'WIN') as WindowsPC;

    // A host key regenerated on every open would make a client that had
    // already accepted this machine cry MITM the next time the lab is
    // opened — the same reason the Linux side keeps `/etc/ssh/*`.
    expect(win2.getFileSystem().readFile('C:\\ProgramData\\ssh\\ssh_host_ed25519_key').content)
      .toBe(before.content);
  });

  it('the image the machine boots with is not written out twice', async () => {
    const win = new WindowsPC('windows-pc', 'WIN');

    const json = exportTopology('lab', new Map<string, Equipment>([[win.getId(), win]]), []);

    // The baseline is a bare `WindowsFileSystem`, the same rule the Linux
    // capture uses: what the DEVICE wrote while booting counts as its
    // state and is kept, what the FILESYSTEM ships with is skipped. So a
    // fresh host carries its handful of boot artefacts and not the whole
    // C: tree.
    expect((json.devices[0].files ?? []).length).toBeLessThan(20);
    expect((json.devices[0].files ?? []).some((f) => f.path.includes('ssh_host'))).toBe(true);
  });
});
