/**
 * nc through a filtering router — the ACL verdict is now SUFFERED on the
 * wire, not replayed by transitTcpAclVerdict.
 *
 * Measured (Rule 7). nc used to gate on transitTcpAclVerdict (a synthetic-SYN
 * replay over evaluateACLByName) before its real ctx.net.tcpConnectOutcome
 * probe. The probe already crosses the router and suffers evaluateForDataPlane:
 * a `deny ip any any` router answers ICMP administratively-prohibited, so
 * tcpConnectOutcome returns 'prohibited'. nc simply did not handle that
 * outcome and fell through to "succeeded", which the replay masked. Handling
 * 'prohibited' (→ "Permission denied", the rendering scan/nmap PacketTrace
 * already uses) lets the replay go: the verdict rides the real frames.
 *
 * Discrimination: the WITNESS (no ACL) succeeds; the DENY case now fails via
 * the real probe alone (transitTcpAclVerdict removed from nc); the eq22/eq23
 * pair proves the port is decided by the data plane, not a name.
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

  it('deny ip any any is refused on the wire (ICMP prohibited)', async () => {
    const { pc } = await lab(['access-list 100 deny ip any any']);
    expect(await ncVerbose(pc, '10.0.2.10', 22)).toMatch(/Permission denied/i);
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
    expect(await ncVerbose(wrong, '10.0.2.10', 22)).toMatch(/Permission denied/i);
  });
});
