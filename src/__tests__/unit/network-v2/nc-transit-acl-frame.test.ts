/**
 * nc through a filtering router — coverage the suite lacked, and a guard
 * for the frame-only fix the TODO tracks.
 *
 * Measured (Rule 7). nc gates a connection on BOTH transitTcpAclVerdict
 * (a synthetic-SYN replay over evaluateACLByName) AND the real
 * ctx.net.tcpConnectOutcome probe, so the question was whether the replay
 * is redundant. Forcing transitTcpAclVerdict to 'permit' and re-running,
 * the DENY case reports "succeeded", not "timed out": the real TCP connect
 * path does NOT suffer a transit router's ACL — it never reaches the
 * router's evaluateForDataPlane. So the replay is LOAD-BEARING today, not a
 * removable duplicate; the ACL verdict on an ssh/nc/telnet connection is
 * still replayed, not suffered on the wire (TODO: "[ssh] ssh entre deux
 * hotes ne traverse PAS le fil").
 *
 * This file guards the verdict as it stands and will pass through the real
 * data plane the day tcpConnectOutcome crosses transit ACLs.
 *
 * Discrimination: the WITNESS (no ACL) succeeds either way; the DENY case
 * needs transitTcpAclVerdict active — neutralising it makes the DENY case
 * report "succeeded" (measured), which is what proves the gate load-bearing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab(acl: readonly string[]) {
  const router = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('c2').connect(router.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const line of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...acl,
    ...(acl.length ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
    'end']) {
    await router.executeCommand(line);
  }
  pc.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('10.0.1.1'));
  srv.configureInterface('eth0', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
  srv.setDefaultGateway(new IPAddress('10.0.2.1'));
  await pc.executeCommand('ping -c 1 10.0.2.10');
  await srv.executeCommand('sudo systemctl start ssh');
  return { pc, srv };
}

async function ncVerbose(pc: LinuxPC, ip: string, port: number): Promise<string> {
  return (await pc.executeCommand(`nc -v -w 1 -z ${ip} ${port}`)).trim();
}

describe('nc through a filtering router', () => {
  it('WITNESS: with no list, nc reaches the open ssh port', async () => {
    const { pc } = await lab([]);
    expect(await ncVerbose(pc, '10.0.2.10', 22)).toMatch(/succeeded/i);
  });

  it('deny ip any any times the connection out', async () => {
    const { pc } = await lab(['access-list 100 deny ip any any']);
    expect(await ncVerbose(pc, '10.0.2.10', 22)).toMatch(/timed out/i);
  });

  it('permit tcp any any eq 22 restores it, eq 23 does not', async () => {
    const { pc: allow } = await lab([
      'access-list 100 permit tcp any any eq 22',
      'access-list 100 deny ip any any',
    ]);
    expect(await ncVerbose(allow, '10.0.2.10', 22)).toMatch(/succeeded/i);

    const { pc: wrong } = await lab([
      'access-list 100 permit tcp any any eq 23',
      'access-list 100 deny ip any any',
    ]);
    expect(await ncVerbose(wrong, '10.0.2.10', 22)).toMatch(/timed out/i);
  });
});
