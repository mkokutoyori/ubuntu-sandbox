/*
 * Probe — `ssh -J bastion target cmd` reaches the target THROUGH the
 * bastion: a direct-tcpip channel on the bastion's SSH session, the bastion
 * dialling the target, the inner SSH session carried inside that channel.
 *
 * Before: the executeCommand path refused -J on the wire and fell back to
 * the in-memory client, which ignored it and tried the target directly —
 * through a firewall that forbids exactly that. The SSH server had no
 * direct-tcpip channel at all.
 *
 * Authorities: OpenSSH 9.6p1 sources, read from openssh/openssh-portable:
 * channels.c ("channel %d: open failed: %s%s%s", reason2txt:
 * "administratively prohibited" / "connect failed"), ssh.c ("stdio
 * forwarding failed"), packet.c ("Connection closed by %s" with UNKNOWN
 * port 65535 for a proxied connection), sshconnect.c ("ssh: connect to host
 * %s port %s: %s"). AllowTcpForwarding / PermitOpen / PermitRootLogin are
 * read from sshd_config through SshdServerConfig.
 *
 * Measured before the change (git stash of src/network and src/terminal):
 * 7 of the 9 cases fail.
 * Passing either way:
 *   - "the bastion itself is reachable with the key" is the WITNESS: keys,
 *     routing and the firewall policy are sound.
 *   - "the firewall forbids the target directly" is non-regression: the
 *     only way to the target is the bastion.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper, grantKeyAccess } from '../new_firewall/fortigateBatteryHarness';

interface Lab { pc: LinuxPC; bastion: LinuxServer; target: LinuxServer }

async function buildLab(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const bastion = new LinuxServer('linux-server', 'bastion', 0, 0);
  const target = new LinuxServer('linux-server', 'target', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  for (const host of [pc, bastion, target]) host.powerOn();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('dmz').connect(fw.getPort('dmz') as never, bastion.getPort('eth0') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, target.getPort('eth0') as never);
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit dmz', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "dmz"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "SSH"', 'next',
    'edit 2', 'set srcintf "dmz"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "SSH"', 'next',
    'end',
  ]);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']);
  await taper(bastion as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.5/24 dev eth0', 'ip route add default via 10.0.0.1', 'systemctl start ssh']);
  await taper(target as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
    'systemctl start ssh', 'hostnamectl set-hostname TARGET-01',
  ]);
  await grantKeyAccess(pc as unknown as Cli, bastion as unknown as Cli);
  await grantKeyAccess(pc as unknown as Cli, target as unknown as Cli);
  return { pc, bastion, target };
}

describe('ssh -J over the wire', () => {
  it('the bastion itself is reachable with the key', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('ssh user@10.0.0.5 whoami')).toMatch(/^user$/m);
  });

  it('the firewall forbids the target directly', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('ssh user@203.0.113.9 hostname')).not.toMatch(/TARGET-01/);
  });

  it('-J runs the command on the target through the bastion', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('ssh -J user@10.0.0.5 user@203.0.113.9 hostname; echo EC=$?');
    expect(out).toMatch(/^TARGET-01$/m);
    expect(out).toContain('EC=0');
  });

  it('-o ProxyJump= is the same request', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('ssh -o ProxyJump=user@10.0.0.5 user@203.0.113.9 hostname')).toMatch(/^TARGET-01$/m);
  });

  it('the target sees the bastion as the client, not the workstation', async () => {
    const { pc, target } = await buildLab();
    await pc.executeCommand('ssh -J user@10.0.0.5 user@203.0.113.9 true');
    const log = await target.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted publickey for user from 10\.0\.0\.5/);
    expect(log).not.toMatch(/from 192\.168\.1\.10/);
  });

  it('AllowTcpForwarding no on the bastion refuses the channel in OpenSSH words', async () => {
    const { pc, bastion } = await buildLab();
    await taper(bastion as unknown as Cli, [
      "sed -i 's/^#\\?AllowTcpForwarding.*/AllowTcpForwarding no/' /etc/ssh/sshd_config",
      'grep -q "^AllowTcpForwarding no" /etc/ssh/sshd_config || echo "AllowTcpForwarding no" >> /etc/ssh/sshd_config',
      'systemctl restart ssh',
    ]);
    const out = await pc.executeCommand('ssh -J user@10.0.0.5 user@203.0.113.9 hostname; echo EC=$?');
    expect(out).toContain([
      'channel 0: open failed: administratively prohibited: open failed',
      'stdio forwarding failed',
      'Connection closed by UNKNOWN port 65535',
    ].join('\n'));
    expect(out).toContain('EC=255');
    expect(out).not.toMatch(/TARGET-01/);
  });

  it('a target that refuses the connection is reported by the bastion', async () => {
    const { pc, target } = await buildLab();
    await taper(target as unknown as Cli, ['systemctl stop ssh']);
    const out = await pc.executeCommand('ssh -J user@10.0.0.5 user@203.0.113.9 hostname; echo EC=$?');
    expect(out).toContain('channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed');
    expect(out).toContain('EC=255');
  });

  it('an unreachable bastion is reported as a connect error', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand('ssh -J user@10.0.0.77 user@203.0.113.9 hostname; echo EC=$?');
    expect(out).toMatch(/ssh: connect to host 10\.0\.0\.77 port 22: /);
    expect(out).toContain('EC=255');
  });

  it('PermitRootLogin prohibit-password lets root in with a key', async () => {
    const { pc, bastion } = await buildLab();
    await grantKeyAccess(pc as unknown as Cli, bastion as unknown as Cli, 'root');
    await taper(bastion as unknown as Cli, [
      "sed -i 's/^PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config",
      'systemctl restart ssh',
    ]);
    expect(await pc.executeCommand('ssh -J root@10.0.0.5 user@203.0.113.9 hostname')).toMatch(/^TARGET-01$/m);
  });
});
