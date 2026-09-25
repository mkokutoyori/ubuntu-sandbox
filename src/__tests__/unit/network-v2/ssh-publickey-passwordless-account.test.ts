/*
 * Probe — an account without a password ("!" in /etc/shadow, what
 * `useradd` leaves) still logs in with a public key while sshd runs with
 * UsePAM yes, and is refused once UsePAM is no.
 *
 * Authority: OpenSSH 9.6p1, auth.c allowed_user():
 *   if (!options.use_pam && platform_locked_account(pw)) { ... return 0; }
 * and platform.c, where a password starting with "!" (LOCKED_PASSWD_PREFIX
 * on Linux) makes the account locked. The lock gate therefore only exists
 * when PAM is off; Ubuntu ships UsePAM yes, which is why
 * `adduser --disabled-password` plus a key is the usual way to open a
 * key-only account.
 *
 * Measured before the fix (git stash of src/network): 1 of the 3 cases
 * fails — "UsePAM yes" was refused although the wire session had already
 * logged "Accepted publickey": the in-memory policy gate
 * (LinuxMachine.sshdAcceptsLogin) treated "!" as locked whatever UsePAM
 * said, and auth.log then showed a spurious "Failed password".
 * Passing either way:
 *   - "an account with a password" is the WITNESS: key, lab and sshd are
 *     sound.
 *   - "UsePAM no" is non-regression: the lock still refuses when PAM is off.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

async function buildLab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'sw', 8, 0, 0);
  [pc, srv, sw].forEach((d) => d.powerOn());
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']) await pc.executeCommand(line);
  for (const line of [
    'ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'systemctl start sshd',
    'useradd -m user', 'mkdir -p /home/user/.ssh',
  ]) await srv.executeCommand(line);
  await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  const publicKey = (await pc.executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
  for (const line of [
    `echo '${publicKey}' >> /home/user/.ssh/authorized_keys`,
    'chown -R user:user /home/user/.ssh',
    'chmod 700 /home/user/.ssh', 'chmod 600 /home/user/.ssh/authorized_keys',
  ]) await srv.executeCommand(line);
  return { pc, srv };
}

describe('public key login on an account without a password', () => {
  it('an account with a password logs in with its key', async () => {
    const { pc, srv } = await buildLab();
    await srv.executeCommand('echo user:Secret123 | chpasswd');
    expect(await pc.executeCommand('ssh -o StrictHostKeyChecking=no 10.0.0.2 whoami')).toMatch(/^user$/m);
  });

  it('with UsePAM yes, the passwordless account logs in with its key', async () => {
    const { pc, srv } = await buildLab();
    expect(await srv.executeCommand("grep '^user:' /etc/shadow")).toMatch(/^user:!:/m);
    expect(await pc.executeCommand('ssh -o StrictHostKeyChecking=no 10.0.0.2 whoami')).toMatch(/^user$/m);
    expect(await srv.executeCommand('grep -c "Failed password" /var/log/auth.log')).toMatch(/^0$/m);
  });

  it('with UsePAM no, the same account is refused as locked', async () => {
    const { pc, srv } = await buildLab();
    await srv.executeCommand("sed -i 's/^#\\?UsePAM.*/UsePAM no/' /etc/ssh/sshd_config");
    await srv.executeCommand('grep -q "^UsePAM no" /etc/ssh/sshd_config || echo "UsePAM no" >> /etc/ssh/sshd_config');
    await srv.executeCommand('systemctl reload ssh');
    const out = await pc.executeCommand('ssh -o StrictHostKeyChecking=no 10.0.0.2 whoami');
    expect(out).toContain('Permission denied');
    expect(out).not.toMatch(/^user$/m);
  });
});
