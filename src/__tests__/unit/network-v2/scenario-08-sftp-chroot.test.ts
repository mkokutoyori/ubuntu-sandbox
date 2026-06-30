import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab { client: LinuxPC; server: LinuxServer; sw: GenericSwitch; }

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SERVER', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);

  const um = (server as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    setPassword: (u: string, p: string) => void;
    usermod: (u: string, o: object) => void;
    getUser: (u: string) => unknown;
  } } }).executor.userMgr;
  if (!um.getUser('sftponly')) {
    um.useradd('sftponly', { m: true, s: '/sbin/nologin' });
    um.setPassword('sftponly', 'secret');
  }
  return { client, server, sw };
}

async function provisionChroot(server: LinuxServer): Promise<void> {
  await server.executeCommand('mkdir -p /srv/sftp/sftponly/upload');
  await server.executeCommand('chown root:root /srv/sftp');
  await server.executeCommand('chown root:root /srv/sftp/sftponly');
  await server.executeCommand('chmod 755 /srv/sftp');
  await server.executeCommand('chmod 755 /srv/sftp/sftponly');
  await server.executeCommand('chown sftponly:sftponly /srv/sftp/sftponly/upload');
  await server.executeCommand('chmod 755 /srv/sftp/sftponly/upload');
  await server.executeCommand(
    `sh -c 'printf "Match User sftponly\\n  ChrootDirectory /srv/sftp/sftponly\\n  ForceCommand internal-sftp\\n  PasswordAuthentication yes\\n  AllowTcpForwarding no\\n  X11Forwarding no\\n" >> /etc/ssh/sshd_config'`,
  );
  await server.executeCommand('systemctl reload ssh');
}

function sftpHere(dest: string, verbs: string[]): string {
  return `sftp ${dest} <<'EOF'\n${verbs.join('\n')}\nbye\nEOF`;
}

describe('Scenario 8 — SFTP/SCP avec ChrootDirectory + ForceCommand internal-sftp', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('sshd_config retient bien Match User + ChrootDirectory + ForceCommand internal-sftp', async () => {
    const { server } = await buildLab();
    await provisionChroot(server);
    const cfg = await server.executeCommand('cat /etc/ssh/sshd_config');
    expect(cfg).toMatch(/Match User sftponly/);
    expect(cfg).toMatch(/ChrootDirectory\s+\/srv\/sftp\/sftponly/);
    expect(cfg).toMatch(/ForceCommand\s+internal-sftp/);
  });

  it('le répertoire chrooté appartient à root et n\'est pas writable pour le groupe / others', async () => {
    const { server } = await buildLab();
    await provisionChroot(server);
    const ls = await server.executeCommand('ls -ld /srv/sftp/sftponly');
    expect(ls).toMatch(/^drwxr-xr-x/);
    expect(ls).toContain('root');
    expect(ls).not.toMatch(/drwxrwx/);
  });

  it('SFTP avec credentials du compte chrooté établit la session', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    const out = await client.executeCommand(
      sftpHere('sftponly@10.0.0.2', ['pwd', 'ls']),
      'secret\n',
    );
    expect(out).toMatch(/Connected to 10\.0\.0\.2|sftp>/);
    expect(out).not.toMatch(/Permission denied/i);
  });

  it('le SFTP voit la racine du chroot comme "/" et n\'expose pas /srv/sftp/sftponly', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    const out = await client.executeCommand(
      sftpHere('sftponly@10.0.0.2', ['pwd']),
      'secret\n',
    );
    expect(out).toMatch(/Remote working directory:\s+\/(?!srv\/sftp)/);
    expect(out).not.toContain('/srv/sftp/sftponly');
  });

  it('cd /etc / cd ../../.. depuis la racine chrootée ne sort pas du chroot', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    const out = await client.executeCommand(
      sftpHere('sftponly@10.0.0.2', ['cd /etc', 'pwd', 'cd ../../..', 'pwd', 'ls']),
      'secret\n',
    );
    expect(out).toMatch(/Couldn't (canonicali[sz]e|stat)|No such file|Not a directory|Permission denied/i);
    expect(out).not.toContain('/etc/passwd');
    expect(out).not.toContain('/srv/sftp/sftponly');
  });

  it('upload sftp dans /upload réussit, écriture à la racine refusée', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    await client.executeCommand('echo "doc-content" > /tmp/doc.txt');
    const ok = await client.executeCommand(
      sftpHere('sftponly@10.0.0.2', ['cd /upload', 'put /tmp/doc.txt doc.txt', 'ls']),
      'secret\n',
    );
    expect(ok).toMatch(/Uploading|doc\.txt/);
    const denied = await client.executeCommand(
      sftpHere('sftponly@10.0.0.2', ['put /tmp/doc.txt /forbidden.txt']),
      'secret\n',
    );
    expect(denied).toMatch(/Permission denied|Couldn't (open|create)/i);
  });

  it('SSH interactif (sans ForceCommand override) est refusé : shell = /sbin/nologin ou ForceCommand bloque', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    const out = await client.executeCommand(
      'ssh -o StrictHostKeyChecking=no sftponly@10.0.0.2 "id; cat /etc/shadow"',
      'secret\n',
    );
    expect(out).toMatch(/This service allows sftp connections only|Permission denied|account is not available|nologin/i);
    expect(out).not.toContain('uid=');
    expect(out).not.toContain('root:');
  });

  it('SCP est refusé pour un compte sous ForceCommand internal-sftp (exec channel bloqué)', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    await client.executeCommand('echo "scp-payload" > /tmp/scp.txt');
    const blocked = await client.executeCommand(
      'scp /tmp/scp.txt sftponly@10.0.0.2:/upload/scp.txt',
      'secret\n',
    );
    expect(blocked).toMatch(/sftp connections only|Permission denied|denied|exec/i);
    const blocked2 = await client.executeCommand(
      'scp /tmp/scp.txt sftponly@10.0.0.2:/etc/passwd',
      'secret\n',
    );
    expect(blocked2).toMatch(/sftp connections only|Permission denied|denied|exec/i);
  });
});
