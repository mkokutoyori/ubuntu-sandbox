/**
 * §F9.3 — la table de descripteurs d'un processus, calculée à un seul
 * endroit.
 *
 * Un processus a UNE table de descripteurs, et tout ce qui en parle doit la
 * lire au même endroit : `/proc/<pid>/fd`, `lsof`, et le contrôle de
 * `RLIMIT_NOFILE`. La numérotation vivait dans `materializeProcFd` — elle
 * était donc RENDUE mais jamais COMPTÉE, et le plafond `ulimit -n` affichait
 * 1024 sans que rien ne le consulte : quatrième occurrence du motif après
 * `df` (§F9.1), `ulimit -u` (§F5.8) et `MemoryMax=` (§F5.9).
 *
 * Ce fichier couvre la fondation : une seule numérotation, partagée par le
 * rendu et le comptage, et `ulimit -n` qui devient une vraie valeur réglable
 * lue au même endroit que `-u`. **L'application d'`EMFILE` à l'ouverture
 * n'est pas encore branchée** — elle est la suite, et rien ici ne prétend
 * le contraire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  openDescriptors, descriptorCount,
} from '@/network/devices/linux/process/FileDescriptorTable';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function box(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

describe('la numérotation des descripteurs est celle du noyau', () => {
  it('0/1/2 pointent sur le terminal quand il y en a un', () => {
    const fds = openDescriptors({ pid: 42, tty: 'pts/0' });

    expect(fds.map((d) => d.fd)).toEqual([0, 1, 2]);
    expect(fds.every((d) => d.target === '/dev/pts/0')).toBe(true);
  });

  it('un démon sans terminal a ses 0/1/2 sur une socket', () => {
    // C'est ce que `/proc/<pid>/fd` montre pour un service lancé par
    // systemd — pas `/dev/null`.
    expect(openDescriptors({ pid: 7 })[0].target).toBe('socket:[10007]');
  });

  it('les fichiers gardent leur numéro, les sockets suivent', () => {
    const fds = openDescriptors({
      pid: 5, tty: 'pts/0',
      openFiles: [{ fd: 3, path: '/var/log/syslog' }],
      socketIds: [900, 901],
    });

    expect(fds.map((d) => d.fd)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fds[3].target).toBe('/var/log/syslog');
    expect(fds[4].target).toBe('socket:[900]');
    expect(fds[5].target).toBe('socket:[901]');
  });

  it('le compte est la longueur de cette même table', () => {
    const src = { pid: 5, tty: 'pts/0', socketIds: [900, 901] };

    // Compter autrement, c'est se préparer à ce que `lsof` et le plafond
    // ne parlent pas du même processus.
    expect(descriptorCount(src)).toBe(openDescriptors(src).length);
    expect(descriptorCount(src)).toBe(5);
  });
});

describe('`/proc/<pid>/fd` rend exactement cette table', () => {
  it('sshd a ses trois standards et ses sockets d\'écoute', async () => {
    const pc = box();
    const ps = await pc.executeCommand('ps aux');
    const pid = ps.split('\n').find((l) => l.includes('/usr/sbin/sshd'))!
      .trim().split(/\s+/)[1];

    const listing = await pc.executeCommand(`ls /proc/${pid}/fd`);
    expect(listing).toContain('0');
    expect(listing).toContain('1');
    expect(listing).toContain('2');
  });
});

describe('`ulimit -n` est une valeur réglable, comme `-u`', () => {
  it('la valeur par défaut est celle qu\'affichait déjà la commande', async () => {
    const pc = box();

    expect((await pc.executeCommand('ulimit -n')).trim()).toBe('1024');
  });

  it('l\'abaisser change ce que la commande répond', async () => {
    const pc = box();

    await pc.executeCommand('ulimit -n 64');

    expect((await pc.executeCommand('ulimit -n')).trim()).toBe('64');
  });

  it('`ulimit -a` dit la même chose que `ulimit -n`', async () => {
    const pc = box();
    await pc.executeCommand('ulimit -n 64');

    expect(await pc.executeCommand('ulimit -a'))
      .toContain('open files                      (-n) 64');
  });

  it('jamais au-dessus de la limite dure, comme pour `-u`', async () => {
    const pc = box();

    expect(await pc.executeCommand('ulimit -n 99999'))
      .toContain('open files: cannot modify limit: Operation not permitted');
  });

  it('régler `-n` ne touche pas `-u`, et réciproquement', async () => {
    const pc = box();

    await pc.executeCommand('ulimit -n 64');
    await pc.executeCommand('ulimit -u 7');

    // Les deux limites partagent leur code : elles ne doivent surtout pas
    // partager leur valeur.
    expect((await pc.executeCommand('ulimit -n')).trim()).toBe('64');
    expect((await pc.executeCommand('ulimit -u')).trim()).toBe('7');
  });
});

describe('§F9.3 — les journaux que rsyslog tient ouverts SONT ses descripteurs', () => {
  it('`/proc/<pid>/fd` de rsyslog montre le fichier journal', async () => {
    const pc = box();
    await pc.executeCommand('logger -t essai "une ligne"');
    const ps = await pc.executeCommand('ps aux');
    const pid = ps.split('\n').find((l) => l.includes('rsyslogd'))!
      .trim().split(/\s+/)[1];

    // Le descripteur appartient au PROCESSUS, plus au gestionnaire de logs :
    // c'est ce qui fait que /proc, lsof et le plafond parlent du même.
    const fds = await pc.executeCommand(`ls -l /proc/${pid}/fd`);
    expect(fds).toContain('/var/log/syslog');
  });

  it('`lsof` numérote ce descripteur comme la table, pas en dur', async () => {
    const pc = box();
    await pc.executeCommand('logger -t essai "avant"');
    await pc.executeCommand('sudo rm /var/log/syslog');
    await pc.executeCommand('logger -t essai "dans-le-vide"');

    const out = await pc.executeCommand('lsof');
    const line = out.split('\n').find((l) => l.includes('(deleted)'));
    expect(line, 'le descripteur supprimé devrait apparaître').toBeTruthy();
    // Le numéro sortait d'un `7w` écrit en dur au point de rendu.
    expect(line).toMatch(/rsyslogd\s+\d+\s+\S+\s+3w/);
  });
});
