import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  compareBridge, bridgeEquals, defaultPathCost,
  STP_BRIDGE_MAC, ETHERTYPE_STP, type BridgeId,
} from '@/network/stp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('STP — pure comparators and helpers', () => {
  it('bridge comparison: priority dominates, MAC tiebreaks', () => {
    const a: BridgeId = { priority: 32768, mac: 'aa:aa:aa:aa:aa:aa' };
    const b: BridgeId = { priority: 4096, mac: 'ff:ff:ff:ff:ff:ff' };
    expect(compareBridge(a, b)).toBeGreaterThan(0);
    const c: BridgeId = { priority: 32768, mac: 'bb:bb:bb:bb:bb:bb' };
    expect(compareBridge(a, c)).toBeLessThan(0);
    expect(bridgeEquals(a, { ...a })).toBe(true);
  });

  it('path cost table matches IEEE defaults', () => {
    expect(defaultPathCost(10_000)).toBe(100);
    expect(defaultPathCost(100_000)).toBe(19);
    expect(defaultPathCost(1_000_000)).toBe(4);
    expect(defaultPathCost(10_000_000)).toBe(2);
  });
});

describe('STP — single switch is the root', () => {
  it('a lone switch elects itself as root', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const stp = sw.getStpAgent();
    expect(stp.isRoot()).toBe(true);
    expect(stp.getRootPort()).toBeNull();
    expect(stp.getRootPathCost()).toBe(0);
  });

  it('connected ports stay forwarding when there is no peer BPDU', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const port = sw.getPort('FastEthernet0/1')!;
    port.setUp(true);
    expect(sw.getSTPState('FastEthernet0/1')).toBe('forwarding');
  });
});

describe('STP — root election across a cable', () => {
  it('lower priority bridge wins the root election', async () => {
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');
    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);

    const winnerStp = winner.getStpAgent();
    const loserStp = loser.getStpAgent();
    expect(winnerStp.isRoot()).toBe(true);
    expect(loserStp.isRoot()).toBe(false);
    expect(loserStp.getRootBridge().priority).toBe(4096);
    expect(loserStp.getRootPort()).toBe('FastEthernet0/1');
  });

  it('losing switch puts its facing port into the root role and keeps it forwarding', async () => {
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');
    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);
    expect(loser.getStpAgent().getPortRole('FastEthernet0/1')).toBe('root');
    expect(loser.getSTPState('FastEthernet0/1')).toBe('forwarding');
  });

  it('on the root bridge the facing port is designated', async () => {
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');
    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);
    expect(winner.getStpAgent().getPortRole('FastEthernet0/1')).toBe('designated');
  });
});

describe('STP — loop breaking', () => {
  it('two cables between the same switches block one port to break the loop', async () => {
    const root = new CiscoSwitch('switch-cisco', 'SW-ROOT', 4);
    const other = new CiscoSwitch('switch-cisco', 'SW-OTHER', 4);
    await root.executeCommand('enable');
    await root.executeCommand('configure terminal');
    await root.executeCommand('spanning-tree vlan 1 priority 4096');
    await root.executeCommand('end');
    new Cable('a').connect(root.getPort('FastEthernet0/1')!,
                            other.getPort('FastEthernet0/1')!);
    new Cable('b').connect(root.getPort('FastEthernet0/2')!,
                            other.getPort('FastEthernet0/2')!);

    const otherStp = other.getStpAgent();
    const role0 = otherStp.getPortRole('FastEthernet0/1');
    const role1 = otherStp.getPortRole('FastEthernet0/2');
    expect([role0, role1].sort()).toEqual(['alternate', 'root']);

    const blocked = role0 === 'alternate' ? 'FastEthernet0/1' : 'FastEthernet0/2';
    const forwarding = role0 === 'root' ? 'FastEthernet0/1' : 'FastEthernet0/2';
    expect(other.getSTPState(blocked)).toBe('blocking');
    expect(other.getSTPState(forwarding)).toBe('forwarding');
  });
});

describe('STP — reactive events', () => {
  it('stp.root.changed fires on the losing switch', async () => {
    const bus = new EventBus();
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    winner.setEventBus(bus);
    loser.setEventBus(bus);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');

    const changes: Array<{ deviceId: string; newRootMac: string }> = [];
    bus.subscribe('stp.root.changed', (e) => changes.push(e.payload));

    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);

    expect(changes.some(c => c.deviceId === loser.id)).toBe(true);
  });

  it('stp.bpdu.sent fires synchronously on cable connect', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const sent: Array<{ port: string }> = [];
    bus.subscribe('stp.bpdu.sent', (e) => sent.push(e.payload));
    new Cable('w').connect(s1.getPort('FastEthernet0/1')!,
                            s2.getPort('FastEthernet0/1')!);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('stp.role.changed fires when a port transitions to root', async () => {
    const bus = new EventBus();
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    winner.setEventBus(bus);
    loser.setEventBus(bus);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');
    const roles: Array<{ newRole: string; port: string }> = [];
    bus.subscribe('stp.role.changed', (e) => {
      if (e.payload.deviceId === loser.id) roles.push(e.payload);
    });
    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);
    expect(roles.some(r => r.newRole === 'root' && r.port === 'FastEthernet0/1')).toBe(true);
  });
});

describe('STP — wire format', () => {
  it('BPDU uses the IEEE bridge multicast and the STP ethertype', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const cable = new Cable('w');
    cable.setEventBus(bus);

    let seen: { dst: string; ether: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.frame.etherType === ETHERTYPE_STP) {
        seen = {
          dst: e.payload.frame.dstMAC.toString().toLowerCase(),
          ether: e.payload.frame.etherType,
        };
      }
    });
    cable.connect(s1.getPort('FastEthernet0/1')!,
                  s2.getPort('FastEthernet0/1')!);
    expect(seen).not.toBeNull();
    expect(seen!.dst).toBe(STP_BRIDGE_MAC);
    expect(seen!.ether).toBe(ETHERTYPE_STP);
  });
});

describe('STP — running-config & show', () => {
  it('non-default priority/hello/max-age/forward-time persist into running-config', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('spanning-tree vlan 1 priority 4096');
    await sw.executeCommand('spanning-tree vlan 1 hello-time 3');
    await sw.executeCommand('spanning-tree vlan 1 max-age 25');
    await sw.executeCommand('spanning-tree vlan 1 forward-time 20');
    await sw.executeCommand('end');
    const r = sw.getRunningConfig();
    expect(r).toMatch(/spanning-tree vlan 1 priority 4096/);
    expect(r).toMatch(/spanning-tree vlan 1 hello-time 3/);
    expect(r).toMatch(/spanning-tree vlan 1 max-age 25/);
    expect(r).toMatch(/spanning-tree vlan 1 forward-time 20/);
  });

  it('show spanning-tree reports the live root + roles', async () => {
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');
    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);
    const out = await loser.executeCommand('enable')
      .then(() => loser.executeCommand('show spanning-tree'));
    expect(out).toMatch(/Priority\s+4097/);
    expect(out).toMatch(/Fa0\/1.*Root.*FWD/);
  });
});

describe('STP — 802.1D listening/learning transitions', () => {
  let vts: VirtualTimeScheduler;

  beforeEach(() => {
    vts = new VirtualTimeScheduler();
    __setDefaultScheduler(vts);
  });

  afterEach(() => {
    __setDefaultScheduler(null);
  });

  /**
   * Redundant pair: two cables between a forced root and another switch.
   * The non-root switch ends up with one root port (forwarding) and one
   * alternate port (blocking).
   */
  async function buildRedundantPair() {
    const root = new CiscoSwitch('switch-cisco', 'SW-ROOT', 4);
    const other = new CiscoSwitch('switch-cisco', 'SW-OTHER', 4);
    await root.executeCommand('enable');
    await root.executeCommand('configure terminal');
    await root.executeCommand('spanning-tree vlan 1 priority 4096');
    await root.executeCommand('end');
    new Cable('a').connect(root.getPort('FastEthernet0/1')!,
                            other.getPort('FastEthernet0/1')!);
    new Cable('b').connect(root.getPort('FastEthernet0/2')!,
                            other.getPort('FastEthernet0/2')!);
    const stp = other.getStpAgent();
    const role0 = stp.getPortRole('FastEthernet0/1');
    const blockedPort = role0 === 'alternate' ? 'FastEthernet0/1' : 'FastEthernet0/2';
    const rootPort = role0 === 'root' ? 'FastEthernet0/1' : 'FastEthernet0/2';
    return { root, other, blockedPort, rootPort };
  }

  it('an unblocked port spends forward-delay in listening then learning before forwarding', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();
    expect(other.getSTPState(blockedPort)).toBe('blocking');

    other.getPort(rootPort)!.setUp(false);

    expect(other.getSTPState(blockedPort)).toBe('listening');
    vts.advance(15_000);
    expect(other.getSTPState(blockedPort)).toBe('learning');
    vts.advance(15_000);
    expect(other.getSTPState(blockedPort)).toBe('forwarding');
  });

  it('honors a non-default forward-time during reconvergence', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();
    await other.executeCommand('enable');
    await other.executeCommand('configure terminal');
    await other.executeCommand('spanning-tree vlan 1 forward-time 4');
    await other.executeCommand('end');

    other.getPort(rootPort)!.setUp(false);

    expect(other.getSTPState(blockedPort)).toBe('listening');
    vts.advance(4_000);
    expect(other.getSTPState(blockedPort)).toBe('learning');
    vts.advance(4_000);
    expect(other.getSTPState(blockedPort)).toBe('forwarding');
  });

  it('publishes stp.port-state.changed for each transition', async () => {
    const bus = new EventBus();
    const root = new CiscoSwitch('switch-cisco', 'SW-ROOT', 4);
    const other = new CiscoSwitch('switch-cisco', 'SW-OTHER', 4);
    root.setEventBus(bus);
    other.setEventBus(bus);
    await root.executeCommand('enable');
    await root.executeCommand('configure terminal');
    await root.executeCommand('spanning-tree vlan 1 priority 4096');
    await root.executeCommand('end');
    new Cable('a').connect(root.getPort('FastEthernet0/1')!,
                            other.getPort('FastEthernet0/1')!);
    new Cable('b').connect(root.getPort('FastEthernet0/2')!,
                            other.getPort('FastEthernet0/2')!);
    const stp = other.getStpAgent();
    const blockedPort = stp.getPortRole('FastEthernet0/1') === 'alternate'
      ? 'FastEthernet0/1' : 'FastEthernet0/2';
    const rootPort = blockedPort === 'FastEthernet0/1'
      ? 'FastEthernet0/2' : 'FastEthernet0/1';

    const seen: string[] = [];
    bus.subscribe('stp.port-state.changed', (e) => {
      if (e.payload.deviceId === other.id && e.payload.port === blockedPort) {
        seen.push(e.payload.newState);
      }
    });

    other.getPort(rootPort)!.setUp(false);
    vts.advance(30_000);

    expect(seen).toEqual(['listening', 'learning', 'forwarding']);
  });

  it('portfast lets a previously blocked port skip straight to forwarding', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();
    other.getStpAgent().setPortFast(blockedPort, true);

    other.getPort(rootPort)!.setUp(false);

    expect(other.getSTPState(blockedPort)).toBe('forwarding');
  });

  it('a port re-blocked while listening cancels the pending transition', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();

    other.getPort(rootPort)!.setUp(false);
    expect(other.getSTPState(blockedPort)).toBe('listening');

    // Once the root path is restored and the next hello BPDU re-asserts the
    // better path, the port returns to blocking and the pending
    // listening→learning timer must be cancelled.
    other.getPort(rootPort)!.setUp(true);
    vts.advance(2_000);
    expect(other.getSTPState(blockedPort)).toBe('blocking');

    vts.advance(60_000);
    expect(other.getSTPState(blockedPort)).toBe('blocking');
  });

  it('frames are not forwarded out of a listening port', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();
    other.getPort(rootPort)!.setUp(false);
    expect(other.getSTPState(blockedPort)).toBe('listening');
    expect(other.getStpAgent().getForwardState(blockedPort)).toBe('listening');
  });
});

describe('STP — link-down clears the peer state', () => {
  it('bringing the root cable down lets the loser become root again', async () => {
    const winner = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const loser = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await winner.executeCommand('enable');
    await winner.executeCommand('configure terminal');
    await winner.executeCommand('spanning-tree vlan 1 priority 4096');
    await winner.executeCommand('end');
    new Cable('w').connect(winner.getPort('FastEthernet0/1')!,
                            loser.getPort('FastEthernet0/1')!);
    expect(loser.getStpAgent().isRoot()).toBe(false);
    loser.getPort('FastEthernet0/1')!.setUp(false);
    expect(loser.getStpAgent().isRoot()).toBe(true);
  });
});
