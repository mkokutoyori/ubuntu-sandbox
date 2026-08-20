import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshdServerConfig } from '@/network/protocols/ssh/server/SshdServerConfig';

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

async function reload(srv: LinuxServer, body: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', body, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('SshdServerConfig — PermitOpen parser', () => {
  it('defaults to "any" when the directive is absent', () => {
    expect(SshdServerConfig.defaults().permitOpen).toEqual(['any']);
  });
  it('captures every whitespace-separated host:port token', () => {
    const cfg = SshdServerConfig.parse('PermitOpen 10.0.0.3:80 internal:5432\n');
    expect(cfg.permitOpen).toEqual(['10.0.0.3:80', 'internal:5432']);
  });
  it('keeps "none" as a literal entry (no forwards allowed)', () => {
    const cfg = SshdServerConfig.parse('PermitOpen none\n');
    expect(cfg.permitOpen).toEqual(['none']);
  });
});

describe('SSH server — PermitOpen gates -L destinations', () => {
  it('rejects a -L target that is not in the PermitOpen list', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPermitOpen 10.0.0.99:22\n');
    const out = await pc.executeCommand(
      'ssh -L 9001:10.0.0.3:80 -N alice@10.0.0.2',
    );
    expect(out).toMatch(/administratively prohibited/i);
  });

  it('allows a -L target that matches the PermitOpen list exactly', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPermitOpen 10.0.0.3:80\n');
    const out = await pc.executeCommand(
      'ssh -L 9002:10.0.0.3:80 -N alice@10.0.0.2',
    );
    expect(out).not.toMatch(/administratively prohibited/i);
  });

  it('allows any -L target when PermitOpen is "any"', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPermitOpen any\n');
    const out = await pc.executeCommand(
      'ssh -L 9003:10.0.0.5:443 -N alice@10.0.0.2',
    );
    expect(out).not.toMatch(/administratively prohibited/i);
  });

  it('refuses every -L target when PermitOpen is "none"', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPermitOpen none\n');
    const out = await pc.executeCommand(
      'ssh -L 9004:10.0.0.3:80 -N alice@10.0.0.2',
    );
    expect(out).toMatch(/administratively prohibited/i);
  });

  it('wildcard port "host:*" matches any port on that host', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPermitOpen 10.0.0.3:*\n');
    const out = await pc.executeCommand(
      'ssh -L 9005:10.0.0.3:8443 -N alice@10.0.0.2',
    );
    expect(out).not.toMatch(/administratively prohibited/i);
  });

  it('-R is not gated by PermitOpen (mirrors OpenSSH; that is PermitListen)', async () => {
    const { pc, srv } = await buildPair();
    await reload(srv, 'PasswordAuthentication yes\nPermitOpen 10.0.0.99:22\n');
    const out = await pc.executeCommand(
      'ssh -R 9006:10.0.0.3:80 -N alice@10.0.0.2',
    );
    expect(out).not.toMatch(/administratively prohibited/i);
  });
});
