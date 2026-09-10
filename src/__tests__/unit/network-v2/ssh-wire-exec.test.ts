/**
 * SSH exec crosses the wire through the canonical SshSession, and a transit
 * router's ACL is suffered on that wire.
 *
 * Measured (Rule 7). The exec path is the one SshSession.openExecChannel()
 * .execute() already drives (PRD-SSH-Unification §6, ssh-exec-runs-on-the-wire),
 * reached here through the shared `openSshSession`/`sshExec` fixtures — no
 * second client. WITNESS: over a direct link `whoami` returns the remote user
 * AND the client's SocketTable holds a live connection to :22 while the
 * session is open. DISCRIMINATION: a transit `deny ip any any` router drops the
 * SYN so connect() never establishes; a router that permits tcp/22 lets the
 * same exec through. The difference between deny and permit is the ACL taking
 * effect on the wire, not in the client.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { isOk } from '@/network/protocols/ssh/Result';
import { openSshSession, sshExec } from './ssh-lan-fixtures';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function directLab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await srv.executeCommand('sudo systemctl start ssh');
  await pc.executeCommand('ping -c 1 10.0.0.10');
  return { pc, srv };
}

async function routedLab(acl: readonly string[]) {
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
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await srv.executeCommand('sudo systemctl start ssh');
  await pc.executeCommand('ping -c 1 10.0.2.10');
  return { pc, srv };
}

describe('SSH exec crosses the wire on SshSession', () => {
  it('WITNESS: runs the remote command and holds a real :22 connection', async () => {
    const { pc } = await directLab();
    const session = await openSshSession(pc, '10.0.0.10', 'alice', 'secret123');
    const channel = session.openExecChannel('whoami');
    expect(isOk(channel)).toBe(true);
    const result = await (isOk(channel) ? channel.value.execute() : Promise.reject());
    expect(result.stdout.trim()).toBe('alice');

    const sockets = (pc as unknown as { getTcpStack: () => { listSockets: () => Array<{ remotePort: number; remoteIp: string }> } })
      .getTcpStack().listSockets();
    expect(sockets.some(s => s.remoteIp === '10.0.0.10' && s.remotePort === 22)).toBe(true);
    session.disconnect();
  });

  it('a deny-ip-any-any transit router drops the SYN, no session establishes', async () => {
    const { pc } = await routedLab(['access-list 100 deny ip any any']);
    await expect(openSshSession(pc, '10.0.2.10', 'alice', 'secret123')).rejects.toThrow();
  });

  it('WITNESS through a permitting router: the same exec crosses', async () => {
    const { pc } = await routedLab([
      'access-list 100 permit tcp any any eq 22',
      'access-list 100 permit icmp any any',
      'access-list 100 deny ip any any',
    ]);
    const r = await sshExec(pc, '10.0.2.10', 'whoami', 'alice', 'secret123');
    expect(r.stdout.trim()).toBe('alice');
  });
});
