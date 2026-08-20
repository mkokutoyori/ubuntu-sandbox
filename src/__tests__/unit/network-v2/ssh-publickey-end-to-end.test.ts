/**
 * Scénario 1 — Authentification par clé publique de bout en bout.
 *
 * Objectif : valider qu'un utilisateur peut se connecter sans mot de
 * passe une fois sa clé déployée, et que le serveur applique
 * correctement les permissions.
 *
 * Déroulé : un poste Linux (client) génère une paire de clés, la clé
 * publique est déployée sur un serveur Linux cible via ssh-copy-id.
 * On vérifie ensuite la connexion ssh puis sftp.
 *
 * Points de contrôle :
 *   - permissions du dossier ~/.ssh (700) et du fichier
 *     authorized_keys (600) sur le serveur ;
 *   - contenu du fichier authorized_keys ;
 *   - log d'authentification serveur (/var/log/auth.log) montrant
 *     `Accepted publickey` ;
 *   - échec de connexion si on remet les permissions à 644.
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

async function buildLan() {
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

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: {
    readFile(p: string): string | null;
    writeFile(p: string, c: string, u: number, g: number, m: number): void;
    resolveInode(p: string, b?: boolean): { permissions: number; uid: number; gid: number } | null;
  } } }).executor.vfs;
}

describe('Scénario 1 — authentification par clé publique de bout en bout', () => {
  it('ssh-copy-id déploie la clé avec ~/.ssh 0700 et authorized_keys 0600', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    const copyOut = await pc.executeCommand('ssh-copy-id alice@10.0.0.2');
    expect(copyOut).toMatch(/Number of key\(s\) added: 1/);

    const sshDir = srvVfs(srv).resolveInode('/home/alice/.ssh', true);
    expect(sshDir).not.toBeNull();
    expect(sshDir!.permissions & 0o777).toBe(0o700);
    expect(sshDir!.uid).toBe(1000);

    const ak = srvVfs(srv).resolveInode('/home/alice/.ssh/authorized_keys', true);
    expect(ak).not.toBeNull();
    expect(ak!.permissions & 0o777).toBe(0o600);
    expect(ak!.uid).toBe(1000);
  });

  it('le contenu d\'authorized_keys est exactement la clé publique du client', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    await pc.executeCommand('ssh-copy-id alice@10.0.0.2');

    const pub = (await pc.executeCommand('cat /root/.ssh/id_rsa.pub')).trim();
    const stored = srvVfs(srv).readFile('/home/alice/.ssh/authorized_keys') ?? '';
    expect(stored.split('\n').map(l => l.trim()).filter(Boolean)).toContain(pub);
  });

  it('ssh whoami réussit sans interaction mot de passe', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    await pc.executeCommand('ssh-copy-id alice@10.0.0.2');

    const out = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Permission denied/i);
    expect(out).not.toMatch(/password/i);
    expect(srv).toBeDefined();
  });

  it('sftp se connecte avec la même clé, sans mot de passe', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    await pc.executeCommand('ssh-copy-id alice@10.0.0.2');

    const pcVfs = (pc as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number): void } } }).executor.vfs;
    pcVfs.writeFile('/root/sftp.cmds', 'ls /home/alice\nexit\n', 0, 0, 0o022);
    const out = await pc.executeCommand(
      'sftp -o PreferredAuthentications=publickey -o PasswordAuthentication=no -b /root/sftp.cmds alice@10.0.0.2',
    );
    expect(out).toMatch(/Connected to 10\.0\.0\.2/);
    expect(out).not.toMatch(/Permission denied/i);
    expect(out).not.toMatch(/password/i);
    expect(srv).toBeDefined();
  });

  it('/var/log/auth.log du serveur trace `Accepted publickey for alice`', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    await pc.executeCommand('ssh-copy-id alice@10.0.0.2');
    await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted publickey for alice from 10\.0\.0\.1/);
  });

  it('repasser authorized_keys à 0644 fait échouer la connexion', async () => {
    const { pc, srv } = await buildLan();
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    await pc.executeCommand('ssh-copy-id alice@10.0.0.2');

    // Sanity : la connexion marche d'abord avec les permissions strictes.
    const ok = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(ok).toMatch(/^alice\s*$/m);

    // On relâche à 0644 — bit de lecture pour group/other, ce que tous
    // les guides SSH désignent comme insecure : la connexion suivante
    // doit être refusée.
    await srv.executeCommand('chmod 0644 /home/alice/.ssh/authorized_keys');
    const ak = srvVfs(srv).resolveInode('/home/alice/.ssh/authorized_keys', true);
    expect(ak!.permissions & 0o777).toBe(0o644);

    const ko = await pc.executeCommand(
      'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
    );
    expect(ko).toMatch(/Permission denied/i);
    expect(ko).not.toMatch(/^alice\s*$/m);
  });
});
