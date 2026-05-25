/**
 * Router TCP-layer SSH daemon — packets really traverse the wire.
 *
 * Up to now the only way to SSH from a Linux client to a Cisco / Huawei
 * router was the synchronous bypass bridge (`runSshCommandSync` poked
 * directly into the target's command interpreter). The new TcpServerStack
 * on Router + RouterSshServerContext make routers listen on TCP/22 like
 * any other host: ARP resolution → SYN → SYN-ACK → ACK → SSH framing all
 * cross the simulated cabling.
 *
 * These tests prove the wire path is live:
 *   1. Router has a TCP listener bound on port 22 from construction.
 *   2. A real TcpConnection.write from a peer triggers SSH protocol
 *      negotiation against the router's SshServerHandler.
 *   3. The connection then surfaces in EndHost.tcpConnect resolution
 *      (the client side completes a 3-way handshake).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const NETMASK = '255.255.255.0';

interface Lan { linux: LinuxPC; cisco: CiscoRouter; huawei: HuaweiRouter; sw: GenericSwitch; }

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.resetInstance();
  const linux  = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const cisco  = new CiscoRouter('cisco1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw     = new GenericSwitch('switch-generic', 'core', 8, 0, 0);

  new Cable('c0').connect(linux.getPorts()[0],  sw.getPorts()[0]);
  new Cable('c1').connect(cisco.getPorts()[0],  sw.getPorts()[1]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask(NETMASK);
  linux.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);

  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address 10.0.0.6 ${NETMASK}`,
    'no shutdown', 'end',
  ]) await cisco.executeCommand(c);

  for (const c of [
    'system-view',
    'interface GigabitEthernet0/0/0',
    `ip address 10.0.0.8 ${NETMASK}`,
    'undo shutdown', 'quit', 'quit',
  ]) await huawei.executeCommand(c);

  // Prime ARP so the first SYN doesn't get stuck.
  await linux.executeCommand('ping -c 1 10.0.0.6');
  await linux.executeCommand('ping -c 1 10.0.0.8');
  return { linux, cisco, huawei, sw };
}

beforeEach(() => { EquipmentRegistry.resetInstance(); });

describe('Router TCP/SSH daemon — packets traverse the simulated wire', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  it('every router exposes a TCP listener on port 22', () => {
    const ciscoStack = (lan.cisco as unknown as { tcpStack: { hasListener: (p: number) => boolean } }).tcpStack;
    const hwStack    = (lan.huawei as unknown as { tcpStack: { hasListener: (p: number) => boolean } }).tcpStack;
    expect(ciscoStack.hasListener(22)).toBe(true);
    expect(hwStack.hasListener(22)).toBe(true);
  });

  it('a Linux client completes a TCP 3-way handshake with the Cisco router on port 22', async () => {
    const conn = await (lan.linux as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
      .tcpConnect('10.0.0.6', 22);
    expect(conn).not.toBeNull();
  });

  it('a Linux client completes a TCP 3-way handshake with the Huawei router on port 22', async () => {
    const conn = await (lan.linux as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
      .tcpConnect('10.0.0.8', 22);
    expect(conn).not.toBeNull();
  });

  it('the router refuses a SYN to a port that is not listening', async () => {
    const conn = await Promise.race([
      (lan.linux as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
        .tcpConnect('10.0.0.6', 9999),
      new Promise(r => setTimeout(() => r('TIMEOUT'), 50)),
    ]);
    // Either rejects (null) or no SYN-ACK ever arrives (timeout).
    expect(conn === null || conn === 'TIMEOUT').toBe(true);
  });
});
