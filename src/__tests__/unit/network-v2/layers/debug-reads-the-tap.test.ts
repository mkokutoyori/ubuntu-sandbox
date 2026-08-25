/**
 * PRD-Suppression-Bus-Partage increment 2 — `debug` reads the tap.
 *
 * Written BLIND. Two debug services subscribe to `port.frame.received`
 * on a bus: `devices/router/diag/RouterDebugService.ts` and
 * `devices/router/diag/HuaweiDebugService.ts`. They are the last frame
 * readers outside the capture, which increment 1 moved.
 *
 * What a debug service does is exactly what a tap is for: it watches the
 * frames of ITS OWN machine and prints them. Nothing about it needs a
 * shared object, and on a real router `debug` is a kernel-side hook on
 * the forwarding path, not a subscription to a network-wide feed.
 *
 * The behavioural cases pin what must NOT change — the operator still
 * sees the line — and the structural ones are the guard the BRD asks to
 * grow: no frame reader anywhere but the tap.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MACAddress, IPAddress, ETHERTYPE_ARP, resetCounters,
  type ARPPacket, type EthernetFrame,
} from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const DEBUG_SERVICES = [
  'src/network/devices/router/diag/RouterDebugService.ts',
  'src/network/devices/router/diag/HuaweiDebugService.ts',
];

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function lab() {
  const router = new CiscoRouter('R1', 0, 0);
  const peer = new LinuxPC('linux-pc', 'PC', -150, 0);
  peer.powerOn();
  new Cable('c1').connect(peer.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  for (const line of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await router.executeCommand(line);
  return { router, peer };
}

function arpRequest(peer: LinuxPC): EthernetFrame {
  const arp: ARPPacket = {
    type: 'arp',
    operation: 'request',
    senderMAC: peer.getPort('eth0')!.getMAC(),
    senderIP: new IPAddress('10.0.0.9'),
    targetMAC: new MACAddress('00:00:00:00:00:00'),
    targetIP: new IPAddress('10.0.0.1'),
  };
  return {
    srcMAC: peer.getPort('eth0')!.getMAC(),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_ARP,
    payload: arp,
  };
}

describe('an operator still sees what debug promises', () => {
  it('a frame reaching the router is observable while debugging', async () => {
    const { router, peer } = await lab();
    const seen: string[] = [];
    router.attachCapture(tapped => seen.push(tapped.direction));

    router.getPort('GigabitEthernet0/0')!.receiveFrame(arpRequest(peer));

    expect(seen).toContain('in');
  });

  it('the router own reply is observable too', async () => {
    const { router, peer } = await lab();
    const seen: string[] = [];
    router.attachCapture(tapped => seen.push(tapped.direction));

    router.getPort('GigabitEthernet0/0')!.receiveFrame(arpRequest(peer));

    expect(seen).toContain('out');
  });
});

describe('no frame reader is left on a bus', () => {
  it('a debug service no longer subscribes to a frame topic', () => {
    const offenders = DEBUG_SERVICES.filter(path =>
      /subscribe(Where)?\('port\.frame\./.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('no production file outside the tap reads a frame topic', () => {
    const offenders = [
      'src/network/devices/LinuxMachine.ts',
      ...DEBUG_SERVICES,
    ].filter(path => /'port\.frame\.received'/.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
