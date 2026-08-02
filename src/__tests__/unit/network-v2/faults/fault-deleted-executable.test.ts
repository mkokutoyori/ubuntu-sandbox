/**
 * §F5.10 — supprimer l'exécutable d'un démon qui tourne.
 *
 * C'est la panne différée par excellence : rien ne casse au moment du `rm`,
 * le service continue de répondre, et la machine ne s'écroule qu'au
 * redémarrage suivant — souvent des jours plus tard, quand plus personne ne
 * fait le lien avec la suppression. C'est aussi ce qui la rend pédagogique :
 * `systemctl status` dit `active`, `ssh` marche, et pourtant le service est
 * déjà condamné.
 *
 * Deux fondations manquaient, et sans elles le scénario ne pouvait même pas
 * être mis en place :
 *
 *   - **Aucun binaire de démon n'existait sur le disque.** `/usr/sbin/sshd`
 *     n'était nulle part, donc `rm /usr/sbin/sshd` répondait « No such file
 *     or directory » : impossible de supprimer ce qui n'existe pas. Ils sont
 *     désormais posés au démarrage à partir des unités elles-mêmes, donc le
 *     fichier présent est exactement celui que l'unité tentera d'exécuter.
 *   - **`/proc/<pid>/exe` n'existait pas.** C'est pourtant le seul endroit
 *     où le noyau montre la panne pendant qu'elle est encore invisible : il
 *     ajoute ` (deleted)` à la cible du lien dès que le binaire est délié,
 *     et le processus, lui, continue.
 *
 * Et le refus au redémarrage est réel, pas décoratif : systemd échoue avec
 * 203/EXEC, le port 22 se ferme pour de bon, et un client sur le fil se
 * prend un `Connection refused`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { executablePathOf } from '@/network/devices/linux/LinuxServiceManager';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function box(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

/** Le pid du processus principal d'un service, lu dans `ps`. */
async function pidOf(pc: LinuxPC | LinuxServer, exe: string): Promise<string> {
  const ps = await pc.executeCommand('ps aux');
  const line = ps.split('\n').find((l) => l.includes(exe));
  expect(line, `aucun processus ${exe} dans ps`).toBeDefined();
  return line!.trim().split(/\s+/)[1];
}

interface Lab { cli: LinuxPC; srv: LinuxServer }

/** CLI —— SW —— SRV, avec un compte utilisable en ssh sur SRV. */
async function lab(): Promise<Lab> {
  const cli = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.configureInterface('eth0', new IPAddress('10.0.0.1'), MASK);
  srv.configureInterface('eth0', new IPAddress('10.0.0.2'), MASK);
  new Cable('c1').connect(cli.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  await srv.executeCommand('useradd -m alice');
  await srv.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');
  return { cli, srv };
}

const sshHostname = (cli: LinuxPC): Promise<string> =>
  cli.executeCommand('sshpass -p secret ssh -o StrictHostKeyChecking=no alice@10.0.0.2 hostname');

describe('le binaire d\'un démon est un vrai fichier du disque', () => {
  it('l\'exécutable nommé par `ExecStart=` existe au démarrage', async () => {
    const pc = box();

    // Sans ça, `rm /usr/sbin/sshd` répond « No such file or directory » et
    // la panne §F5.10 ne peut pas être provoquée du tout.
    expect(await pc.executeCommand('ls -l /usr/sbin/sshd')).toContain('/usr/sbin/sshd');
    expect(await pc.executeCommand('ls -l /usr/sbin/cron')).toContain('/usr/sbin/cron');
  });

  it('c\'est un fichier de root : le supprimer demande les droits', async () => {
    const pc = box();

    // Un binaire posé en 0644 root-writable-par-tous serait une porte
    // dérobée, pas un système de fichiers : la panne §F5.10 doit rester
    // une erreur d'administrateur.
    expect(await pc.executeCommand('rm /usr/sbin/sshd'))
      .toContain("rm: cannot remove '/usr/sbin/sshd': Permission denied");
    expect(await pc.executeCommand('ls -l /usr/sbin/sshd')).toContain('root root');
  });

  it('`/proc/<pid>/exe` pointe sur ce même fichier', async () => {
    const pc = box();
    const pid = await pidOf(pc, '/usr/sbin/sshd');

    expect(await pc.executeCommand(`ls -l /proc/${pid}/exe`))
      .toContain('-> /usr/sbin/sshd');
    // `readlink` lit la même cible : deux commandes, un seul lien.
    expect((await pc.executeCommand(`readlink /proc/${pid}/exe`)).trim())
      .toBe('/usr/sbin/sshd');
  });

  it('le chemin est extrait de `ExecStart=` comme le fait systemd', () => {
    expect(executablePathOf('/usr/sbin/sshd -D')).toBe('/usr/sbin/sshd');
    // Les préfixes de systemd (`-` ignorer l'échec, `@`, `+`, `!`) ne font
    // pas partie du chemin.
    expect(executablePathOf('-/usr/sbin/sshd -D')).toBe('/usr/sbin/sshd');
    expect(executablePathOf('+/usr/bin/foo')).toBe('/usr/bin/foo');
    // Un chemin relatif ne désigne aucun fichier vérifiable.
    expect(executablePathOf('sshd -D')).toBeNull();
    expect(executablePathOf(undefined)).toBeNull();
  });
});

describe('§F5.10 — le processus survit à la suppression de son binaire', () => {
  it('le service reste `active` et continue de servir sur le fil', async () => {
    const { cli, srv } = await lab();
    expect((await sshHostname(cli)).trim()).toBe('linux-server');

    await srv.executeCommand('rm /usr/sbin/sshd');

    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    // Le vrai test n'est pas ce que dit systemd, c'est que le démon répond
    // encore à un client distant.
    expect((await sshHostname(cli)).trim()).toBe('linux-server');
  });

  it('`/proc/<pid>/exe` est le seul à montrer la panne — avec ` (deleted)`', async () => {
    const pc = box();
    const pid = await pidOf(pc, '/usr/sbin/sshd');

    await pc.executeCommand('sudo rm /usr/sbin/sshd');

    expect(await pc.executeCommand(`ls -l /proc/${pid}/exe`))
      .toContain('-> /usr/sbin/sshd (deleted)');
    expect((await pc.executeCommand(`readlink /proc/${pid}/exe`)).trim())
      .toBe('/usr/sbin/sshd (deleted)');
    // Et le fichier, lui, a bel et bien disparu.
    expect(await pc.executeCommand('ls -l /usr/sbin/sshd'))
      .toContain('No such file or directory');
  });
});

describe('§F5.10 — le redémarrage suivant échoue, et c\'est là que ça casse', () => {
  it('`systemctl restart` refuse avec 203/EXEC', async () => {
    const pc = box();
    await pc.executeCommand('sudo rm /usr/sbin/sshd');

    const out = await pc.executeCommand('sudo systemctl restart ssh');

    expect(out).toContain('Job for ssh.service failed because the control process exited');
    // systemd a deux formulations et n'en imprime qu'une : « Failed to
    // start X: <raison> » quand le job n'a pas pu être créé, « Job for X
    // failed… » quand il a tourné et que le processus est mort. Les deux
    // à la fois décriraient deux pannes différentes pour un seul échec.
    expect(out).not.toContain('Failed to restart');
    expect((await pc.executeCommand('systemctl is-active ssh')).trim()).toBe('failed');

    const status = await pc.executeCommand('systemctl status ssh');
    // 203/EXEC est tout le diagnostic : l'enfant n'a jamais pu être
    // exécuté, ce n'est pas un démon qui a démarré puis refusé.
    expect(status).toContain('code=exited, status=203/EXEC');
    expect(status).toContain('Active: failed (Result: exit-code)');
  });

  it('le journal nomme le fichier manquant', async () => {
    const pc = box();
    await pc.executeCommand('sudo rm /usr/sbin/sshd');
    await pc.executeCommand('sudo systemctl restart ssh');

    const journal = await pc.executeCommand('journalctl -u ssh -n 10');
    expect(journal)
      .toContain('Failed to locate executable /usr/sbin/sshd: No such file or directory');
    expect(journal).toContain('Main process exited, code=exited, status=203/EXEC');
    expect(journal).toContain("Failed with result 'exit-code'.");
  });

  it('le port se ferme pour de bon : le client se prend un refus', async () => {
    const { cli, srv } = await lab();
    await srv.executeCommand('rm /usr/sbin/sshd');
    await srv.executeCommand('systemctl restart ssh');

    expect(await sshHostname(cli)).toContain('Connection refused');
  });
});

describe('§F5.10 — la réparation compte autant que la panne', () => {
  it('remettre le binaire fait repartir le service, et servir de nouveau', async () => {
    const { cli, srv } = await lab();
    await srv.executeCommand('rm /usr/sbin/sshd');
    await srv.executeCommand('systemctl restart ssh');
    expect(await sshHostname(cli)).toContain('Connection refused');

    await srv.executeCommand('touch /usr/sbin/sshd');
    await srv.executeCommand('chmod 755 /usr/sbin/sshd');

    expect(await srv.executeCommand('systemctl restart ssh')).toBe('');
    expect((await srv.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect((await sshHostname(cli)).trim()).toBe('linux-server');
  });

  it('le suffixe ` (deleted)` disparaît quand le fichier revient', async () => {
    const pc = box();
    const pid = await pidOf(pc, '/usr/sbin/sshd');
    await pc.executeCommand('sudo rm /usr/sbin/sshd');
    expect(await pc.executeCommand(`ls -l /proc/${pid}/exe`)).toContain('(deleted)');

    await pc.executeCommand('sudo touch /usr/sbin/sshd');

    // Le lien est recalculé à chaque lecture : une chaîne figée à la
    // création garderait le suffixe pour toujours.
    expect(await pc.executeCommand(`ls -l /proc/${pid}/exe`)).not.toContain('(deleted)');
    expect((await pc.executeCommand(`readlink /proc/${pid}/exe`)).trim())
      .toBe('/usr/sbin/sshd');
  });
});

describe('une machine intacte ne voit jamais rien de tout cela', () => {
  it('les services démarrent et redémarrent normalement', async () => {
    const pc = box();

    expect(await pc.executeCommand('sudo systemctl restart ssh')).toBe('');
    expect((await pc.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect(await pc.executeCommand('systemctl status ssh')).not.toContain('203/EXEC');
  });
});
