import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

async function setRapidPvst(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('spanning-tree mode rapid-pvst');
  await sw.executeCommand('end');
}

async function makeRoot(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('spanning-tree vlan 1 priority 4096');
  await sw.executeCommand('end');
}

describe('RSTP (802.1w subset)', () => {
  it('spanning-tree mode rapid-pvst switches the agent into rstp', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    expect(sw.getStpAgent().getMode()).toBe('stp');
    await setRapidPvst(sw);
    expect(sw.getStpAgent().getMode()).toBe('rstp');
  });

  it('Huawei: stp mode rstp switches the agent into rstp', async () => {
    const { HuaweiSwitch } = await import('@/network/devices/HuaweiSwitch');
    const sw = new HuaweiSwitch('switch-huawei', 'HW1');
    await sw.executeCommand('system-view');
    await sw.executeCommand('stp mode rstp');
    expect(sw.getStpAgent().getMode()).toBe('rstp');
  });

  it('proposal/agreement: a blocked port turned designated forwards without timers', async () => {
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    const states = () => ['FastEthernet0/0', 'FastEthernet0/1']
      .map(p => sw2.getStpAgent().getForwardState(p));
    expect(states()).toContain('blocking');

    sw2.getStpAgent().setBridgePriority(0);

    expect(sw2.getStpAgent().isRoot()).toBe(true);
    expect(root.getStpAgent().getRootPort()).toBe('FastEthernet0/0');
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/0')).toBe('forwarding');
    expect(root.getStpAgent().getForwardState('FastEthernet0/0')).toBe('forwarding');
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('forwarding');
    expect(root.getStpAgent().getForwardState('FastEthernet0/1')).toBe('blocking');
  });

  it('in legacy stp mode the same change walks listening → learning instead', async () => {
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    expect(['FastEthernet0/0', 'FastEthernet0/1']
      .map(p => sw2.getStpAgent().getForwardState(p))).toContain('blocking');

    sw2.getStpAgent().setBridgePriority(0);

    const states = ['FastEthernet0/0', 'FastEthernet0/1']
      .map(p => sw2.getStpAgent().getForwardState(p));
    expect(states).toContain('listening');
  });

  it('failover: the surviving port becomes root port and forwards immediately', async () => {
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await makeRoot(root);
    const a = new Cable('a');
    a.connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('blocking');

    a.disconnect();

    expect(sw2.getStpAgent().getRootPort()).toBe('FastEthernet0/1');
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('forwarding');
  });

  it('topology change uses tcWhile propagation, never TCN BPDUs', async () => {
    const bus = new EventBus();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    const sw3 = new CiscoSwitch('switch-cisco', 'SW3', 4);
    root.setEventBus(bus); sw2.setEventBus(bus); sw3.setEventBus(bus);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await setRapidPvst(sw3);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    const leaf = new Cable('b');
    leaf.connect(sw2.getPort('FastEthernet0/1')!, sw3.getPort('FastEthernet0/0')!);

    const tcns: string[] = [];
    bus.subscribe('stp.tcn.sent', (e) => tcns.push((e.payload as { deviceId: string }).deviceId));

    leaf.disconnect();

    expect(tcns).toHaveLength(0);
    expect(sw2.getStpAgent().isTopologyChangeActive()).toBe(true);
    expect(sw2.getStpAgent().isFastAgingActive()).toBe(true);
    expect(root.getStpAgent().isFastAgingActive()).toBe(true);
  });
});

describe('STP Backup port role (IEEE 802.1D-2004 §17.7)', () => {
  it('a self-superior BPDU on a shared segment yields Backup, not Alternate', async () => {
    const { Hub } = await import('@/network/devices/Hub');
    // Two ports of the SAME bridge land on one shared segment (a hub):
    // the bridge hears its own designated BPDU on its second port, the
    // textbook condition that makes a port Backup rather than Alternate.
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const hub = new Hub('HUB', 4);
    new Cable('a').connect(sw.getPort('FastEthernet0/0')!, hub.getPort('eth0')!);
    new Cable('b').connect(sw.getPort('FastEthernet0/1')!, hub.getPort('eth1')!);

    const ag = sw.getStpAgent();
    const roles = ['FastEthernet0/0', 'FastEthernet0/1']
      .map((p) => ag.getPortRole(p)).sort();
    expect(roles).toEqual(['backup', 'designated']);

    const backupPort = ag.getPortRole('FastEthernet0/0') === 'backup'
      ? 'FastEthernet0/0' : 'FastEthernet0/1';
    expect(ag.getForwardState(backupPort)).toBe('blocking');
  });

  it('a peer-superior BPDU across a point-to-point link stays Alternate', () => {
    // Sanity guard: the classic two-link topology between distinct bridges
    // must remain Alternate — Backup only applies to self-sourced BPDUs.
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    root.getStpAgent().setBridgePriority(0);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);

    const roles = ['FastEthernet0/0', 'FastEthernet0/1']
      .map((p) => sw2.getStpAgent().getPortRole(p)).sort();
    expect(roles).toEqual(['alternate', 'root']);
  });
});

describe('STP port path cost reflects link speed (Table 17-3)', () => {
  it('getPortCost derives the cost from the real interface speed', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const ag = sw.getStpAgent();
    expect(ag.getPortCost('FastEthernet0/0')).toBe(19);
    sw.getPort('FastEthernet0/0')!.setSpeed(1000);
    expect(ag.getPortCost('FastEthernet0/0')).toBe(4);
    sw.getPort('FastEthernet0/0')!.setSpeed(10000);
    expect(ag.getPortCost('FastEthernet0/0')).toBe(2);
  });

  it('show spanning-tree renders the real cost and the Backup role', async () => {
    const { Hub } = await import('@/network/devices/Hub');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const hub = new Hub('HUB', 4);
    new Cable('a').connect(sw.getPort('FastEthernet0/0')!, hub.getPort('eth0')!);
    new Cable('b').connect(sw.getPort('FastEthernet0/1')!, hub.getPort('eth1')!);
    await sw.executeCommand('enable');

    const out = await sw.executeCommand('show spanning-tree');
    expect(out).toContain('Back');             // backup role is rendered
    expect(out).toMatch(/Desg\s+FWD\s+19\b/);  // real FastEthernet cost
  });
});

describe('STP link type (RSTP operPointToPoint, 802.1D-2004 §6.4.3)', () => {
  it('getPortLinkType is p2p on full duplex and shared on half duplex', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const ag = sw.getStpAgent();
    expect(ag.getPortLinkType('FastEthernet0/0')).toBe('p2p');
    sw.getPort('FastEthernet0/0')!.setDuplex('half');
    expect(ag.getPortLinkType('FastEthernet0/0')).toBe('shared');
  });

  it('show spanning-tree renders Shr for shared links and P2p Edge for portfast', async () => {
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    root.getStpAgent().setBridgePriority(0);
    const edge = new CiscoSwitch('switch-cisco', 'EDGE', 4);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(sw2.getPort('FastEthernet0/1')!, edge.getPort('FastEthernet0/0')!);
    sw2.getPort('FastEthernet0/0')!.setDuplex('half');
    sw2.getStpAgent().setPortFast('FastEthernet0/1', true);
    await sw2.executeCommand('enable');

    const out = await sw2.executeCommand('show spanning-tree');
    expect(out).toMatch(/Fa0\/0.*Shr/);        // half-duplex link is shared
    expect(out).toMatch(/Fa0\/1.*P2p Edge/);   // portfast edge port
  });

  it('a shared designated port walks the timers; the rstp proposal is suppressed', async () => {
    // The initial bring-up forwards instantly in every mode (a documented
    // usability shortcut), so — like the legacy-STP test — we force a
    // re-transition AFTER bring-up to observe the link-type behaviour.
    vi.useFakeTimers();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    await setRapidPvst(root);
    await setRapidPvst(sw2);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    new Cable('b').connect(root.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    sw2.getPort('FastEthernet0/1')!.setDuplex('half');   // shared segment
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('blocking');

    // SW2 becomes root: its blocked FE0/1 turns designated and re-transitions.
    sw2.getStpAgent().setBridgePriority(0);

    expect(sw2.getStpAgent().isRoot()).toBe(true);
    // On a p2p link this would rapid-forward via proposal/agreement; on a
    // shared link RSTP must fall back to the timed listening walk.
    expect(sw2.getStpAgent().getForwardState('FastEthernet0/1')).toBe('listening');
  });
});
