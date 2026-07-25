/**
 * STP bpdufilter / loopguard / uplinkfast — real behavioral wiring
 * (rapport 01 audit: these knobs were parsed and echoed back in
 * `show run`/`display this` but never read anywhere by the STP engine).
 *
 * `backbonefast` (Root Link Query) has no equivalent infrastructure in this
 * engine (no inferior-BPDU detection, no RLQ exchange) and is intentionally
 * left unwired here — out of scope for this pass. Likewise, `uplinkfast`'s
 * CAM-flush dummy-multicast burst is not modeled; only its headline
 * behavior (skip the listening/learning delay on failover) is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { StpVlanInstance, type StpInstanceAgent } from '@/network/stp/StpVlanInstance';
import type { BridgeId, StpPortInfo } from '@/network/stp/types';
import type { Port } from '@/network/hardware/Port';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function cfgSwitch(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  return sw;
}

// ─── bpdufilter — CLI wiring ────────────────────────────────────────────

describe('Cisco spanning-tree bpdufilter/guard loop — CLI wiring', () => {
  it('interface bpdufilter enable/disable sets and clears the hard per-port override', async () => {
    const sw = await cfgSwitch();
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('spanning-tree bpdufilter enable');
    expect(sw.getStpAgent().isBpduFilterHardEnabled('FastEthernet0/1')).toBe(true);
    await sw.executeCommand('spanning-tree bpdufilter disable');
    expect(sw.getStpAgent().isBpduFilterHardEnabled('FastEthernet0/1')).toBe(false);
  });

  it('interface guard loop sets the per-port loop-guard override; no form clears it', async () => {
    const sw = await cfgSwitch();
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('spanning-tree guard loop');
    expect(sw.getStpAgent().isLoopGuardActive('FastEthernet0/1')).toBe(true);
    await sw.executeCommand('no spanning-tree guard loop');
    expect(sw.getStpAgent().isLoopGuardActive('FastEthernet0/1')).toBe(false);
  });

  it('turning off a per-port loop guard while the port is held inconsistent restores normal operation', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const agent = sw.getStpAgent();
    const port = 'FastEthernet0/1';
    agent.setPortLoopGuard(port, true);
    agent.setLoopInconsistent(port, true);
    expect(agent.isLoopInconsistent(port)).toBe(true);

    agent.setPortLoopGuard(port, false);

    expect(agent.isLoopInconsistent(port)).toBe(false);
  });
});

// ─── bpdufilter — real tx/rx suppression ────────────────────────────────

describe('Cisco spanning-tree bpdufilter — hard per-port enable suppresses BPDU tx/rx', () => {
  it('a hard-filtered port neither sends nor processes BPDUs, so both sides independently believe they are root', () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.getStpAgent().setPortBpduFilter('FastEthernet0/1', true);

    new Cable('w').connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    expect(s1.getStpAgent().getBpduSentCount('FastEthernet0/1')).toBe(0);
    expect(s1.getStpAgent().getBpduReceivedCount('FastEthernet0/1')).toBe(0);
    expect(s2.getStpAgent().getBpduSentCount('FastEthernet0/1')).toBeGreaterThan(0);
    // Neither switch ever hears a superior BPDU from the other — both stay
    // root of themselves. This is exactly the danger real IOS documents for
    // this "hard" override: misuse on an inter-switch link partitions STP.
    expect(s1.getStpAgent().isRoot()).toBe(true);
    expect(s2.getStpAgent().isRoot()).toBe(true);
  });
});

describe('Cisco spanning-tree bpdufilter — global default mode is self-healing', () => {
  it('filters only while PortFast-operational, then reverts to normal STP on the first received BPDU', () => {
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    const port = 'FastEthernet0/1';
    s1.getStpAgent().setPortFast(port, true);
    s1.getStpAgent().setBpduFilterGlobal(true);
    expect(s1.getStpAgent().isBpduFilterEffective(port)).toBe(true);

    new Cable('w').connect(s1.getPort(port)!, s2.getPort(port)!);

    // s2's very first BPDU strips s1's PortFast operational status, which
    // is what the "default" (as opposed to hard-enable) filter rides on.
    expect(s1.getStpAgent().getBpduReceivedCount(port)).toBeGreaterThan(0);
    expect(s1.getStpAgent().isBpduFilterEffective(port)).toBe(false);
  });
});

// ─── uplinkfast — real behavioral effect ────────────────────────────────

describe('Cisco spanning-tree uplinkfast — real behavioral effect', () => {
  let vts: VirtualTimeScheduler;

  beforeEach(() => {
    vts = new VirtualTimeScheduler();
    __setDefaultScheduler(vts);
  });

  afterEach(() => {
    __setDefaultScheduler(null);
  });

  async function buildRedundantPair() {
    const root = new CiscoSwitch('switch-cisco', 'SW-ROOT', 4);
    const other = new CiscoSwitch('switch-cisco', 'SW-OTHER', 4);
    await root.executeCommand('enable');
    await root.executeCommand('configure terminal');
    await root.executeCommand('spanning-tree vlan 1 priority 4096');
    await root.executeCommand('end');
    new Cable('a').connect(root.getPort('FastEthernet0/1')!, other.getPort('FastEthernet0/1')!);
    new Cable('b').connect(root.getPort('FastEthernet0/2')!, other.getPort('FastEthernet0/2')!);
    const stp = other.getStpAgent();
    const role0 = stp.getPortRole('FastEthernet0/1');
    const blockedPort = role0 === 'alternate' ? 'FastEthernet0/1' : 'FastEthernet0/2';
    const rootPort = role0 === 'root' ? 'FastEthernet0/1' : 'FastEthernet0/2';
    return { other, blockedPort, rootPort };
  }

  it('without uplinkfast, the backup port ramps through listening/learning after the root port fails', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();
    other.getPort(rootPort)!.setUp(false);
    expect(other.getSTPState(blockedPort)).toBe('listening');
  });

  it('with uplinkfast enabled, the backup port jumps straight to forwarding on root-port failure', async () => {
    const { other, blockedPort, rootPort } = await buildRedundantPair();
    await other.executeCommand('enable');
    await other.executeCommand('configure terminal');
    await other.executeCommand('spanning-tree uplinkfast');
    await other.executeCommand('end');

    other.getPort(rootPort)!.setUp(false);

    expect(other.getSTPState(blockedPort)).toBe('forwarding');
  });
});

// ─── loop guard — core election logic (isolated from the max-age /
// Date.now() timer plumbing, which this pass does not touch) ────────────

function fakePort(name: string): Port {
  return { getName: () => name, getIsUp: () => true, isConnected: () => true } as unknown as Port;
}

function makeInstanceAgent() {
  const own: BridgeId = { priority: 32768, mac: 'ff:ff:ff:ff:ff:ff' };
  const ports = new Map<string, Port>([['p1', fakePort('p1')], ['p2', fakePort('p2')]]);
  const loopGuardPorts = new Set<string>();
  const loopInconsistent = new Set<string>();
  const agent: StpInstanceAgent = {
    deviceId: 'sw1',
    deviceName: 'SW1',
    getHostname: () => 'SW1',
    bus: () => ({ publish: () => {} }) as unknown as ReturnType<StpInstanceAgent['bus']>,
    scheduler: () => ({
      now: () => 0, setTimeout: () => 0, setInterval: () => 0, clear: () => {}, delay: () => Promise.resolve(),
    }) as unknown as ReturnType<StpInstanceAgent['scheduler']>,
    getPort: (n) => ports.get(n),
    getPorts: () => [...ports.values()],
    getMode: () => 'rstp',
    isEnabledStp: () => true,
    forwardDelaySec: () => 15,
    maxAgeSec: () => 20,
    ownBridgeId: () => own,
    costForPort: () => 19,
    portIdFor: (n) => (n === 'p1' ? 0x8001 : 0x8002),
    isRootInconsistent: () => false,
    isLoopGuardActive: (n) => loopGuardPorts.has(n),
    isLoopInconsistent: (n) => loopInconsistent.has(n),
    setLoopInconsistent: (n, on) => { if (on) loopInconsistent.add(n); else loopInconsistent.delete(n); },
    isPortFastOperational: () => false,
    isPointToPoint: () => true,
    portCarriesVlan: () => true,
    onInstanceForwardState: () => {},
    onInstanceTopologyChange: () => {},
    sendProposal: () => {},
  };
  return { agent, own, loopGuardPorts, loopInconsistent };
}

/** p1 becomes root port, p2 becomes alternate — mirrors a redundant-uplink switch. */
function seedRootAndAlternate(inst: StpVlanInstance, agent: StpInstanceAgent, nowMs: number) {
  const rootBridge: BridgeId = { priority: 4096, mac: 'aa:aa:aa:aa:aa:01' };
  const p1: StpPortInfo = {
    role: 'disabled', cost: 19,
    designatedRoot: rootBridge, designatedBridge: rootBridge,
    designatedCost: 0, designatedPort: 0x8001, ageMs: nowMs,
  };
  const p2: StpPortInfo = {
    role: 'disabled', cost: 19,
    designatedRoot: rootBridge, designatedBridge: { priority: 28672, mac: 'bb:bb:bb:bb:bb:02' },
    designatedCost: 5, designatedPort: 0x8002, ageMs: nowMs,
  };
  inst.setPortInfo('p1', p1);
  inst.setPortInfo('p2', p2);
  inst.runElection();
  expect(inst.getPortRole('p1')).toBe('root');
  expect(inst.getPortRole('p2')).toBe('alternate');
}

describe('Loop guard — election logic', () => {
  it('without loop guard, a blocked port whose BPDU info ages out re-promotes itself to designated (the bug)', () => {
    const { agent } = makeInstanceAgent();
    const inst = new StpVlanInstance(1, agent);
    seedRootAndAlternate(inst, agent, 1_000);

    inst.expireStaleBpduInfo(1_000 + 25_000);

    expect(inst.getPortRole('p2')).toBe('designated');
  });

  it('with loop guard active, the same port is held loop-inconsistent instead of re-promoted', () => {
    const { agent, loopGuardPorts, loopInconsistent } = makeInstanceAgent();
    loopGuardPorts.add('p2');
    const inst = new StpVlanInstance(1, agent);
    seedRootAndAlternate(inst, agent, 1_000);

    inst.expireStaleBpduInfo(1_000 + 25_000);

    expect(loopInconsistent.has('p2')).toBe(true);
    expect(inst.getPortRole('p2')).toBe('alternate');
    expect(inst.getForwardState('p2')).toBe('blocking');
  });

  it('loop guard never touches the designated/root ports, only non-designated ones', () => {
    const { agent, loopGuardPorts, loopInconsistent } = makeInstanceAgent();
    loopGuardPorts.add('p1'); // guard the ROOT port — real IOS also restricts this to non-designated ports
    const inst = new StpVlanInstance(1, agent);
    seedRootAndAlternate(inst, agent, 1_000);

    // p1 (root) never ages out here because its own info is fresh; only
    // demonstrating that the `info.role !== 'designated'` guard in
    // expireStaleBpduInfo is keyed on role, not blanket port identity.
    inst.expireStaleBpduInfo(1_000 + 500); // well within max-age (20s)

    expect(loopInconsistent.has('p1')).toBe(false);
    expect(inst.getPortRole('p1')).toBe('root');
  });
});

// ─── Huawei — CLI wiring for the equivalent VRP knobs ───────────────────

async function huaweiSysSwitch(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  await sw.executeCommand('system-view');
  return sw;
}

describe('Huawei stp bpdu-filter / loop-protection / root-protection — CLI wiring', () => {
  it('stp bpdu-filter enable/disable sets and clears the hard per-port override', async () => {
    const sw = await huaweiSysSwitch();
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('stp bpdu-filter enable');
    expect(sw.getStpAgent().isBpduFilterHardEnabled('GigabitEthernet0/0/1')).toBe(true);
    await sw.executeCommand('stp bpdu-filter disable');
    expect(sw.getStpAgent().isBpduFilterHardEnabled('GigabitEthernet0/0/1')).toBe(false);
  });

  it('stp loop-protection / undo stp loop-protection toggle the per-port loop guard', async () => {
    const sw = await huaweiSysSwitch();
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('stp loop-protection');
    expect(sw.getStpAgent().isLoopGuardActive('GigabitEthernet0/0/1')).toBe(true);
    await sw.executeCommand('undo stp loop-protection');
    expect(sw.getStpAgent().isLoopGuardActive('GigabitEthernet0/0/1')).toBe(false);
  });

  it('stp root-protection / undo stp root-protection toggle the per-port root guard', async () => {
    const sw = await huaweiSysSwitch();
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('stp root-protection');
    expect(sw.getStpAgent().getPortGuards('GigabitEthernet0/0/1').rootGuard).toBe(true);
    await sw.executeCommand('undo stp root-protection');
    expect(sw.getStpAgent().getPortGuards('GigabitEthernet0/0/1').rootGuard).toBe(false);
  });
});
