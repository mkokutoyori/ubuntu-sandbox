/*
 * Probe — the image's sshd_config says what OpenSSH compiles in:
 * PermitRootLogin prohibit-password, i.e. root in with a key, never with a
 * password — on the in-memory path and on the wire alike.
 *
 * Before: the boolean model (SshSshdConfig) serialised the image with
 * `PermitRootLogin no` and read `prohibit-password` as `no`; the
 * in-memory gate (LinuxMachine.sshdAcceptsLogin) refused root for any
 * value but `yes`, key or not.
 *
 * Authority: OpenSSH 9.6p1 sshd_config (openssh/openssh-portable,
 * "#PermitRootLogin prohibit-password", the compiled default) and
 * sshd_config(5): prohibit-password disables password and
 * keyboard-interactive authentication for root.
 *
 * Measured before the change (git stash of src/network): 5 of the 7 cases
 * fail.
 * Passing either way:
 *   - "a password never lets root in" is non-regression: fail-closed.
 *   - "PermitRootLogin no refuses root even with a key" is non-regression.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper, grantKeyAccess } from '../new_firewall/fortigateBatteryHarness';

async function buildLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  srv.powerOn();
  pc.powerOn();
  new Cable('c').connect(srv.getPort('eth0') as never, pc.getPort('eth0') as never);
  await taper(srv as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.5/24 dev eth0', 'echo "root:Root123!" | chpasswd']);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']);
  await grantKeyAccess(pc as unknown as Cli, srv as unknown as Cli, 'root');
  return { pc, srv };
}

describe('PermitRootLogin prohibit-password by default', () => {
  it('the image writes the OpenSSH default', async () => {
    const { srv } = await buildLab();
    expect(await srv.executeCommand('grep -i "^PermitRootLogin" /etc/ssh/sshd_config')).toMatch(/^PermitRootLogin prohibit-password$/m);
  });

  it('root logs in with a key on the direct path', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('ssh -o PasswordAuthentication=no root@10.0.0.5 whoami')).toMatch(/^root$/m);
  });

  it('root logs in with a key on the wire', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('ssh -o PasswordAuthentication=no -J root@10.0.0.5 root@10.0.0.5 whoami')).toMatch(/^root$/m);
  });

  it('a password never lets root in', async () => {
    const { pc } = await buildLab();
    const out = await pc.executeCommand("sshpass -p 'Root123!' ssh -o PubkeyAuthentication=no root@10.0.0.5 whoami");
    expect(out).not.toMatch(/^root$/m);
  });

  it('PermitRootLogin no refuses root even with a key', async () => {
    const { pc, srv } = await buildLab();
    await taper(srv as unknown as Cli, ["sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config", 'grep -q "^PermitRootLogin no" /etc/ssh/sshd_config || echo "PermitRootLogin no" >> /etc/ssh/sshd_config', 'systemctl restart ssh']);
    expect(await pc.executeCommand('ssh -o PasswordAuthentication=no root@10.0.0.5 whoami')).not.toMatch(/^root$/m);
  });

  it('forced-commands-only admits root only with a command= key, on both paths', async () => {
    const { pc, srv } = await buildLab();
    await taper(srv as unknown as Cli, [
      "sed -i 's/^PermitRootLogin.*/PermitRootLogin forced-commands-only/' /etc/ssh/sshd_config", 'systemctl restart ssh',
    ]);
    const plain = 'ssh -o PasswordAuthentication=no root@10.0.0.5 whoami';
    const wire = 'ssh -o PasswordAuthentication=no -J root@10.0.0.5 root@10.0.0.5 whoami';
    expect(await pc.executeCommand(plain)).not.toMatch(/^root$/m);
    expect(await pc.executeCommand(wire)).not.toMatch(/^root$/m);
    await taper(srv as unknown as Cli, ["sed -i 's/^ssh-/command=\"echo FORCED-ROOT\" ssh-/' /root/.ssh/authorized_keys"]);
    expect(await pc.executeCommand(plain)).toMatch(/^FORCED-ROOT$/m);
  });

  it('sshd -T reports the effective value', async () => {
    const { srv } = await buildLab();
    expect(await srv.executeCommand('sshd -T')).toMatch(/^permitrootlogin prohibit-password$/m);
  });
});
