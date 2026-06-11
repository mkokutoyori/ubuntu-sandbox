/**
 * STP Topology Change Notification machinery (IEEE 802.1D-1998 §8.6.14)
 *
 * Before this suite existed, TCN BPDUs were silently dropped
 * (`bpduType !== 'config'`), the TC/TCA flags were hardwired to false,
 * and MAC tables kept their 300 s aging through reconvergence — stale
 * paths lingered for minutes after a link failure.
 *
 *  - losing an active port raises a TCN toward the root;
 *  - the designated bridge (here the root) acks with TCA and starts
 *    the tcWhile period (TC flag for max age + forward delay);
 *  - bridges seeing TC=1 on their root port shorten MAC aging to
 *    forward delay (§8.3.5) and propagate the flag;
 *  - PortFast (edge) ports never generate topology changes;
 *  - tcWhile expiry restores normal aging everywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
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

async function makeRoot(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('spanning-tree vlan 1 priority 4096');
  await sw.executeCommand('end');
}

/** ROOT —— SW2 —— SW3 chain on a shared bus, with event capture. */
async function buildChain() {
  const bus = new EventBus();
  const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
  const sw3 = new CiscoSwitch('switch-cisco', 'SW3', 4);
  root.setEventBus(bus); sw2.setEventBus(bus); sw3.setEventBus(bus);
  await makeRoot(root);
  const events: Array<{ topic: string; deviceId: string }> = [];
  for (const topic of ['stp.tcn.sent', 'stp.tcn.received', 'stp.topology-change.detected']) {
    bus.subscribe(topic, (e) => events.push({ topic, deviceId: (e.payload as { deviceId: string }).deviceId }));
  }
  new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
  const leaf = new Cable('b');
  leaf.connect(sw2.getPort('FastEthernet0/1')!, sw3.getPort('FastEthernet0/0')!);
  expect(root.getStpAgent().isRoot()).toBe(true);
  expect(sw2.getStpAgent().isRoot()).toBe(false);
  events.length = 0; // ignore bring-up noise
  return { bus, root, sw2, sw3, leaf, events };
}

describe('STP topology change notification', () => {
  it('a lost active link raises a TCN toward the root, which acks it', async () => {
    const { root, sw2, leaf, events } = await buildChain();

    leaf.disconnect();

    expect(events.some(e => e.topic === 'stp.tcn.sent' && e.deviceId === sw2.id)).toBe(true);
    expect(events.some(e => e.topic === 'stp.tcn.received' && e.deviceId === root.id)).toBe(true);
    // The synchronous TCA stopped retransmission: exactly one TCN went out.
    expect(events.filter(e => e.topic === 'stp.tcn.sent' && e.deviceId === sw2.id).length).toBe(1);
  });

  it('the root raises the TC flag and every bridge runs fast MAC aging', async () => {
    const { root, sw2, leaf } = await buildChain();

    leaf.disconnect();

    expect(root.getStpAgent().isTopologyChangeActive()).toBe(true);
    expect(root.getStpAgent().isFastAgingActive()).toBe(true);
    // SW2 mirrored TC=1 from the root port BPDU (sent eagerly by the root).
    expect(sw2.getStpAgent().isFastAgingActive()).toBe(true);
  });

  it('tcWhile expiry (max age + forward delay) restores normal aging', async () => {
    vi.useFakeTimers();
    const { root, sw2, leaf } = await buildChain();

    leaf.disconnect();
    expect(root.getStpAgent().isFastAgingActive()).toBe(true);

    // Default 20 s max age + 15 s forward delay, plus a hello so SW2
    // hears the TC=0 BPDU after the root's tcWhile period elapses.
    vi.advanceTimersByTime(38_000);

    expect(root.getStpAgent().isTopologyChangeActive()).toBe(false);
    expect(root.getStpAgent().isFastAgingActive()).toBe(false);
    expect(sw2.getStpAgent().isFastAgingActive()).toBe(false);
  });

  it('fast aging actually flushes dynamic MAC entries at forward delay', async () => {
    vi.useFakeTimers();
    const { sw2, sw3, leaf } = await buildChain();

    // Learn a dynamic MAC on SW2 by sending a real frame from SW3.
    sw3.getPort('FastEthernet0/0')!.sendFrame({
      srcMAC: new MACAddress('aa:aa:aa:aa:aa:01'),
      dstMAC: MACAddress.broadcast(),
      etherType: 0x0806,
      payload: {
        type: 'arp', operation: 'request',
        senderMAC: new MACAddress('aa:aa:aa:aa:aa:01'),
        senderIP: new IPAddress('10.9.9.9'),
        targetMAC: MACAddress.broadcast(),
        targetIP: new IPAddress('10.9.9.1'),
      } as never,
    });
    const hasMac = () => sw2.getMACTable().some(
      e => e.mac === 'aa:aa:aa:aa:aa:01' && e.type === 'dynamic');
    expect(hasMac()).toBe(true);

    leaf.disconnect();
    expect(sw2.getStpAgent().isFastAgingActive()).toBe(true);

    // 15 s forward delay < 300 s default: the entry must be gone soon.
    vi.advanceTimersByTime(17_000);
    expect(hasMac()).toBe(false);
  });

  it('a PortFast (edge) port going down does NOT generate a topology change', async () => {
    const bus = new EventBus();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    const pc = new LinuxPC('linux-pc', 'H1');
    root.setEventBus(bus); sw2.setEventBus(bus);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    sw2.getStpAgent().setPortFast('FastEthernet0/2', true);
    const edge = new Cable('e');
    edge.connect(sw2.getPort('FastEthernet0/2')!, pc.getPort('eth0')!);

    const tcns: string[] = [];
    bus.subscribe('stp.tcn.sent', (e) => tcns.push((e.payload as { deviceId: string }).deviceId));

    edge.disconnect();

    expect(tcns).toHaveLength(0);
    expect(root.getStpAgent().isTopologyChangeActive()).toBe(false);
  });

  it('the same edge drop without PortFast DOES notify (contrast)', async () => {
    const bus = new EventBus();
    const root = new CiscoSwitch('switch-cisco', 'ROOT', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    const pc = new LinuxPC('linux-pc', 'H1');
    root.setEventBus(bus); sw2.setEventBus(bus);
    await makeRoot(root);
    new Cable('a').connect(root.getPort('FastEthernet0/0')!, sw2.getPort('FastEthernet0/0')!);
    const edge = new Cable('e');
    edge.connect(sw2.getPort('FastEthernet0/2')!, pc.getPort('eth0')!);

    const tcns: string[] = [];
    bus.subscribe('stp.tcn.sent', (e) => tcns.push((e.payload as { deviceId: string }).deviceId));

    edge.disconnect();

    expect(tcns).toContain(sw2.id);
    expect(root.getStpAgent().isTopologyChangeActive()).toBe(true);
  });
});
