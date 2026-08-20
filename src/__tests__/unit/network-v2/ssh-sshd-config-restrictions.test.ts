/**
 * Scénario 5 — Restriction d'accès via sshd_config.
 *
 * Objectif : valider que PermitRootLogin, AllowUsers et DenyUsers sont
 * respectés indépendamment du réseau, et que la modification du fichier
 * /etc/ssh/sshd_config n'est honorée qu'après `systemctl reload ssh`
 * (le simulateur cache la config en mémoire entre deux reloads, comme
 * le vrai sshd).
 *
 * Critère de réussite : seuls les comptes autorisés peuvent se
 * connecter, root est systématiquement refusé même avec le bon
 * mot de passe.
 */

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
  const pc  = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('admin1', { m: true, s: '/bin/bash' });
  um.useradd('admin2', { m: true, s: '/bin/bash' });
  um.useradd('bob',    { m: true, s: '/bin/bash' });
  um.setPassword('admin1', 'admin');
  um.setPassword('admin2', 'admin');
  um.setPassword('bob',    'admin');
  um.setPassword('root',   'admin');
  return { pc, srv };
}

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: {
    writeFile(p: string, c: string, u: number, g: number, m: number): void;
    readFile(p: string): string | null;
  } } }).executor.vfs;
}

async function writeConfig(srv: LinuxServer, body: string, opts: { reload: boolean } = { reload: true }) {
  srvVfs(srv).writeFile('/etc/ssh/sshd_config', body, 0, 0, 0o022);
  if (opts.reload) await srv.executeCommand('systemctl reload ssh');
}

describe('Scénario 5 — restriction d\'accès via sshd_config', () => {
  it('le fichier /etc/ssh/sshd_config contient bien les directives écrites', async () => {
    const { srv } = await buildPair();
    await writeConfig(srv,
      'PermitRootLogin no\nAllowUsers admin1 admin2\nPasswordAuthentication yes\n');
    const onDisk = srvVfs(srv).readFile('/etc/ssh/sshd_config') ?? '';
    expect(onDisk).toMatch(/^PermitRootLogin no$/m);
    expect(onDisk).toMatch(/^AllowUsers admin1 admin2$/m);
  });

  it('PermitRootLogin no : root est refusé même avec le bon mot de passe', async () => {
    const { pc, srv } = await buildPair();
    await writeConfig(srv,
      'PermitRootLogin no\nAllowUsers admin1 admin2 root\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh root@10.0.0.2 whoami');
    expect(out).toMatch(/Permission denied/i);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/ROOT LOGIN REFUSED FROM 10\.0\.0\.1/);
  });

  it('AllowUsers admin1 admin2 : un compte non listé (bob) est refusé', async () => {
    const { pc, srv } = await buildPair();
    await writeConfig(srv,
      'AllowUsers admin1 admin2\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh bob@10.0.0.2 whoami');
    expect(out).toMatch(/Permission denied/i);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/User bob from 10\.0\.0\.1 not allowed because not listed in AllowUsers/);
  });

  it('AllowUsers admin1 admin2 : admin1 est accepté', async () => {
    const { pc, srv } = await buildPair();
    await writeConfig(srv,
      'AllowUsers admin1 admin2\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh admin1@10.0.0.2 whoami');
    expect(out).toMatch(/^admin1\s*$/m);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for admin1 from 10\.0\.0\.1/);
  });

  it('DenyUsers : un user explicitement nié est refusé avec le bon message log', async () => {
    const { pc, srv } = await buildPair();
    await writeConfig(srv,
      'DenyUsers bob\nPasswordAuthentication yes\n');
    const out = await pc.executeCommand('ssh bob@10.0.0.2 whoami');
    expect(out).toMatch(/Permission denied/i);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/User bob from 10\.0\.0\.1 not allowed because listed in DenyUsers/);
  });

  it('comportement transitoire : modifier sshd_config SANS reload garde l\'ancienne policy', async () => {
    const { pc, srv } = await buildPair();
    // Policy permissive d'abord, REQUIRES reload pour être en vigueur.
    await writeConfig(srv, 'PermitRootLogin yes\nPasswordAuthentication yes\n');
    // Sanity : bob peut se connecter, on n'a pas d'AllowUsers.
    const ok = await pc.executeCommand('ssh bob@10.0.0.2 whoami');
    expect(ok).toMatch(/^bob\s*$/m);

    // On écrit la policy stricte mais on NE recharge PAS.
    await writeConfig(srv,
      'AllowUsers admin1 admin2\nPasswordAuthentication yes\n',
      { reload: false });
    // Comportement réel sshd : tant que SIGHUP n'est pas envoyé, la
    // config en mémoire reste l'ancienne — bob passe encore.
    const stillOk = await pc.executeCommand('ssh bob@10.0.0.2 whoami');
    expect(stillOk).toMatch(/^bob\s*$/m);

    // Reload → la nouvelle policy entre en vigueur.
    await srv.executeCommand('systemctl reload ssh');
    const ko = await pc.executeCommand('ssh bob@10.0.0.2 whoami');
    expect(ko).toMatch(/Permission denied/i);
  });
});
