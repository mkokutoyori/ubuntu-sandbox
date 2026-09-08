/**
 * The real SSH exec client drives the sshd handler over a genuine TCP
 * connection: SSH exec must cross the wire, not reach the peer object.
 *
 * Measured (Rule 7). sshWireExec connect()s the client's own TcpStack to the
 * server's port 22, speaks the hello/auth/open_channel/exec sequence
 * (RFC 4253/4254 ordering, matching OpenSSH clientloop.c), and returns the
 * remote command's output. WITNESS: a direct link runs `whoami` and returns
 * the remote user AND the client's SocketTable records a real connection to
 * :22 — proof the exchange put frames on the wire. DISCRIMINATION: a wrong
 * password is refused by the server (not the client), and a transit
 * `deny ip any any` router makes connect() fail (ICMP prohibited) so no
 * session is established — the ACL is suffered on the wire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { sshWireExec, type SshWireStack } from '@/network/protocols/ssh/SshWireClient';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function stackOf(dev: LinuxPC): SshWireStack {
  return (dev as unknown as { getTcpStack: () => SshWireStack }).getTcpStack();
}

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

describe('SSH exec crosses the wire', () => {
  it('WITNESS: runs the remote command and records a real :22 connection', async () => {
    const { pc } = await directLab();
    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.0.10', port: 22, user: 'alice', password: 'secret123',
      command: 'whoami',
    });
    expect(r.connected).toBe(true);
    expect(r.authenticated).toBe(true);
    expect(r.stdout.trim()).toBe('alice');
    expect(r.hostKey?.publicKey).toBeTruthy();

    const sockets = (pc as unknown as { getTcpStack: () => { listSockets: () => Array<{ remotePort: number; remoteIp: string }> } })
      .getTcpStack().listSockets();
    expect(sockets.some(s => s.remoteIp === '10.0.0.10' && s.remotePort === 22)).toBe(true);
  });

  it('wrong password is refused by the server, still a real connection', async () => {
    const { pc } = await directLab();
    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.0.10', port: 22, user: 'alice', password: 'nope',
      command: 'whoami',
    });
    expect(r.connected).toBe(true);
    expect(r.authenticated).toBe(false);
    expect(r.stdout).toBe('');
  });

  it('a deny-ip-any-any transit router blocks the session on the wire', async () => {
    const { pc } = await routedLab(['access-list 100 deny ip any any']);
    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.2.10', port: 22, user: 'alice', password: 'secret123',
      command: 'whoami',
    });
    expect(r.authenticated).toBe(false);
    expect(r.stdout.trim()).not.toBe('alice');
  });

  it('WITNESS through a permitting router: exec still crosses', async () => {
    const { pc } = await routedLab([
      'access-list 100 permit tcp any any eq 22',
      'access-list 100 permit icmp any any',
      'access-list 100 deny ip any any',
    ]);
    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.2.10', port: 22, user: 'alice', password: 'secret123',
      command: 'whoami',
    });
    expect(r.authenticated).toBe(true);
    expect(r.stdout.trim()).toBe('alice');
  });
});
