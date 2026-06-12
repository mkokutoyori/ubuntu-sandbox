/**
 * TDD — EIGRP transport realism on the physical plant (journal entry:
 * backlog #16). The adjacency conversation is made of REAL IPv4
 * protocol-88 frames (multicast 224.0.0.10) leaving the router ports:
 * they cross cables AND L2 switches (multicast flooding), stop when
 * the cable is cut, and propagate learned prefixes hop by hop like the
 * real distance-vector protocol — no engine ever touches a peer
 * engine object.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IP_PROTO_EIGRP } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EventBus } from '@/events/EventBus';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function configure(r: CiscoRouter, cmds: string[]) {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const c of cmds) await r.executeCommand(c);
  await r.executeCommand('end');
}

const ifaceCmds = (name: string, ip: string, mask = '255.255.255.0') => [
  `interface ${name}`, `ip address ${ip} ${mask}`, 'no shutdown', 'exit',
];

describe('EIGRP over the physical plant', () => {
  it('adjacency forms across an L2 switch, carried by real proto-88 frames', async () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);

    const c1 = new Cable('c1'); c1.setEventBus(bus);
    const c2 = new Cable('c2'); c2.setEventBus(bus);
    c1.connect(r1.getPort('GigabitEthernet0/1')!, sw.getPorts()[0]);
    c2.connect(r2.getPort('GigabitEthernet0/1')!, sw.getPorts()[1]);

    const seenOpcodes = new Set<string>();
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number; payload?: { type?: string; opcode?: string };
      } | undefined;
      if (ipPkt?.protocol === IP_PROTO_EIGRP &&
          ipPkt.payload?.type === 'eigrp') {
        seenOpcodes.add(ipPkt.payload.opcode ?? '?');
      }
    });

    await configure(r1, [
      ...ifaceCmds('GigabitEthernet0/0', '192.168.1.1'),
      ...ifaceCmds('GigabitEthernet0/1', '10.0.0.1'),
      'router eigrp 100',
      'network 192.168.1.0 0.0.0.255',
      'network 10.0.0.0 0.0.0.255',
    ]);
    await configure(r2, [
      ...ifaceCmds('GigabitEthernet0/0', '192.168.2.1'),
      ...ifaceCmds('GigabitEthernet0/1', '10.0.0.2'),
      'router eigrp 100',
      'network 192.168.2.0 0.0.0.255',
      'network 10.0.0.0 0.0.0.255',
    ]);

    // The conversation really happened on the wire, through the switch.
    expect(seenOpcodes).toContain('hello');
    expect(seenOpcodes).toContain('update');

    const nbr1 = await r1.executeCommand('show ip eigrp neighbors');
    expect(nbr1).toContain('10.0.0.2');
    expect(await r1.executeCommand('show ip route'))
      .toMatch(/D\s+192\.168\.2\.0\/24 \[90\/\d+\] via 10\.0\.0\.2/);
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/D\s+192\.168\.1\.0\/24 \[90\/\d+\] via 10\.0\.0\.1/);
  });

  it('a cut cable genuinely interrupts the conversation: neighbour and route expire', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const cable = new Cable('wan');
    cable.connect(r1.getPort('GigabitEthernet0/1')!,
      r2.getPort('GigabitEthernet0/1')!);

    for (const [r, lan] of [[r1, '192.168.1.1'], [r2, '192.168.2.1']] as const) {
      await configure(r, [
        ...ifaceCmds('GigabitEthernet0/0', lan),
        ...ifaceCmds('GigabitEthernet0/1', r === r1 ? '10.0.0.1' : '10.0.0.2'),
        'router eigrp 100',
        'network 192.168.0.0 0.0.255.255',
        'network 10.0.0.0 0.0.0.255',
      ]);
    }
    expect(await r1.executeCommand('show ip eigrp neighbors'))
      .toContain('10.0.0.2');

    cable.disconnect();

    // The next hello round (triggered by the show) hears nothing back.
    expect(await r1.executeCommand('show ip eigrp neighbors'))
      .not.toContain('10.0.0.2');
    expect(await r1.executeCommand('show ip route'))
      .not.toMatch(/D\s+192\.168\.2\.0/);
  });

  it('multi-hop: prefixes propagate hop by hop and the data path follows', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const r3 = new CiscoRouter('R3');
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/1')!,
      r2.getPort('GigabitEthernet0/0')!);
    new Cable('c23').connect(r2.getPort('GigabitEthernet0/1')!,
      r3.getPort('GigabitEthernet0/0')!);

    await configure(r1, [
      ...ifaceCmds('GigabitEthernet0/0', '192.168.1.1'),
      ...ifaceCmds('GigabitEthernet0/1', '10.0.12.1'),
      'router eigrp 100',
      'network 192.168.1.0 0.0.0.255',
      'network 10.0.0.0 0.0.255.255',
    ]);
    await configure(r2, [
      ...ifaceCmds('GigabitEthernet0/0', '10.0.12.2'),
      ...ifaceCmds('GigabitEthernet0/1', '10.0.23.2'),
      'router eigrp 100',
      'network 10.0.0.0 0.0.255.255',
    ]);
    await configure(r3, [
      ...ifaceCmds('GigabitEthernet0/0', '10.0.23.3'),
      ...ifaceCmds('GigabitEthernet0/1', '172.16.0.1'),
      'router eigrp 100',
      'network 10.0.0.0 0.0.255.255',
      'network 172.16.0.0 0.0.0.255',
    ]);

    // R1 learned a TWO-hop prefix, via R2 (real distance-vector
    // propagation, impossible with single-hop originated-only models).
    expect(await r1.executeCommand('show ip route'))
      .toMatch(/D\s+172\.16\.0\.0\/24 \[90\/\d+\] via 10\.0\.12\.2/);

    // …and the packets really get there.
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('ping 172.16.0.1');
    expect(out).toContain('Success rate is');
    expect(out).toMatch(/[1-5]\/[1-5]/);
  });
});
