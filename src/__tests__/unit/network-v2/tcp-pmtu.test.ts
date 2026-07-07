/**
 * PRD-TCP.md P7 — Minimal Path MTU Discovery (RFC 1191/1981).
 *
 * Before this phase, `onIcmpUnreachable` only ever handled port-unreachable
 * and admin-prohibited — a genuine "Fragmentation Needed"/"Packet Too Big"
 * ICMP was simply ignored, and outbound TCP segments never even set the
 * DF flag (nor carried a real `totalLength`), so a router's MTU check
 * against a TCP segment could never actually fire in the first place.
 * This phase wires up both ends: DF + real segment sizing on the wire,
 * and MSS-shrink-and-resend instead of dropping the connection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function buildRoutedTopo(serverSideMtu: number) {
  const bus = new EventBus();
  const cli = new LinuxPC('CLI', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  const r1 = new CiscoRouter('R1', 0, 0);
  cli.setEventBus(bus); srv.setEventBus(bus); r1.setEventBus(bus);
  cli.powerOn(); srv.powerOn(); r1.powerOn();

  const c1 = new Cable('c1'); c1.setEventBus(bus);
  c1.connect(cli.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  const c2 = new Cable('c2'); c2.setEventBus(bus);
  c2.connect(r1.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);

  await cli.executeCommand('ifconfig eth0 10.0.1.10 netmask 255.255.255.0');
  await cli.executeCommand('ip route add default via 10.0.1.1');
  await srv.executeCommand('ifconfig eth0 10.0.2.10 netmask 255.255.255.0');
  await srv.executeCommand('ip route add default via 10.0.2.1');

  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.1.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 10.0.2.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('end');

  // Shrink the MTU toward the server so a full-size TCP data segment
  // bounces off it with ICMP Fragmentation Needed (DF is always set on
  // outbound TCP segments now).
  r1.getPort('GigabitEthernet0/1')!.setMTU(serverSideMtu);

  const scheduler = new VirtualTimeScheduler();
  cli.setScheduler(scheduler);
  srv.setScheduler(scheduler);
  r1.setScheduler(scheduler);
  return { cli, srv, r1, bus, scheduler };
}

describe('TCP Path MTU Discovery (PRD-TCP.md P7)', () => {
  it('shrinks MSS and delivers the full stream instead of dying when a router reports Fragmentation Needed', async () => {
    const { cli, srv } = await buildRoutedTopo(500);
    const received: string[] = [];
    srv.getTcpStack().listen(9200, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.2.10', 9200)! as TcpSocket;
    expect(clientSocket.mss).toBe(1460);

    clientSocket.send('P'.repeat(3000));

    expect(received.join('')).toBe('P'.repeat(3000));
    expect(clientSocket.mss).toBeLessThan(1460);
  });

  it('leaves MSS untouched and the connection healthy when the path MTU is never actually exceeded', async () => {
    const { cli, srv } = await buildRoutedTopo(1500);
    const received: string[] = [];
    srv.getTcpStack().listen(9201, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.2.10', 9201)! as TcpSocket;

    clientSocket.send('hello');

    expect(received.join('')).toBe('hello');
    expect(clientSocket.mss).toBe(1460);
  });

  it('a genuine port-unreachable (not Fragmentation Needed) still aborts the connection as a hard error (P7 regression vs. onIcmpUnreachable)', async () => {
    const { cli, srv } = await buildRoutedTopo(1500);
    srv.getTcpStack().listen(9202, { onAccept: () => {} });
    // Connect to a port nobody is listening on: the server host itself
    // sends back ICMP port-unreachable — a hard error, unrelated to MTU.
    const outcome = cli.getTcpStack().connectOutcome('10.0.2.10', 9999);
    expect(outcome).toBe('refused');
    void srv;
  });
});
