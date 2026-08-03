/**
 * PRD-Port-Forwarding.md Phase 1 — the reply leg of a port-forwarding NAT
 * entry.
 *
 * Before this fix, `NATEngine.translateOutbound()` skipped every static
 * entry carrying a `protocol` (i.e. every port-forwarding entry, Cisco
 * `ip nat inside source static tcp|udp` / Huawei `nat server`): the inside
 * server's reply was therefore never re-addressed to the public IP:port the
 * external client is expecting. Either it fell through to a coexisting
 * PAT/overload rule and got mis-translated to a random ephemeral port, or —
 * with no such rule — it left with the server's unmodified private
 * RFC 1918 source address. Either way the external client could never
 * complete the connection, despite `show ip nat translations`/`display nat
 * server` and hit counters showing the redirection as configured and "hit".
 *
 * These tests drive a real 3-way TCP handshake end to end through a genuine
 * `CiscoRouter`/`HuaweiRouter` topology (`TcpStack.connect()`/`.listen()`,
 * not the `nc`/`findHostByAddress` shortcut that bypasses the real NAT
 * translation path) — the only way to actually observe this bug and its
 * fix, since every prior port-forwarding test asserted on config/hit-count
 * visibility rather than real delivery.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { TcpSocket } from '@/network/tcp/TcpStack';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const SRV_IP = '192.168.10.10';
const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';
const PUBLIC_PORT = 8080;
const INTERNAL_PORT = 80;

interface Lab {
  srv: LinuxServer;
  outside: LinuxServer;
}

async function buildCiscoLab(withOverload: boolean, protocol: 'tcp' | 'udp' = 'tcp'): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(srv.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const lanMask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress(SRV_IP), lanMask);
  srv.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.252');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  const cmds = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside', 'no shutdown', 'exit',
  ];
  if (withOverload) {
    cmds.push(
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    );
  }
  cmds.push(
    `ip nat inside source static ${protocol} ${SRV_IP} ${INTERNAL_PORT} ${GW_OUTSIDE} ${PUBLIC_PORT}`,
    'end',
  );
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { srv, outside };
}

async function buildHuaweiLab(withOverload: boolean, protocol: 'tcp' | 'udp' = 'tcp'): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new HuaweiRouter('HW1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(srv.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GE0/0/0')!);
  new Cable('e').connect(router.getPort('GE0/0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const lanMask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress(SRV_IP), lanMask);
  srv.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.252');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  const cmds = ['system-view'];
  if (withOverload) {
    cmds.push(
      'acl 2000',
      'rule 5 permit source 192.168.10.0 0.0.0.255',
      'quit',
    );
  }
  cmds.push(
    'interface GE0/0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'nat inside', 'undo shutdown', 'quit',
    'interface GE0/0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'undo shutdown',
  );
  if (withOverload) cmds.push('nat outbound 2000');
  cmds.push(
    `nat server protocol ${protocol} global ${GW_OUTSIDE} ${PUBLIC_PORT} inside ${SRV_IP} ${INTERNAL_PORT}`,
    'quit',
  );
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { srv, outside };
}

describe('PRD-Port-Forwarding.md Phase 1 — port-forward reply leg (Cisco)', () => {
  it('a real handshake completes with a coexisting PAT overload rule (the common case every existing lab configures)', async () => {
    const { srv, outside } = await buildCiscoLab(true);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
    expect(accepted!.state).toBe('established');
  });

  it('a real handshake completes with no coexisting PAT rule at all (no private-IP leak on the reply)', async () => {
    const { srv, outside } = await buildCiscoLab(false);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
  });

  it('data actually flows both ways once the connection is established', async () => {
    const { srv, outside } = await buildCiscoLab(true);
    const received: string[] = [];
    srv.getTcpStack().listen(INTERNAL_PORT, {
      onAccept: (s) => { s.onData((d) => { received.push(d as string); s.send('HTTP/1.0 200 OK\r\n\r\n'); }); },
    });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT)!;
    const clientReceived: string[] = [];
    clientSocket.onData((d) => clientReceived.push(d as string));
    clientSocket.send('GET / HTTP/1.0\r\n\r\n');

    expect(received.join('')).toBe('GET / HTTP/1.0\r\n\r\n');
    expect(clientReceived.join('')).toBe('HTTP/1.0 200 OK\r\n\r\n');
  });
});

describe('PRD-Port-Forwarding.md Phase 1 — port-forward reply leg (Huawei)', () => {
  it('a real handshake completes with a coexisting nat outbound (Easy IP) rule', async () => {
    const { srv, outside } = await buildHuaweiLab(true);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
    expect(accepted!.state).toBe('established');
  });

  it('a real handshake completes with no coexisting nat outbound rule at all', async () => {
    const { srv, outside } = await buildHuaweiLab(false);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
  });
});

describe('PRD-Port-Forwarding.md Phase 3 — port-forward reply leg (UDP, Cisco and Huawei)', () => {
  it('a UDP datagram round-trips through a redirected port (Cisco)', async () => {
    const { srv, outside } = await buildCiscoLab(true, 'udp');
    const receivedAtSrv: string[] = [];
    srv.udpBind(INTERNAL_PORT, (d) => {
      receivedAtSrv.push(d.udp.payload as string);
      srv.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, INTERNAL_PORT, 'pong', 4);
    });
    const receivedAtOutside: string[] = [];
    outside.udpBind(40000, (d) => receivedAtOutside.push(d.udp.payload as string));

    const sent = outside.sendUdpDatagram(new IPAddress(GW_OUTSIDE), PUBLIC_PORT, 40000, 'ping', 4);

    expect(sent).toBe(true);
    expect(receivedAtSrv).toEqual(['ping']);
    expect(receivedAtOutside).toEqual(['pong']);
  });

  it('a UDP datagram round-trips through a redirected port with no coexisting PAT rule (Cisco)', async () => {
    const { srv, outside } = await buildCiscoLab(false, 'udp');
    const receivedAtSrv: string[] = [];
    srv.udpBind(INTERNAL_PORT, (d) => receivedAtSrv.push(d.udp.payload as string));

    const sent = outside.sendUdpDatagram(new IPAddress(GW_OUTSIDE), PUBLIC_PORT, 40000, 'ping', 4);

    expect(sent).toBe(true);
    expect(receivedAtSrv).toEqual(['ping']);
  });

  it('a UDP datagram round-trips through a redirected port (Huawei)', async () => {
    const { srv, outside } = await buildHuaweiLab(true, 'udp');
    const receivedAtSrv: string[] = [];
    srv.udpBind(INTERNAL_PORT, (d) => {
      receivedAtSrv.push(d.udp.payload as string);
      srv.sendUdpDatagram(d.sourceIP as IPAddress, d.udp.sourcePort, INTERNAL_PORT, 'pong', 4);
    });
    const receivedAtOutside: string[] = [];
    outside.udpBind(40000, (d) => receivedAtOutside.push(d.udp.payload as string));

    const sent = outside.sendUdpDatagram(new IPAddress(GW_OUTSIDE), PUBLIC_PORT, 40000, 'ping', 4);

    expect(sent).toBe(true);
    expect(receivedAtSrv).toEqual(['ping']);
    expect(receivedAtOutside).toEqual(['pong']);
  });

  it('a UDP datagram round-trips through a redirected port with no coexisting nat outbound rule (Huawei)', async () => {
    const { srv, outside } = await buildHuaweiLab(false, 'udp');
    const receivedAtSrv: string[] = [];
    srv.udpBind(INTERNAL_PORT, (d) => receivedAtSrv.push(d.udp.payload as string));

    const sent = outside.sendUdpDatagram(new IPAddress(GW_OUTSIDE), PUBLIC_PORT, 40000, 'ping', 4);

    expect(sent).toBe(true);
    expect(receivedAtSrv).toEqual(['ping']);
  });
});
