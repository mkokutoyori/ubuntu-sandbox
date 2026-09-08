/**
 * Coherence across TCP/IP client commands through a filtering router: each
 * command that opens a real TCP connection must SUFFER the transit ACL on
 * the wire, and report the failure — never fall through to success.
 *
 * Measured (Rule 7). A `deny ip any any` router answers ICMP administratively-
 * prohibited, so TcpStack.connectOutcome returns 'prohibited'. The class of
 * bug this guards is a command that fails to handle that outcome and prints
 * success (nc did, before the accompanying fix). WITNESSES (no ACL) prove the
 * lab reaches the service, so a failure under DENY is the list biting, not a
 * broken lab.
 *
 * Scope: the commands whose reachability rides the real probe —
 * nc / nmap / openssl s_client / curl. ssh and telnet still gate on
 * transitTcpAclVerdict / isPathReachable (TODO: the session does not cross the
 * wire yet), so they are out of this file's frame-only claim.
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
  await srv.executeCommand('sudo systemctl start nginx');
  return { pc, srv };
}

const DENY = ['access-list 100 deny ip any any'];

describe('TCP/IP client commands suffer the transit ACL coherently', () => {
  it('nc: witness succeeds, deny is refused on the wire', async () => {
    const { pc: open } = await lab([]);
    expect(await open.executeCommand('nc -v -w 1 -z 10.0.2.10 22')).toMatch(/succeeded/i);
    const { pc: blocked } = await lab(DENY);
    expect(await blocked.executeCommand('nc -v -w 1 -z 10.0.2.10 22')).toMatch(/Permission denied|timed out/i);
  });

  it('nmap: witness reports open, deny filters host discovery and the port', async () => {
    const { pc: open } = await lab([]);
    expect(await open.executeCommand('nmap -p 22 10.0.2.10')).toMatch(/22\/tcp\s+open/i);
    const { pc: blocked } = await lab(DENY);
    expect(await blocked.executeCommand('nmap -p 22 10.0.2.10')).toMatch(/Host seems down/i);
    const forced = await blocked.executeCommand('nmap -Pn -p 22 10.0.2.10');
    expect(forced).not.toMatch(/22\/tcp\s+open/i);
    expect(forced).toMatch(/filtered/i);
  });

  it('openssl s_client: witness connects, deny fails to connect', async () => {
    const { pc: open } = await lab([]);
    expect(await open.executeCommand('openssl s_client -connect 10.0.2.10:22')).toMatch(/CONNECTED/i);
    const { pc: blocked } = await lab(DENY);
    expect(await blocked.executeCommand('openssl s_client -connect 10.0.2.10:22')).toMatch(/connect:errno/i);
  });

  it('curl: witness gets a page, deny cannot connect', async () => {
    const { pc: open } = await lab([]);
    expect(await open.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.0.2.10/')).toContain('200');
    const { pc: blocked } = await lab(DENY);
    const out = await blocked.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.0.2.10/');
    expect(out).not.toContain('200');
  });
});
