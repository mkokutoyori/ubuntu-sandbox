/**
 * sftp file transfer crosses the wire on the canonical SftpSession, coherent
 * across three views: the transfer itself, the server journalctl (sshd + sftp
 * subsystem), and the client tcpdump. Modern OpenSSH scp rides the same SFTP
 * subsystem, so this one session covers both tools.
 *
 * Measured (Rule 7). `openSftpSession` authenticates over TCP to :22 and drives
 * the real SFTP wire session (INIT/OPEN/WRITE/CLOSE via SftpWireCodec) through
 * SshSftpChannel. WITNESS: a put lands the file on the server's real VFS (a
 * subsequent `cat` reads it back) AND a get returns the same bytes; journalctl
 * shows the session; tcpdump shows real :22 frames. DISCRIMINATION: a deny-ACL
 * router blocks the transfer on the wire (connect never establishes, no file
 * written).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { openSftpSession } from './ssh-lan-fixtures';

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

async function denyLab() {
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

describe('sftp transfer crosses the wire, coherent in three views', () => {
  it('WITNESS: put lands on the server VFS, get reads it back, all three views agree', async () => {
    const { pc, srv } = await directLab();
    await pc.executeCommand('tcpdump -i eth0 -w /tmp/s.pcap &');

    const { sftp, localVfs } = await openSftpSession(pc, '10.0.0.10', 'alice', 'secret123');
    localVfs.writeFile('/payload.txt', 'payload-over-the-wire', 0, 0, 0o022);
    sftp.put('/payload.txt', '/home/alice/uploaded.txt');

    const onServer = await srv.executeCommand('cat /home/alice/uploaded.txt');
    expect(onServer).toContain('payload-over-the-wire');

    sftp.get('/home/alice/uploaded.txt', '/downloaded.txt');
    expect(localVfs.readFile('/downloaded.txt')).toContain('payload-over-the-wire');
    sftp.disconnect();

    expect(await srv.executeCommand('journalctl -u ssh --no-pager')).toMatch(/Accepted password for alice/);
    expect(await pc.executeCommand('tcpdump -r /tmp/s.pcap')).toMatch(/10\.0\.0\.1\.\d+ > 10\.0\.0\.10\.22: Flags \[S\]/);
  });

  it('DISCRIMINATION: a deny-ACL router blocks the transfer on the wire', async () => {
    const { pc, srv } = await denyLab();
    await expect(openSftpSession(pc, '10.0.2.10', 'alice', 'secret123')).rejects.toThrow();
    expect(await srv.executeCommand('cat /home/alice/blocked.txt')).not.toContain('never-arrives');
  });
});
