/**
 * L2 loop guard — audit 04, constat critique §3.2.
 *
 * Frame delivery is synchronous (Cable.transmit → Port.receiveFrame →
 * handleFrame → sendFrame → Cable.transmit …). A physical loop between
 * two switches with no STP agent (GenericSwitch starts its ports
 * 'forwarding' and never blocks) used to recurse until
 * `RangeError: Maximum call stack size exceeded`, killing the browser
 * tab. The guard must suppress the storm without breaking legitimate
 * loop-free flooding.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Hub } from '@/network/devices/Hub';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import { getDefaultEventBus } from '@/events/EventBus';
import { MACAddress, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function broadcastFrame(src: MACAddress): EthernetFrame {
  return {
    srcMAC: src,
    dstMAC: MACAddress.broadcast(),
    etherType: 0x0800,
    payload: {},
  };
}

describe('L2 loop between two GenericSwitch (no STP agent)', () => {
  it('a broadcast into a two-cable loop does not blow the call stack', () => {
    const swA = new GenericSwitch('switch-generic', 'SWA', 4);
    const swB = new GenericSwitch('switch-generic', 'SWB', 4);

    // The audit's reproduction: two parallel cables = physical loop.
    new Cable('loop-1').connect(swA.getPort('eth0')!, swB.getPort('eth0')!);
    new Cable('loop-2').connect(swA.getPort('eth1')!, swB.getPort('eth1')!);

    const host = new Port('host-nic');
    new Cable('host-link').connect(host, swA.getPort('eth2')!);

    expect(() => host.sendFrame(broadcastFrame(host.getMAC()))).not.toThrow();
  });

  it('the suppressed storm is reported on the bus as lost frames', () => {
    const swA = new GenericSwitch('switch-generic', 'SWA', 4);
    const swB = new GenericSwitch('switch-generic', 'SWB', 4);
    new Cable('loop-1').connect(swA.getPort('eth0')!, swB.getPort('eth0')!);
    new Cable('loop-2').connect(swA.getPort('eth1')!, swB.getPort('eth1')!);
    const host = new Port('host-nic');
    new Cable('host-link').connect(host, swA.getPort('eth2')!);

    const lostReasons: string[] = [];
    getDefaultEventBus().subscribe('cable.frame.lost', (evt) => {
      const p = evt.payload as { reason?: string };
      if (p.reason) lostReasons.push(p.reason);
    });

    host.sendFrame(broadcastFrame(host.getMAC()));
    expect(lostReasons).toContain('l2-loop-suppressed');
  });

  it('a three-cable mesh loop (cloning egress paths) also terminates', () => {
    const swA = new GenericSwitch('switch-generic', 'SWA', 5);
    const swB = new GenericSwitch('switch-generic', 'SWB', 5);
    new Cable('m1').connect(swA.getPort('eth0')!, swB.getPort('eth0')!);
    new Cable('m2').connect(swA.getPort('eth1')!, swB.getPort('eth1')!);
    new Cable('m3').connect(swA.getPort('eth2')!, swB.getPort('eth2')!);
    const host = new Port('host-nic');
    new Cable('host-link').connect(host, swA.getPort('eth3')!);

    expect(() => host.sendFrame(broadcastFrame(host.getMAC()))).not.toThrow();
  });
});

describe('L2 loop between two Hubs', () => {
  it('two hubs double-cabled do not blow the call stack on a broadcast', () => {
    const hubA = new Hub('HUBA', 4);
    const hubB = new Hub('HUBB', 4);
    new Cable('h1').connect(hubA.getPort('eth0')!, hubB.getPort('eth0')!);
    new Cable('h2').connect(hubA.getPort('eth1')!, hubB.getPort('eth1')!);
    const host = new Port('host-nic');
    new Cable('host-link').connect(host, hubA.getPort('eth2')!);

    expect(() => host.sendFrame(broadcastFrame(host.getMAC()))).not.toThrow();
  });
});

describe('legitimate loop-free flooding is untouched', () => {
  it('a broadcast still floods across a chain of three switches', () => {
    const s1 = new GenericSwitch('switch-generic', 'S1', 4);
    const s2 = new GenericSwitch('switch-generic', 'S2', 4);
    const s3 = new GenericSwitch('switch-generic', 'S3', 4);
    new Cable('c12').connect(s1.getPort('eth0')!, s2.getPort('eth0')!);
    new Cable('c23').connect(s2.getPort('eth1')!, s3.getPort('eth0')!);

    const sender = new Port('sender-nic');
    const receiver = new Port('receiver-nic');
    new Cable('cs').connect(sender, s1.getPort('eth1')!);
    new Cable('cr').connect(receiver, s3.getPort('eth1')!);

    const before = receiver.getCounters().framesIn;
    sender.sendFrame(broadcastFrame(sender.getMAC()));
    expect(receiver.getCounters().framesIn).toBe(before + 1);
  });

  it('consecutive sends each get a fresh budget (no leakage across cascades)', () => {
    const s1 = new GenericSwitch('switch-generic', 'S1', 4);
    const sender = new Port('sender-nic');
    const receiver = new Port('receiver-nic');
    new Cable('cs').connect(sender, s1.getPort('eth0')!);
    new Cable('cr').connect(receiver, s1.getPort('eth1')!);

    const before = receiver.getCounters().framesIn;
    for (let i = 0; i < 50; i++) {
      sender.sendFrame(broadcastFrame(sender.getMAC()));
    }
    expect(receiver.getCounters().framesIn).toBe(before + 50);
  });
});
