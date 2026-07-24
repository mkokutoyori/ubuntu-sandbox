import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function pair(): { a: Port; b: Port; cable: Cable } {
  const a = new Port('eth0', 'ethernet');
  const b = new Port('eth0', 'ethernet');
  a.setEquipmentId('A');
  b.setEquipmentId('B');
  const cable = new Cable('c1');
  cable.connect(a, b);
  return { a, b, cable };
}

describe('Port carrier (docs/PRD-Link-State.md §3.1, P1)', () => {
  it('a port with no cable has never had carrier', () => {
    const lone = new Port('eth0', 'ethernet');
    expect(lone.hasCarrier()).toBe(false);
  });

  it('connecting a cable brings carrier up on both ends', () => {
    const { a, b } = pair();
    expect(a.hasCarrier()).toBe(true);
    expect(b.hasCarrier()).toBe(true);
  });

  it('disconnecting the cable drops carrier on both ends', () => {
    const { a, b, cable } = pair();
    cable.disconnect();
    expect(a.hasCarrier()).toBe(false);
    expect(b.hasCarrier()).toBe(false);
  });

  it('a cable administratively brought down also drops carrier', () => {
    const { a, b, cable } = pair();
    cable.setUp(false);
    expect(a.hasCarrier()).toBe(false);
    expect(b.hasCarrier()).toBe(false);
    cable.setUp(true);
    expect(a.hasCarrier()).toBe(true);
  });
});

describe('Port.isOperationallyUp() (docs/PRD-Link-State.md §3.1, P1)', () => {
  it('is true only when line state, admin state and carrier all agree', () => {
    const { a } = pair();
    expect(a.isOperationallyUp()).toBe(true);
  });

  it('is false when the cable is unplugged even though getIsUp() stays true', () => {
    const { a, cable } = pair();
    cable.disconnect();
    expect(a.getIsUp()).toBe(true);
    expect(a.isOperationallyUp()).toBe(false);
  });

  it('is false when the port is administratively down', () => {
    const { a } = pair();
    a.setAdminDown(true);
    expect(a.hasCarrier()).toBe(true);
    expect(a.isOperationallyUp()).toBe(false);
  });

  it('is false when the line state is down (errdisable and the like)', () => {
    const { a } = pair();
    a.setUp(false);
    expect(a.isOperationallyUp()).toBe(false);
  });

  it('getIsUp() keeps its existing meaning — unaffected by the cable', () => {
    const { a, cable } = pair();
    expect(a.getIsUp()).toBe(true);
    cable.disconnect();
    expect(a.getIsUp()).toBe(true);
  });
});

describe('link-down notification on unplug (P1)', () => {
  it('disconnecting fires an onLinkChange("down") handler', () => {
    const { a, cable } = pair();
    const states: string[] = [];
    a.onLinkChange((s) => states.push(s));
    cable.disconnect();
    expect(states).toContain('down');
  });
});
