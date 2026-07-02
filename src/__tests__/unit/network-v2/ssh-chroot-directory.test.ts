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

async function reload(srv: LinuxServer, sshdBody: string) {
  const vfs = (srv as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
  vfs.writeFile('/etc/ssh/sshd_config', sshdBody, 0, 0, 0o022);
  await srv.executeCommand('systemctl reload ssh');
}

describe('sshd_config — top-level ChrootDirectory + ForceCommand parsing', () => {
  it('ChrootDirectory at global scope is stored on the instance', () => {
    const cfg = SshdServerConfig.parse('ChrootDirectory /srv/jail\n');
    expect(cfg.chrootDirectory).toBe('/srv/jail');
  });

  it('ForceCommand at global scope is stored on the instance', () => {
    const cfg = SshdServerConfig.parse('ForceCommand whoami\n');
    expect(cfg.forceCommand).toBe('whoami');
  });

  it('"ChrootDirectory none" parses as null', () => {
    const cfg = SshdServerConfig.parse('ChrootDirectory /srv\nChrootDirectory none\n');
    expect(cfg.chrootDirectory).toBeNull();
  });

  it('sftp chroots into the configured global ChrootDirectory', async () => {
    const { pc, srv } = await buildPair();
    const vfs = (srv as unknown as { executor: { vfs: {
      writeFile(p: string, c: string, u: number, g: number, m: number): void;
      mkdirp(p: string, m: number, u: number, g: number): boolean;
    } } }).executor.vfs;
    vfs.mkdirp('/srv/jail', 0o755, 0, 0);
    vfs.writeFile('/srv/jail/inside.txt', 'jailed', 0, 0, 0o022);
    vfs.writeFile('/etc/secret.txt', 'leaked', 0, 0, 0o022);
    await reload(srv, 'ChrootDirectory /srv/jail\nPasswordAuthentication yes\n');

    const out = await pc.executeCommand("sftp alice@10.0.0.2 <<'EOF'\nls /\nbye\nEOF");
    expect(out).toMatch(/inside\.txt/);
    expect(out).not.toMatch(/secret\.txt/);
  });
});
