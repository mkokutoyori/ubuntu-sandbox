/**
 * PRD-Port-Forwarding.md Phase 4 — NAT on the Huawei L3 switch data plane.
 *
 * `HuaweiSwitch` has always instantiated its own `NATEngine` and exposed
 * `nat server`/`nat outbound`/`display nat ...` on it (`HuaweiSwitchShell.ts`),
 * but nothing in `Switch.ts`/`SwitchSvi.ts` ever called
 * `translateInbound()`/`translateOutbound()` — the command was accepted and
 * showed in `display current-configuration` with zero data-plane effect.
 * These tests drive a real `TcpStack` handshake across two SVIs on one
 * switch and confirm a packet is actually translated, mirroring
 * `nat-port-forward-reply-leg.test.ts`'s router-side coverage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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
const VLANIF10_IP = '192.168.10.254';
const VLANIF20_IP = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';
const PUBLIC_PORT = 8080;
const INTERNAL_PORT = 80;

async function buildLab(natCmds: string[]) {
  const sw = new HuaweiSwitch('switch-huawei', 'L3SW', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('b').connect(outside.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);

  srv.getPorts()[0].configureIP(new IPAddress(SRV_IP), new SubnetMask('255.255.255.0'));
  srv.setDefaultGateway(new IPAddress(VLANIF10_IP));
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.0'));
  outside.setDefaultGateway(new IPAddress(VLANIF20_IP));

  for (const cmd of [
    'system-view',
    'vlan batch 10 20',
    'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit',
    'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 20', 'quit',
    'interface Vlanif10',
    `ip address ${VLANIF10_IP} 255.255.255.0`,
    'undo shutdown', 'nat inside', 'quit',
    'interface Vlanif20',
    `ip address ${VLANIF20_IP} 255.255.255.0`,
    'undo shutdown',
    ...natCmds,
    'quit',
    'quit',
  ]) await sw.executeCommand(cmd);

  return { sw, srv, outside };
}

describe('PRD-Port-Forwarding.md Phase 4 — Huawei L3 switch NAT server (DNAT)', () => {
  it('a real handshake through nat server reaches the inside server', async () => {
    const { srv, outside } = await buildLab([
      `nat server protocol tcp global ${VLANIF20_IP} ${PUBLIC_PORT} inside ${SRV_IP} ${INTERNAL_PORT}`,
    ]);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(VLANIF20_IP, PUBLIC_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
    expect(accepted!.state).toBe('established');
  });

  it('data actually flows both ways once the connection is established', async () => {
    const { srv, outside } = await buildLab([
      `nat server protocol tcp global ${VLANIF20_IP} ${PUBLIC_PORT} inside ${SRV_IP} ${INTERNAL_PORT}`,
    ]);
    const received: string[] = [];
    srv.getTcpStack().listen(INTERNAL_PORT, {
      onAccept: (s) => { s.onData((d) => { received.push(d as string); s.send('HTTP/1.0 200 OK\r\n\r\n'); }); },
    });

    const clientSocket = outside.getTcpStack().connect(VLANIF20_IP, PUBLIC_PORT)!;
    const clientReceived: string[] = [];
    clientSocket.onData((d) => clientReceived.push(d as string));
    clientSocket.send('GET / HTTP/1.0\r\n\r\n');

    expect(received.join('')).toBe('GET / HTTP/1.0\r\n\r\n');
    expect(clientReceived.join('')).toBe('HTTP/1.0 200 OK\r\n\r\n');
  });

  it('without nat server configured, the public address is simply unreachable (no regression)', async () => {
    const { srv, outside } = await buildLab([]);
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: () => {} });

    const clientSocket = outside.getTcpStack().connect(VLANIF20_IP, PUBLIC_PORT);

    expect(clientSocket!.state).not.toBe('established');
  });
});

describe('PRD-Port-Forwarding.md Phase 4 — Huawei L3 switch NAT outbound (PAT)', () => {
  async function buildPatLab() {
    const sw = new HuaweiSwitch('switch-huawei', 'L3SW', 8, 0, 0);
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    const outside = new LinuxServer('linux-server', 'outside', 0, 0);

    new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
    new Cable('b').connect(outside.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);

    srv.getPorts()[0].configureIP(new IPAddress(SRV_IP), new SubnetMask('255.255.255.0'));
    srv.setDefaultGateway(new IPAddress(VLANIF10_IP));
    outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.0'));
    outside.setDefaultGateway(new IPAddress(VLANIF20_IP));

    for (const cmd of [
      'system-view',
      'vlan batch 10 20',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit',
      'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 20', 'quit',
      'acl 2000', 'rule 5 permit source 192.168.10.0 0.0.0.255', 'quit',
      'interface Vlanif10',
      `ip address ${VLANIF10_IP} 255.255.255.0`,
      'undo shutdown', 'nat inside', 'quit',
      'interface Vlanif20',
      `ip address ${VLANIF20_IP} 255.255.255.0`,
      'undo shutdown', 'nat outbound 2000', 'quit',
      'quit',
    ]) await sw.executeCommand(cmd);

    return { sw, srv, outside };
  }

  it('an inside host reaches the outside VLAN through the translated Vlanif20 address', async () => {
    const { srv, outside } = await buildPatLab();
    let accepted: TcpSocket | null = null;
    outside.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = srv.getTcpStack().connect(OUTSIDE_IP, INTERNAL_PORT);

    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
    expect(accepted!.remoteIp).toBe(VLANIF20_IP);
  });
});
