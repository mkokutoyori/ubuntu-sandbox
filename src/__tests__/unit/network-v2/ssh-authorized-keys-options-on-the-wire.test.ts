/*
 * Probe — the wire SSH server honours the options of the authorized_keys
 * line that authenticated the client, and refuses a line whose options it
 * cannot evaluate.
 *
 * Before: checkPublicKey compared the SECOND field of each line with the
 * offered key, so a line with options ("no-pty ssh-ed25519 ...") never
 * authenticated — closed by accident, with from=, command= and
 * no-port-forwarding never read; sshd_config ForceCommand was not applied
 * to a wire exec either. The in-memory client evaluated from= and command=
 * on its own copy and accepted options it did not know.
 *
 * Authority: sshd(8) AUTHORIZED_KEYS FILE FORMAT — command, from,
 * no-agent-forwarding, no-port-forwarding, no-pty, no-user-rc,
 * no-X11-forwarding, permitopen, restrict and its re-enabling pty /
 * port-forwarding / agent-forwarding / X11-forwarding, SSH_ORIGINAL_COMMAND;
 * auth-options.c rejects a line carrying an option it does not know. The
 * simulator refuses the options it does not evaluate (expiry-time,
 * principals, cert-authority, tunnel, permitlisten, ...), fail-closed.
 * Every command runs through a bastion (ssh -J) so the target sees a wire
 * session.
 *
 * Measured before the change (git stash of src/network): 9 of the 12 cases
 * fail.
 * Passing either way:
 *   - "a plain key line lets the command run on the target" is the WITNESS.
 *   - "from= refuses any other address" and "an option the simulator does
 *     not evaluate makes the line refuse, on the wire" passed before only
 *     because EVERY line with options was refused.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { createDevice } from '@/network/devices/DeviceFactory';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper } from '../new_firewall/fortigateBatteryHarness';

interface Lab { pc: LinuxPC; bastion: LinuxServer; target: LinuxServer }

async function buildLab(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const bastion = new LinuxServer('linux-server', 'bastion', 0, 0);
  const target = new LinuxServer('linux-server', 'target', 0, 0);
  const sw = createDevice('switch-generic', 0, 0) as unknown as Cli & { powerOn(): void };
  for (const host of [pc, bastion, target]) host.powerOn();
  sw.powerOn();
  const ports = sw.getPortNames();
  new Cable('a').connect(pc.getPort('eth0') as never, sw.getPort(ports[0]) as never);
  new Cable('b').connect(bastion.getPort('eth0') as never, sw.getPort(ports[1]) as never);
  new Cable('c').connect(target.getPort('eth0') as never, sw.getPort(ports[2]) as never);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0', 'ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519']);
  await taper(bastion as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.5/24 dev eth0']);
  await taper(target as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.9/24 dev eth0', 'hostnamectl set-hostname TARGET-01']);
  await authorize(pc, bastion, '');
  return { pc, bastion, target };
}

async function authorize(pc: LinuxPC, server: LinuxServer, options: string): Promise<void> {
  const key = (await pc.executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
  const line = options ? `${options} ${key}` : key;
  await taper(server as unknown as Cli, [
    'id user || useradd -m user',
    'mkdir -p /home/user/.ssh',
    `echo '${line}' > /home/user/.ssh/authorized_keys`,
    'chown -R user:user /home/user/.ssh', 'chmod 700 /home/user/.ssh', 'chmod 600 /home/user/.ssh/authorized_keys',
  ]);
}

const THROUGH_BASTION = 'ssh -o PasswordAuthentication=no -J user@10.0.0.5 user@10.0.0.9';

describe('authorized_keys options on the wire', () => {
  it('a plain key line lets the command run on the target', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, '');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toMatch(/^TARGET-01$/m);
  });

  it('a key line carrying options still authenticates', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'no-pty,no-agent-forwarding');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toMatch(/^TARGET-01$/m);
  });

  it('from= admits the address the connection really comes from', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'from="10.0.0.5"');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toMatch(/^TARGET-01$/m);
  });

  it('from= refuses any other address', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'from="10.0.0.1"');
    const out = await pc.executeCommand(`${THROUGH_BASTION} hostname; echo EC=$?`);
    expect(out).toContain('user@10.0.0.9: Permission denied');
    expect(out).toContain('EC=255');
  });

  it('command= replaces the command asked for', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'command="echo FORCED"');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toMatch(/^FORCED$/m);
  });

  it('command= sees the original command in SSH_ORIGINAL_COMMAND', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'command="echo ORIG=$SSH_ORIGINAL_COMMAND"');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toMatch(/^ORIG=hostname$/m);
  });

  it('command= replaces the interactive shell too', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'command="echo FORCED"');
    const out = await pc.executeCommand(`echo whoami | ${THROUGH_BASTION}`);
    expect(out).toMatch(/^FORCED$/m);
    expect(out).not.toMatch(/^user$/m);
  });

  it('ForceCommand in sshd_config wins over the command asked for', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, '');
    await taper(target as unknown as Cli, ['echo "ForceCommand echo SERVER-FORCED" >> /etc/ssh/sshd_config', 'systemctl restart ssh']);
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toMatch(/^SERVER-FORCED$/m);
  });

  it('no-port-forwarding on the bastion key refuses the jump channel', async () => {
    const { pc, bastion, target } = await buildLab();
    await authorize(pc, target, '');
    await authorize(pc, bastion, 'no-port-forwarding');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`))
      .toContain('channel 0: open failed: administratively prohibited: open failed');
  });

  it('permitopen= limits where the jump channel may go', async () => {
    const { pc, bastion, target } = await buildLab();
    await authorize(pc, target, '');
    await authorize(pc, bastion, 'permitopen="10.0.0.99:22"');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`))
      .toContain('channel 0: open failed: administratively prohibited: open failed');
  });

  it('an option the simulator does not evaluate makes the line refuse, on the wire', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'expiry-time="20990101"');
    expect(await pc.executeCommand(`${THROUGH_BASTION} hostname`)).toContain('user@10.0.0.9: Permission denied');
  });

  it('the same line is refused on the direct path too', async () => {
    const { pc, target } = await buildLab();
    await authorize(pc, target, 'expiry-time="20990101"');
    expect(await pc.executeCommand('ssh -o PasswordAuthentication=no user@10.0.0.9 hostname')).not.toMatch(/^TARGET-01$/m);
  });
});
