/**
 * resolveAcrossTransparentDevices (rapport 00 synthesis, item #23).
 *
 * Extracted shared replacement for the "look at a switch's other ports
 * for one more hop" fragment duplicated 5 times across
 * RouterOSPFIntegration.ts's collectOSPFDomain/collectOSPFv3Domain/
 * collectV3CandidateRouters/findNextHopTo — each hardcoded to exactly
 * one extra hop, so none of them saw past a second chained switch.
 * These tests exercise the primitive directly, independent of OSPF.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resolveAcrossTransparentDevices } from '@/network/equipment/TopologyWalk';
import type { Equipment } from '@/network/equipment/Equipment';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

/** Matches by device name — stands in for "has an OSPF engine" etc. */
function named(name: string) {
  return (e: Equipment) => e.getName() === name;
}

describe('resolveAcrossTransparentDevices', () => {
  it('finds a direct neighbor with no switch in between', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    new Cable('c1').connect(a.getPorts()[0], b.getPorts()[0]);

    const hits = resolveAcrossTransparentDevices(a.getPorts()[0].getCable()!.getPortB()!, named('B'));
    expect(hits).toHaveLength(1);
    expect(hits[0].device.getName()).toBe('B');
  });

  it('finds a match behind a single switch (the case that already worked)', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!; // SW1's port facing A
    const hits = resolveAcrossTransparentDevices(entryPort, named('B'));
    expect(hits).toHaveLength(1);
    expect(hits[0].device.getName()).toBe('B');
    expect(hits[0].port.getEquipmentId()).toBe(b.getId());
  });

  it('finds a match behind TWO chained switches — the bug this replaces', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const sw1 = new GenericSwitch('switch-generic', 'SW1');
    const sw2 = new GenericSwitch('switch-generic', 'SW2');
    new Cable('c-a-sw1').connect(a.getPorts()[0], sw1.getPorts()[0]);
    new Cable('c-sw1-sw2').connect(sw1.getPorts()[1], sw2.getPorts()[0]);
    new Cable('c-sw2-b').connect(sw2.getPorts()[1], b.getPorts()[0]);

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!; // SW1's port facing A
    const hits = resolveAcrossTransparentDevices(entryPort, named('B'));
    expect(hits).toHaveLength(1);
    expect(hits[0].device.getName()).toBe('B');
  });

  it('finds a match behind a longer chain (three switches — arbitrary depth, not "one more hop")', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const sw1 = new GenericSwitch('switch-generic', 'SW1');
    const sw2 = new GenericSwitch('switch-generic', 'SW2');
    const sw3 = new GenericSwitch('switch-generic', 'SW3');
    new Cable('c-a-sw1').connect(a.getPorts()[0], sw1.getPorts()[0]);
    new Cable('c-sw1-sw2').connect(sw1.getPorts()[1], sw2.getPorts()[0]);
    new Cable('c-sw2-sw3').connect(sw2.getPorts()[1], sw3.getPorts()[0]);
    new Cable('c-sw3-b').connect(sw3.getPorts()[1], b.getPorts()[0]);

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!;
    const hits = resolveAcrossTransparentDevices(entryPort, named('B'));
    expect(hits).toHaveLength(1);
    expect(hits[0].device.getName()).toBe('B');
  });

  it('collects every match reached through a fan-out switch, not just the first', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const c = new LinuxPC('linux-pc', 'C');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-a').connect(a.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-b').connect(b.getPorts()[0], sw.getPorts()[1]);
    new Cable('c-c').connect(c.getPorts()[0], sw.getPorts()[2]);

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!;
    const hits = resolveAcrossTransparentDevices(entryPort, e => e.getName() === 'B' || e.getName() === 'C');
    expect(hits.map(h => h.device.getName()).sort()).toEqual(['B', 'C']);
  });

  it('does not collect non-matching devices, only transparently walks through them', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const sw1 = new GenericSwitch('switch-generic', 'SW1');
    const sw2 = new GenericSwitch('switch-generic', 'SW2');
    new Cable('c-a-sw1').connect(a.getPorts()[0], sw1.getPorts()[0]);
    new Cable('c-sw1-sw2').connect(sw1.getPorts()[1], sw2.getPorts()[0]);
    new Cable('c-sw2-b').connect(sw2.getPorts()[1], b.getPorts()[0]);

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!;
    const hits = resolveAcrossTransparentDevices(entryPort, named('B'));
    expect(hits.some(h => h.device.getName() === 'SW1' || h.device.getName() === 'SW2')).toBe(false);
  });

  it('does not loop forever on a redundant (looped) switch topology', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const sw1 = new GenericSwitch('switch-generic', 'SW1');
    const sw2 = new GenericSwitch('switch-generic', 'SW2');
    new Cable('c-a-sw1').connect(a.getPorts()[0], sw1.getPorts()[0]);
    new Cable('c-sw2-b').connect(sw2.getPorts()[0], b.getPorts()[0]);
    // Two parallel links between SW1 and SW2 — a loop.
    new Cable('c-sw1-sw2-1').connect(sw1.getPorts()[1], sw2.getPorts()[1]);
    new Cable('c-sw1-sw2-2').connect(sw1.getPorts()[2], sw2.getPorts()[2]);

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!;
    const hits = resolveAcrossTransparentDevices(entryPort, named('B'));
    expect(hits).toHaveLength(1);
    expect(hits[0].device.getName()).toBe('B');
  });

  it('returns nothing when no cabled path leads to a match', () => {
    const a = new LinuxPC('linux-pc', 'A');
    const b = new LinuxPC('linux-pc', 'B');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-a').connect(a.getPorts()[0], sw.getPorts()[0]);
    // B exists but isn't cabled to anything.

    const entryPort = a.getPorts()[0].getCable()!.getPortB()!;
    const hits = resolveAcrossTransparentDevices(entryPort, named('B'));
    expect(hits).toHaveLength(0);
    void b;
  });
});
