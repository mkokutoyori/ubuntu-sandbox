/**
 * PRD-Port-Forwarding.md Phase 2 — NAT/ACL evaluation order in Router.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

interface InboundLab {
  srv: LinuxServer;
  outside: LinuxServer;
}

async function buildInboundLab(aclLines: string[]): Promise<InboundLab> {
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
    ...aclLines,
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside',
  ];
  if (aclLines.length > 0) cmds.push('ip access-group 100 in');
  cmds.push(
    'no shutdown', 'exit',
    `ip nat inside source static tcp ${SRV_IP} ${INTERNAL_PORT} ${GW_OUTSIDE} ${PUBLIC_PORT}`,
    'end',
  );
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { srv, outside };
}

interface OutboundLab {
  pc: LinuxPC;
  outside: LinuxServer;
}

async function buildOutboundLab(aclLines: string[]): Promise<OutboundLab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pc.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const lanMask = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), lanMask);
  pc.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.252');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  const cmds = [
    'enable', 'configure terminal',
    ...aclLines,
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside',
  ];
  if (aclLines.length > 0) cmds.push('ip access-group 101 out');
  cmds.push(
    'no shutdown', 'exit',
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    'end',
  );
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { pc, outside };
}

describe('PRD-Port-Forwarding.md Phase 2 — inbound ACL sees the pre-DNAT public address', () => {
  it('a permit written against the public IP:port allows the forwarded connection', async () => {
    const { srv, outside } = await buildInboundLab([
      `access-list 100 permit tcp any host ${GW_OUTSIDE} eq ${PUBLIC_PORT}`,
    ]);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
  });

  it('a deny written against the public IP:port blocks the forwarded connection', async () => {
    const { srv, outside } = await buildInboundLab([
      `access-list 100 deny tcp any host ${GW_OUTSIDE} eq ${PUBLIC_PORT}`,
      'access-list 100 permit ip any any',
    ]);
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: () => {} });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket!.state).not.toBe('established');
  });

  it('with no ACL at all the forwarded connection still completes (no regression)', async () => {
    const { srv, outside } = await buildInboundLab([]);
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(INTERNAL_PORT, { onAccept: (s) => { accepted = s; } });

    const clientSocket = outside.getTcpStack().connect(GW_OUTSIDE, PUBLIC_PORT);

    expect(clientSocket!.state).toBe('established');
    expect(accepted).not.toBeNull();
  });
});

describe('PRD-Port-Forwarding.md Phase 2 — outbound ACL sees the post-SNAT public address', () => {
  it('a permit written against the post-SNAT public IP allows PATed traffic out', async () => {
    const { pc } = await buildOutboundLab([
      `access-list 101 permit ip host ${GW_OUTSIDE} any`,
    ]);

    const out = await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('a deny written against the post-SNAT public IP blocks PATed traffic out', async () => {
    const { pc } = await buildOutboundLab([
      `access-list 101 deny ip host ${GW_OUTSIDE} any`,
      'access-list 101 permit ip any any',
    ]);

    const out = await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('with no ACL at all PATed traffic still goes out (no regression)', async () => {
    const { pc } = await buildOutboundLab([]);

    const out = await pc.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

    expect(out).toMatch(/, 0% packet loss/);
  });
});
