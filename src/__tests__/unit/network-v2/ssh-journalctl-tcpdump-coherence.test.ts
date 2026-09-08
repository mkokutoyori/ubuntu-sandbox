/**
 * One SSH session, three coherent views: the ssh client output, the server's
 * journalctl (sshd), and the client's tcpdump. Rule 3 (views agree) meets
 * Rule 4 (real frames): a session that crosses the wire must be visible in
 * all three, and a session the wire refuses must be absent from all three.
 *
 * Measured (Rule 7). sshWireExec drives the real sshd over TCP, so:
 *   - ssh   -> the remote command output;
 *   - journalctl -u ssh (server) -> Accepted/Failed password + session lines;
 *   - tcpdump -i eth0 (client) -> the real SYN/handshake to :22.
 * WITNESS: a successful exec shows the user in all three. DISCRIMINATION: a
 * wrong password still crossed the wire (tcpdump + journalctl see the
 * connection, journal says "Failed password", ssh says not authenticated) —
 * the real-login-precedes-command point of Rule 4; and a deny-ACL router
 * leaves NO journal session and NO established handshake — coherent absence.
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

const stackOf = (d: LinuxPC) => (d as unknown as { getTcpStack: () => SshWireStack }).getTcpStack();

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

async function routedDenyLab() {
  const router = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  new Cable('c2').connect(router.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const line of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    'access-list 100 deny ip any any',
    'interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit', 'end']) {
    await router.executeCommand(line);
  }
  pc.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('10.0.1.1'));
  srv.configureInterface('eth0', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
  srv.setDefaultGateway(new IPAddress('10.0.2.1'));
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await srv.executeCommand('sudo systemctl start ssh');
  return { pc, srv };
}

describe('SSH coherence across ssh / journalctl / tcpdump', () => {
  it('WITNESS: a successful exec is visible in all three views', async () => {
    const { pc, srv } = await directLab();
    await pc.executeCommand('tcpdump -i eth0 -w /tmp/s.pcap &');

    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.0.10', port: 22, user: 'alice', password: 'secret123',
      command: 'whoami',
    });
    expect(r.stdout.trim()).toBe('alice');

    const journal = await srv.executeCommand('journalctl -u ssh --no-pager');
    expect(journal).toMatch(/Accepted password for alice from 10\.0\.0\.1/);
    expect(journal).toMatch(/session opened for user alice/);

    const dump = await pc.executeCommand('tcpdump -r /tmp/s.pcap');
    expect(dump).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.10\.22: Flags \[S\]/);
    expect(dump).toMatch(/10\.0\.0\.10\.22 > 10\.0\.0\.1\.\d+: Flags \[S\.\]/);
  });

  it('DISCRIMINATION: a wrong password still crossed the wire', async () => {
    const { pc, srv } = await directLab();
    await pc.executeCommand('tcpdump -i eth0 -w /tmp/s.pcap &');

    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.0.10', port: 22, user: 'alice', password: 'wrong',
      command: 'whoami',
    });
    expect(r.authenticated).toBe(false);

    expect(await srv.executeCommand('journalctl -u ssh --no-pager')).toMatch(/Failed password for alice/);
    expect(await pc.executeCommand('tcpdump -r /tmp/s.pcap')).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.10\.22: Flags \[S\]/);
  });

  it('DISCRIMINATION: a deny-ACL session is absent from journal and never establishes', async () => {
    const { pc, srv } = await routedDenyLab();
    await pc.executeCommand('tcpdump -i eth0 -w /tmp/s.pcap &');

    const r = await sshWireExec({
      stack: stackOf(pc), host: '10.0.2.10', port: 22, user: 'alice', password: 'secret123',
      command: 'whoami',
    });
    expect(r.authenticated).toBe(false);

    expect(await srv.executeCommand('journalctl -u ssh --no-pager')).not.toMatch(/Accepted password for alice/);
    expect(await pc.executeCommand('tcpdump -r /tmp/s.pcap')).not.toMatch(/Flags \[S\.\]/);
  });
});
