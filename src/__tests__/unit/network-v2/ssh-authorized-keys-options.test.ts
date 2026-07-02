import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildPair() {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');
  return { pc, srv };
}

async function installKeyAndAuthorize(
  pc: LinuxPC,
  srv: LinuxServer,
  optionsPrefix: string,
) {
  await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
  const pub = (await pc.executeCommand('cat /root/.ssh/id_rsa.pub')).trim();
  const vfs = (srv as unknown as { executor: { vfs: {
    mkdirp(p: string, m: number, u: number, g: number): void;
    writeFile(p: string, c: string, u: number, g: number, m: number): void;
  } } }).executor.vfs;
  vfs.mkdirp('/home/alice/.ssh', 0o700, 1000, 1000);
  const line = optionsPrefix ? `${optionsPrefix} ${pub}\n` : `${pub}\n`;
  vfs.writeFile('/home/alice/.ssh/authorized_keys', line, 1000, 1000, 0o066);
}

describe('SSH server — authorized_keys per-key options', () => {
  it('command="..." overrides the user-supplied remote command', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'command="whoami"');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 echo hello',
    );
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/hello/);
    expect(out).not.toMatch(/Permission denied/i);
  });

  it('command="..." exposes $SSH_ORIGINAL_COMMAND', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'command="echo got:$SSH_ORIGINAL_COMMAND"');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 ls /tmp',
    );
    expect(out).toMatch(/got:ls \/tmp/);
  });

  it('key without options behaves normally', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, '');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 echo hello',
    );
    expect(out).toMatch(/^hello/m);
    expect(out).not.toMatch(/Permission denied/i);
  });

  it('global ForceCommand wins over per-key command="..."', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config',
      'PasswordAuthentication no\nForceCommand id -un\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'command="hostname"');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 echo hi',
    );
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/linux-server/);
    expect(out).not.toMatch(/Permission denied/i);
  });

  it('from="..." pattern that does not match the source IP refuses the key', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'from="192.168.42.*"');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(out).toMatch(/Permission denied/i);
  });

  it('no-port-forwarding refuses -L despite global AllowTcpForwarding default', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'no-port-forwarding');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no -L 9000:127.0.0.1:80 -N alice@10.0.0.2',
    );
    expect(out).toMatch(/administratively prohibited/i);
  });

  it('environment="K=V" exposes K to the remote exec env', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'environment="GREET=salut"');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 printenv GREET',
    );
    expect(out).toMatch(/^salut\s*$/m);
  });

  it('restrict implies no-port-forwarding (and friends)', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'restrict');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no -L 9000:127.0.0.1:80 -N alice@10.0.0.2',
    );
    expect(out).toMatch(/administratively prohibited/i);
  });

  it('GatewayPorts=no silently rebinds a wildcard -R listener to loopback', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication yes\nGatewayPorts no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');

    await pc.executeCommand(
      'ssh -f -N -R 0.0.0.0:9555:10.0.0.1:80 alice@10.0.0.2',
    );
    const ss = await srv.executeCommand('ss -tln');
    expect(ss).toMatch(/127\.0\.0\.1:9555/);
    expect(ss).not.toMatch(/0\.0\.0\.0:9555/);
  });

  it('GatewayPorts=clientspecified honours the client-supplied bind address', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication yes\nGatewayPorts clientspecified\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');

    await pc.executeCommand(
      'ssh -f -N -R 0.0.0.0:9556:10.0.0.1:80 alice@10.0.0.2',
    );
    const ss = await srv.executeCommand('ss -tln');
    expect(ss).toMatch(/0\.0\.0\.0:9556/);
  });

  it('from="..." pattern that does match the source IP accepts the key', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    vfs.writeFile('/etc/ssh/sshd_config', 'PasswordAuthentication no\n', 0, 0, 0o022);
    await srv.executeCommand('systemctl reload ssh');
    await installKeyAndAuthorize(pc, srv, 'from="10.0.0.*"');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Permission denied/i);
  });
});
