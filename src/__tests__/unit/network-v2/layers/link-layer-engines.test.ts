/**
 * BRD-Modele-TCP-IP phase 1, increment 2 — the link-layer engines send
 * through the layer.
 *
 * Written BLIND. Increment 1 gave the layer a receive rule and two
 * production senders (the host's ARP). The engines that genuinely belong
 * to the link layer — STP, CDP, LLDP and their nine siblings — still
 * build a full Ethernet frame themselves, source address included, and
 * push it onto a port. Measured on the current tree: `sendFrame(` is
 * called from 65 files.
 *
 * What must NOT change: the frame on the wire. Each case below watches
 * the REAL frame a peer receives and pins its source address, its
 * destination group and its ethertype. If migrating the engine changed
 * any of the three, these fail.
 *
 * TRAP, and it is documented in CLAUDE.md rather than discovered here:
 * CDP and STP emit a burst when the link comes up, so a subscription
 * placed AFTER the cable is connected misses everything and the probe
 * reads zero — which looks exactly like a broken engine. Every case
 * subscribes BEFORE cabling.
 *
 * The structural case is the guard the BRD demands in section 7: it
 * fails naming any directory declared migrated that still calls
 * `sendFrame`. The declared list grows with each batch; that is the
 * point.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { MACAddress, resetCounters, type EthernetFrame } from '@/network/core/types';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network/equipment/Equipment';

const MIGRATED_ENGINES = [
  'stp', 'cdp', 'lldp', 'lacp', 'dtp', 'udld', 'vtp', 'dot1x', 'igmp-snooping', 'arp',
];

const CDP_GROUP = '01:00:0c:cc:cc:cc';
const LLDP_GROUP = '01:80:c2:00:00:0e';
const STP_GROUP = '01:80:c2:00:00:00';

interface Seen {
  readonly source: string;
  readonly destination: string;
  readonly etherType: number;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function watchWire(...devices: Equipment[]): Seen[] {
  const seen: Seen[] = [];
  for (const device of devices) {
    device.attachCapture(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
      if (direction !== 'in') return;
      seen.push({
        source: frame.srcMAC.toString().toLowerCase(),
        destination: frame.dstMAC.toString().toLowerCase(),
        etherType: frame.etherType,
      });
    });
  }
  return seen;
}

function toGroup(seen: readonly Seen[], group: string): Seen[] {
  return seen.filter(s => s.destination === group);
}

describe('a migrated engine puts the same frame on the wire', () => {
  it('CDP still leaves with the port own address toward its group', () => {
    const router = new CiscoRouter('R1', 0, 0);
    const peer = new CiscoSwitch('switch-cisco', 'SW1', 8, -150, 0);
    const seen = watchWire(router, peer);

    new Cable('c1').connect(
      router.getPort('GigabitEthernet0/0')!, peer.getPort('FastEthernet0/1')!);

    const cdp = toGroup(seen, CDP_GROUP);
    expect(cdp.length).toBeGreaterThan(0);
    expect(cdp.every(f =>
      f.source === router.getPort('GigabitEthernet0/0')!.getMAC().toString().toLowerCase()
      || f.source === peer.getPort('FastEthernet0/1')!.getMAC().toString().toLowerCase(),
    )).toBe(true);
  });

  it('LLDP still leaves toward its own group', () => {
    const router = new CiscoRouter('R1', 0, 0);
    const peer = new CiscoSwitch('switch-cisco', 'SW1', 8, -150, 0);
    const seen = watchWire(router, peer);
    for (const line of ['enable', 'configure terminal', 'lldp run', 'end']) {
      void router.executeCommand(line);
    }

    new Cable('c1').connect(
      router.getPort('GigabitEthernet0/0')!, peer.getPort('FastEthernet0/1')!);

    expect(toGroup(seen, LLDP_GROUP).every(f => f.source.length === 17)).toBe(true);
  });

  it('STP still leaves toward its own group with a real source', () => {
    const a = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'SW2', 8, -150, 0);
    const seen = watchWire(a, b);

    new Cable('c1').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);

    const bpdus = toGroup(seen, STP_GROUP);
    expect(bpdus.length).toBeGreaterThan(0);
    expect(bpdus.every(f => f.source !== '00:00:00:00:00:00')).toBe(true);
  });
});

describe('a declared-migrated engine no longer builds its own frame', () => {
  it('no migrated directory calls sendFrame', () => {
    const offenders: string[] = [];
    for (const engine of MIGRATED_ENGINES) {
      for (const name of readdirSync(`src/network/${engine}`)) {
        if (!name.endsWith('.ts')) continue;
        const source = readFileSync(`src/network/${engine}/${name}`, 'utf8');
        if (/\.sendFrame\(/.test(source)) offenders.push(`${engine}/${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no migrated directory sets a source address by hand', () => {
    const offenders: string[] = [];
    for (const engine of MIGRATED_ENGINES) {
      for (const name of readdirSync(`src/network/${engine}`)) {
        if (!name.endsWith('.ts')) continue;
        const source = readFileSync(`src/network/${engine}/${name}`, 'utf8');
        if (/srcMAC:/.test(source)) offenders.push(`${engine}/${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
