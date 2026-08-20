/**
 * PRD-Port-Forwarding.md Phase 3 — `ip nat outside source static` (Cisco)
 * applied to the data plane.
 *
 * `NATEngine.addStaticEntry`/`getOutsideStaticEntries()` already stored and
 * rendered this config, but `translateInbound()`/`translateOutbound()`
 * never consulted it — the command was accepted and appeared in
 * `show running-config` with zero effect on any real packet. These tests
 * drive real UDP datagrams through a live `CiscoRouter` and inspect what
 * each end actually observes (source/destination address), since a ping
 * pass/fail alone can't distinguish "translated" from "coincidentally
 * routable".
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

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const PC_IP = '192.168.10.10';
const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_REAL_IP = '203.0.113.2';
// Deliberately in an unrelated subnet from the outside interface — the
// point of this feature is that the alias never needs to be routable,
// since translateInbound() resolves it before the FIB lookup ever runs.
const OUTSIDE_ALIAS_IP = '198.51.100.50';

interface Lab { pc: LinuxPC; outside: LinuxServer; }

async function buildLab(withOutsideStatic: boolean): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(pc.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('d').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const lanMask = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), lanMask);
  pc.setDefaultGateway(new IPAddress(GW_INSIDE));

  const wanMask = new SubnetMask('255.255.255.0');
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_REAL_IP), wanMask);
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  const cmds = [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.0`,
    'ip nat outside', 'no shutdown', 'exit',
  ];
  if (withOutsideStatic) {
    cmds.push(`ip nat outside source static ${OUTSIDE_REAL_IP} ${OUTSIDE_ALIAS_IP}`);
  }
  cmds.push('end');
  for (const cmd of cmds) await router.executeCommand(cmd);

  return { pc, outside };
}

describe('PRD-Port-Forwarding.md Phase 3 — ip nat outside source static', () => {
  it('an inside host addressing the outside-local alias reaches the real outside host', async () => {
    const { pc, outside } = await buildLab(true);
    const received: { srcIp: string; dstIp: string }[] = [];
    outside.udpBind(9000, (d) => received.push({
      srcIp: d.sourceIP.toString(), dstIp: d.destinationIP.toString(),
    }));

    const ok = pc.sendUdpDatagram(new IPAddress(OUTSIDE_ALIAS_IP), 9000, 12345, 'hello', 5);

    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].dstIp).toBe(OUTSIDE_REAL_IP);
    expect(received[0].srcIp).toBe(PC_IP);
  });

  it('a datagram from the real outside host is presented to the inside network under its local alias', async () => {
    const { pc, outside } = await buildLab(true);
    const received: { srcIp: string }[] = [];
    pc.udpBind(9000, (d) => received.push({ srcIp: d.sourceIP.toString() }));

    const ok = outside.sendUdpDatagram(new IPAddress(PC_IP), 9000, 12345, 'hello', 5);

    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].srcIp).toBe(OUTSIDE_ALIAS_IP);
  });

  it('without the outside-static entry the alias is simply unreachable (no regression / no accidental routability)', async () => {
    const { pc, outside } = await buildLab(false);
    const received: unknown[] = [];
    outside.udpBind(9000, () => received.push(true));

    pc.sendUdpDatagram(new IPAddress(OUTSIDE_ALIAS_IP), 9000, 12345, 'hello', 5);

    expect(received).toHaveLength(0);
  });
});
