/**
 * Un disque plein doit faire échouer les écritures, pas seulement le dire.
 *
 * `df -h` et `df -i` rendaient déjà des chiffres réels — la taille des
 * fichiers du VFS — mais contre des plafonds codés en dur dans `df`
 * lui-même, que rien n'appliquait. Un TP pouvait donc « remplir le
 * disque » et toutes les écritures continuaient de réussir :
 * docs/PRD-Pannes.md §F9.1 et §F9.2 étaient tous deux marqués ❌.
 *
 * Deux choses sont réparées ensemble, et les deux comptent :
 *
 *   - **La capacité appartient au système de fichiers**, pas à la
 *     commande qui l'affiche. `df` lit désormais les chiffres du VFS, ce
 *     qui est aussi ce qui permet à un TP de rétrécir le volume et
 *     d'avoir le rapport ET l'écriture suivante d'accord.
 *   - **`truncate -s` occupait zéro octet.** La taille était extraite de
 *     la ligne de commande puis ignorée, donc `truncate -s 1G gros`
 *     créait un fichier VIDE : il n'existait aucun moyen d'occuper de la
 *     place, c'est-à-dire aucun moyen de provoquer la panne.
 *
 * §F9.2 est le classique déroutant, et il est vérifié tel quel : les
 * écritures échouent **alors que `df -h` montre de la place**. Seul
 * `df -i` révèle la cause.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function box(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  return pc;
}

/** Le VFS de la machine — ce que `df` lit, et ce qu'un TP dimensionne. */
function vfsOf(pc: LinuxPC): VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

describe('la capacité du volume est celle du système de fichiers', () => {
  it('`df -h` suit le volume, pas une constante de la commande', async () => {
    const pc = box();
    vfsOf(pc).setCapacityBytes(2 * 1024 * 1024 * 1024); // 2 G

    const out = await pc.executeCommand('df -h /');
    expect(out).toContain('2.0G');
  });

  it('`truncate -s` occupe vraiment la place demandée', async () => {
    const pc = box();

    await pc.executeCommand('truncate -s 100M /tmp/gros');

    // La machine journalise en continu, donc l'occupation totale bouge
    // toute seule : ce qui se mesure ici est la taille du fichier.
    expect(vfsOf(pc).resolveInode('/tmp/gros')?.size).toBe(100 * 1024 * 1024);
    // `ls -l` lit la même : une seule vérité sur ce fichier.
    expect(await pc.executeCommand('ls -l /tmp/gros')).toContain('104857600');
    // Et cette taille compte dans l'occupation du volume.
    expect(vfsOf(pc).usedBytes()).toBeGreaterThan(100 * 1024 * 1024);
  });

  it('`df` montre la place consommée juste après', async () => {
    const pc = box();
    vfsOf(pc).setCapacityBytes(200 * 1024 * 1024); // 200 M

    await pc.executeCommand('truncate -s 150M /tmp/gros');

    // 150 sur 200 : le pourcentage doit avoir bougé pour de bon.
    const out = await pc.executeCommand('df -h /');
    expect(out).toMatch(/7[5-9]%|8[0-9]%/);
  });
});

describe('§F9.1 — plus de place : l\'écriture échoue vraiment', () => {
  it('`truncate` refuse avec le message du noyau', async () => {
    const pc = box();
    vfsOf(pc).setCapacityBytes(vfsOf(pc).usedBytes() + 10 * 1024 * 1024); // 10 M libres

    const out = await pc.executeCommand('truncate -s 50M /tmp/trop-gros');

    expect(out).toContain('No space left on device');
    expect(vfsOf(pc).resolveInode('/tmp/trop-gros')).toBeNull();
  });

  it('un fichier déjà écrit reste intact — le refus ne détruit rien', async () => {
    const pc = box();
    await pc.executeCommand('echo "donnees importantes" > /tmp/rapport');
    vfsOf(pc).setCapacityBytes(vfsOf(pc).usedBytes()); // pile plein

    await pc.executeCommand('truncate -s 1G /tmp/autre');

    expect(await pc.executeCommand('cat /tmp/rapport')).toContain('donnees importantes');
  });

  it('libérer de la place remet le volume en état d\'écrire', async () => {
    const pc = box();
    await pc.executeCommand('truncate -s 100M /tmp/gros');
    vfsOf(pc).setCapacityBytes(vfsOf(pc).usedBytes() + 1024); // presque plein

    expect(await pc.executeCommand('truncate -s 10M /tmp/encore'))
      .toContain('No space left on device');

    await pc.executeCommand('rm /tmp/gros');

    // La réparation compte autant que la panne (PRD §P4).
    expect(await pc.executeCommand('truncate -s 10M /tmp/encore')).toBe('');
    expect(vfsOf(pc).resolveInode('/tmp/encore')).not.toBeNull();
  });

  it('remplacer un gros fichier par un autre de même taille passe', async () => {
    const pc = box();
    await pc.executeCommand('truncate -s 100M /tmp/gros');
    vfsOf(pc).setCapacityBytes(vfsOf(pc).usedBytes()); // pile plein

    // La place libérée par l'écrasement paie l'écriture : refuser ici
    // serait faux, et c'est pourquoi la vérification porte sur le DELTA.
    expect(await pc.executeCommand('truncate -s 100M /tmp/gros')).toBe('');
  });
});

describe('§F9.2 — plus d\'inodes : le classique déroutant', () => {
  it('`touch` échoue alors que `df -h` montre de la place, et `df -i` explique', async () => {
    const pc = box();
    const vfs = vfsOf(pc);
    vfs.setInodeCapacity(vfs.usedInodes()); // plus un seul inode libre

    const touched = await pc.executeCommand('touch /tmp/nouveau');
    expect(touched).toContain('No space left on device');

    // Le piège : le volume a de la place, et pourtant plus rien ne passe.
    const dfh = await pc.executeCommand('df -h /');
    expect(dfh).not.toMatch(/100%/);
    // Seul `df -i` dit pourquoi.
    expect(await pc.executeCommand('df -i')).toContain('100%');
  });

  it('`mkdir` échoue aussi — un répertoire est un inode', async () => {
    const pc = box();
    const vfs = vfsOf(pc);
    vfs.setInodeCapacity(vfs.usedInodes());

    expect(await pc.executeCommand('mkdir /tmp/dossier'))
      .toContain('No space left on device');
  });

  it('supprimer un fichier rend l\'inode, et l\'écriture repasse', async () => {
    const pc = box();
    await pc.executeCommand('touch /tmp/jetable');
    const vfs = vfsOf(pc);
    vfs.setInodeCapacity(vfs.usedInodes());

    expect(await pc.executeCommand('touch /tmp/nouveau'))
      .toContain('No space left on device');

    await pc.executeCommand('rm /tmp/jetable');

    expect(await pc.executeCommand('touch /tmp/nouveau')).toBe('');
  });
});

describe('une machine intacte ne voit jamais rien de tout cela', () => {
  it('les valeurs par défaut laissent le disque invisible', async () => {
    const pc = box();

    // 50 G et 655 360 inodes : les plafonds que `df` affichait déjà.
    expect(vfsOf(pc).getCapacityBytes()).toBe(50 * 1024 * 1024 * 1024);
    expect(await pc.executeCommand('touch /tmp/a')).toBe('');
    expect(await pc.executeCommand('mkdir /tmp/d')).toBe('');
    expect(await pc.executeCommand('df -h /')).toContain('50G');
  });
});
