/**
 * IEEE Std 802.1Q-2022, 11.2 (MVRP) over 10.3 (MAP) and 10.7 (docs/rfc/dot1q/8021Q-2022.pdf):
 * MRPDUs cross real Cables between agents, driven on a virtual clock.
 *
 *   11.2.3.2.2 a Join indication registers the VID on the reception Port; a
 *              Leave indication deregisters it
 *   10.3 a) b) MAP propagates a registration received on one forwarding Port to
 *              every other forwarding Port, and a deregistration only when no
 *              other Port still holds the registration
 *   10.7.2     Registration Forbidden ignores messages; Registration Fixed
 *              keeps the VID registered and propagates it
 *   10.7.9     LeaveAll cycles make every Participant re-declare, so a silent
 *              peer's registration expires after LeaveTime
 *   11.2.3.1.7 the value 0 in a received message means the PVID of the Port
 *
 * Measured on a git worktree of HEAD before the change: mvrp/MvrpAgent does
 * not exist, so the file cannot load. No witness: new agent; the frame counts
 * below show traffic really crossed the Cable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { EventBus } from '@/events/EventBus';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import { LinkLayer, type LinkSendRequest } from '@/network/layers/link/LinkLayer';
import { MvrpAgent, type MvrpHost } from '@/network/mvrp/MvrpAgent';
import { MVRP_ETHERTYPE, encodeMvrp } from '@/network/mvrp/MvrpPdu';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

interface Node {
  readonly agent: MvrpAgent;
  readonly registered: Map<string, Set<number>>;
  readonly ports: Map<string, Port>;
  readonly frames: number[];
}

let scheduler: VirtualTimeScheduler;
let bus: EventBus;

beforeEach(() => {
  resetCounters(); MACAddress.resetCounter(); Logger.reset();
  scheduler = new VirtualTimeScheduler();
  bus = new EventBus();
});

function node(name: string, portNames: string[], hooks: Partial<MvrpHost> = {}): Node {
  const ports = new Map(portNames.map(portName => [portName, new Port(`${name}-${portName}`)]));
  const registered = new Map<string, Set<number>>();
  const frames: number[] = [];
  const link = new LinkLayer({ getPort: portName => ports.get(portName) });
  const host: MvrpHost = {
    id: name, name, getHostname: () => name,
    getPort: portName => ports.get(portName),
    sendOnLink: (request: LinkSendRequest) => { frames.push(1); return link.send(request); },
    onVlanRegistered: (portName, vid) => {
      if (!registered.has(portName)) registered.set(portName, new Set());
      registered.get(portName)!.add(vid);
    },
    onVlanDeregistered: (portName, vid) => { registered.get(portName)?.delete(vid); },
    ...hooks,
  };
  const agent = new MvrpAgent(host, () => bus, () => scheduler);
  agent.setRandom(() => 0);
  for (const [portName, port] of ports) {
    port.onFrame((_n, frame) => { agent.handleFrame(portName, frame); });
  }
  return { agent, registered, ports, frames };
}

function wire(a: Node, aPort: string, b: Node, bPort: string): void {
  new Cable(`${aPort}-${bPort}`).connect(a.ports.get(aPort)!, b.ports.get(bPort)!);
}

function enable(n: Node, ...portNames: string[]): void {
  n.agent.start();
  n.agent.setEnabled(true);
  for (const portName of portNames) n.agent.configurePort(portName, { enabled: true });
}

const elapse = (ms: number): void => { scheduler.advance(ms); };

describe('11.2.3.2: registration and deregistration', () => {
  it('a Join declared on one end registers the VID on the Port of the other', () => {
    const a = node('A', ['p']);
    const b = node('B', ['p']);
    wire(a, 'p', b, 'p');
    enable(a, 'p'); enable(b, 'p');

    a.agent.registerVlanMember(10);
    elapse(1000);

    expect(b.registered.get('p')?.has(10)).toBe(true);
    expect(b.agent.registeredVids('p')).toEqual([10]);
    expect(a.frames.length).toBeGreaterThan(0);
  });

  it('a withdrawn declaration deregisters the VID at the peer', () => {
    const a = node('A', ['p']);
    const b = node('B', ['p']);
    wire(a, 'p', b, 'p');
    enable(a, 'p'); enable(b, 'p');
    a.agent.registerVlanMember(10);
    elapse(1000);

    a.agent.deregisterVlanMember(10);
    elapse(3000);

    expect(b.registered.get('p')?.has(10)).toBe(false);
    expect(b.agent.registeredVids('p')).toEqual([]);
  });

  it('a registration stays while the peer keeps declaring, across LeaveAll cycles (10.7.9)', () => {
    const a = node('A', ['p']);
    const b = node('B', ['p']);
    wire(a, 'p', b, 'p');
    enable(a, 'p'); enable(b, 'p');
    a.agent.registerVlanMember(10);

    elapse(90_000);

    expect(b.agent.registeredVids('p')).toEqual([10]);
    expect(b.agent.getStats('p').leaveAllReceived).toBeGreaterThan(0);
  });

  it('a registration expires when the peer goes silent: LeaveAll prompts re-declaration, none comes (10.7.9)', () => {
    const a = node('A', ['p']);
    const b = node('B', ['p']);
    wire(a, 'p', b, 'p');
    enable(a, 'p'); enable(b, 'p');
    a.agent.registerVlanMember(10);
    elapse(1000);
    expect(b.agent.registeredVids('p')).toEqual([10]);

    a.agent.setEnabled(false);
    elapse(60_000);

    expect(b.agent.registeredVids('p')).toEqual([]);
  });
});

describe('10.3: MAP across a bridge', () => {
  it('propagates a registration from one Port to the other Port, and on to the far end station', () => {
    const a = node('A', ['p']);
    const b = node('B', ['east', 'west']);
    const c = node('C', ['p']);
    wire(a, 'p', b, 'west'); wire(b, 'east', c, 'p');
    enable(a, 'p'); enable(b, 'east', 'west'); enable(c, 'p');

    a.agent.registerVlanMember(20);
    elapse(2000);

    expect(b.agent.registeredVids('west')).toEqual([20]);
    expect(b.agent.declaredVids('east')).toEqual([20]);
    expect(c.agent.registeredVids('p')).toEqual([20]);
    expect(b.agent.declaredVids('west')).toEqual([]);
  });

  it('withdraws the declaration downstream once the last source is gone', () => {
    const a = node('A', ['p']);
    const b = node('B', ['east', 'west']);
    const c = node('C', ['p']);
    wire(a, 'p', b, 'west'); wire(b, 'east', c, 'p');
    enable(a, 'p'); enable(b, 'east', 'west'); enable(c, 'p');
    a.agent.registerVlanMember(20);
    elapse(2000);

    a.agent.deregisterVlanMember(20);
    elapse(5000);

    expect(c.agent.registeredVids('p')).toEqual([]);
    expect(b.agent.declaredVids('east')).toEqual([]);
  });

  it('does not propagate through a Port that is not forwarding', () => {
    let forwardingEast = false;
    const a = node('A', ['p']);
    const b = node('B', ['east', 'west'], { portForwarding: portName => portName !== 'east' || forwardingEast });
    const c = node('C', ['p']);
    wire(a, 'p', b, 'west'); wire(b, 'east', c, 'p');
    enable(a, 'p'); enable(b, 'east', 'west'); enable(c, 'p');

    a.agent.registerVlanMember(20);
    elapse(2000);
    expect(c.agent.registeredVids('p')).toEqual([]);

    forwardingEast = true;
    b.agent.onPortForwardingChanged('east');
    elapse(2000);
    expect(c.agent.registeredVids('p')).toEqual([20]);
  });
});

describe('10.7.2: Registrar Administrative Controls on a Port', () => {
  it('Registration Forbidden ignores what the peer declares', () => {
    const a = node('A', ['p']);
    const b = node('B', ['p']);
    wire(a, 'p', b, 'p');
    enable(a, 'p'); enable(b, 'p');
    b.agent.configurePort('p', { registration: 'forbidden' });

    a.agent.registerVlanMember(10);
    elapse(1000);

    expect(b.agent.registeredVids('p')).toEqual([]);
    expect(b.registered.get('p')?.has(10) ?? false).toBe(false);
  });

  it('Registration Fixed propagates the VID without the peer declaring it', () => {
    const a = node('A', ['p']);
    const b = node('B', ['east', 'west'], {
      fixedRegistrations: portName => (portName === 'west' ? new Set([30]) : new Set()),
    });
    wire(a, 'p', b, 'east');
    enable(a, 'p'); enable(b, 'east', 'west');

    b.agent.refreshFixedRegistrations();
    elapse(1000);

    expect(a.agent.registeredVids('p')).toEqual([30]);
  });
});

describe('10.8.3 and 11.2.3.1.7: what is received', () => {
  it('counts a malformed MRPDU and discards it', () => {
    const b = node('B', ['p']);
    const sender = new Port('raw');
    new Cable('raw').connect(sender, b.ports.get('p')!);
    enable(b, 'p');

    sender.sendFrame({
      srcMAC: sender.getMAC(), dstMAC: new MACAddress('01:80:c2:00:00:21'),
      etherType: MVRP_ETHERTYPE, payload: Uint8Array.of(0, 1, 2, 0, 4, 0, 10, 0x56),
    });

    expect(b.agent.getStats('p').pdusDiscarded).toBe(1);
    expect(b.agent.registeredVids('p')).toEqual([]);
  });

  it('reads the value 0 as the PVID of the receiving Port', () => {
    const b = node('B', ['p'], { pvidOf: () => 77 });
    const sender = new Port('raw');
    new Cable('raw').connect(sender, b.ports.get('p')!);
    enable(b, 'p');

    sender.sendFrame({
      srcMAC: sender.getMAC(), dstMAC: new MACAddress('01:80:c2:00:00:21'),
      etherType: MVRP_ETHERTYPE, payload: encodeMvrp({ leaveAll: false, declarations: [{ vid: 0, event: 'joinIn' }] }),
    });

    expect(b.agent.registeredVids('p')).toEqual([77]);
  });

  it('ignores a frame addressed elsewhere or when MVRP is disabled on the Port', () => {
    const b = node('B', ['p']);
    const sender = new Port('raw');
    new Cable('raw').connect(sender, b.ports.get('p')!);
    b.agent.start();
    b.agent.setEnabled(true);

    sender.sendFrame({
      srcMAC: sender.getMAC(), dstMAC: new MACAddress('01:80:c2:00:00:21'),
      etherType: MVRP_ETHERTYPE, payload: encodeMvrp({ leaveAll: false, declarations: [{ vid: 5, event: 'joinIn' }] }),
    });
    expect(b.agent.registeredVids('p')).toEqual([]);

    b.agent.configurePort('p', { enabled: true });
    sender.sendFrame({
      srcMAC: sender.getMAC(), dstMAC: new MACAddress('01:80:c2:00:00:20'),
      etherType: MVRP_ETHERTYPE, payload: encodeMvrp({ leaveAll: false, declarations: [{ vid: 5, event: 'joinIn' }] }),
    });
    expect(b.agent.registeredVids('p')).toEqual([]);
  });
});
