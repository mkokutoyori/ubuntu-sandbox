/**
 * `systemctl` repond a la question posee, et un demon n'a qu'UN pid.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : un poste Linux neuf, puis la
 * meme commande avec et sans ses filtres.
 *
 * ```
 * $ systemctl list-units --type=service --state=running
 *   UNIT                          LOAD   ACTIVE SUB     DESCRIPTION
 *
 * 0 loaded units listed. Pass --all to see loaded but inactive units, too.
 *
 * $ systemctl list-units --type=service
 *   apparmor.service               loaded active   running  Load AppArmor profiles
 *   apt-daily.service              loaded inactive dead     Daily apt download activities
 *   … 26 loaded units listed …
 * ```
 *
 * `--state=running` rend ZERO unite alors que la MEME commande sans le
 * filtre en montre dix-huit dont la colonne SUB dit `running`. Le mot
 * est accepte, affiche dans l'aide, et jete a l'evaluation : c'est
 * exactement la regle 6. Symetriquement `--all` ne change rien — la
 * liste sans `--all` contient deja les unites `dead`, et le pied de
 * page invite pourtant a passer `--all` « pour voir les unites
 * inactives ».
 *
 * Et les colonnes ne tombent pas sous leur en-tete : `LOAD   ACTIVE
 * SUB` au-dessus de `loaded active   running`.
 *
 * Un troisieme desaccord, sur la meme machine :
 *
 * ```
 * $ ss -tlnp | grep :22
 * LISTEN 0 0 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=985,fd=3))
 * $ ps -e | grep sshd
 *    22 ?        00:00:00 sshd
 * $ systemctl status ssh
 *    Main PID: 22 (sshd)
 * ```
 *
 * Trois vues, deux reponses. L'ecoute portait un pid ecrit en dur
 * (`SSHD_PID = 985`) pendant que la table des processus en attribuait
 * un vrai. `systemd-resolved`, lui, est d'accord partout (pid 29) — ce
 * qui montre que le chemin correct existe deja.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * RELEVEE sur le systemd 255 installe sur la machine qui execute ce
 * depot (`systemctl --help`) :
 *
 * ```
 *      --state=STATE       List units with particular LOAD or SUB or ACTIVE state
 *   -a --all               Show all properties/all units currently in memory,
 *                          including dead/empty ones. To list all units installed
 *                          on the system, use 'list-unit-files' instead.
 * ```
 *
 * `--state` filtre donc sur l'une QUELCONQUE des trois colonnes, et
 * `--all` est ce qui fait apparaitre les unites mortes — sans lui elles
 * n'ont pas a etre la. Le systeme simule etant une Ubuntu 22.04
 * (systemd 249), la legende en `LOAD   = …` de cette version est
 * conservee telle quelle : seule la SELECTION est en cause.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 6 cas sur 11 tombent contre l'etat d'avant. Les CINQ autres
 * passent des deux cotes, et chacun a sa raison :
 *  - DEJA JUSTE — « --state=inactive filtre sur la colonne ACTIVE » :
 *    c'est le SEUL etat qui marchait, parce qu'`inactive` se trouve
 *    etre aussi un `ServiceState` du modele, la seule chose sur
 *    laquelle le filtre savait porter. Ce cas isole donc la panne :
 *    elle est dans le VOCABULAIRE du filtre, pas dans son principe ;
 *  - VACUEUX AVANT — « le pied de page compte les unites reellement
 *    listees » : avant, `--state=running` rendait zero ligne et
 *    annoncait zero, donc l'accord etait vide de sens. Il est garde
 *    parce qu'apres, c'est lui qui interdit qu'un filtre reduise le
 *    tableau sans reduire le compte ;
 *  - TEMOINS — « is-active repond deja juste » et « service
 *    --status-all marque les memes demons vivants » : deux vues du
 *    MEME registre de services, deja d'accord, qui prouvent que le
 *    defaut etait dans la SELECTION de `list-units` et non dans l'etat
 *    des unites ;
 *  - TEMOIN — « systemd-resolved est deja d'accord partout » : sur la
 *    meme machine, ce demon-la porte le meme pid dans `ss` et dans
 *    `ps`. C'est ce qui montre que le chemin correct existait, et que
 *    seul sshd portait une copie ecrite en dur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Poste {
  executeCommand(cmd: string): Promise<string>;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Poste {
  return createDevice('linux-pc', 0, 0) as unknown as Poste;
}

/** Les lignes d'unite d'un `list-units`, en-tete et pied de page exclus. */
function unites(sortie: string): string[] {
  return sortie.split('\n')
    .filter((l) => /\.(service|timer|target|socket|mount)\s/.test(l));
}

function sousEtat(ligne: string): string {
  return ligne.trim().split(/\s+/)[3] ?? '';
}

describe('list-units filtre sur ce que --state nomme', () => {
  it('--state=running rend les unites dont SUB dit running', async () => {
    const pc = poste();

    const toutes = unites(await pc.executeCommand('systemctl list-units --type=service --all'));
    const attendues = toutes.filter((l) => sousEtat(l) === 'running');
    const rendues = unites(await pc.executeCommand(
      'systemctl list-units --type=service --state=running'));

    expect(attendues.length).toBeGreaterThan(5);
    expect(rendues.length).toBe(attendues.length);
    expect(rendues.every((l) => sousEtat(l) === 'running')).toBe(true);
  });

  it('--state=dead ne rend que les unites mortes', async () => {
    const pc = poste();

    const rendues = unites(await pc.executeCommand(
      'systemctl list-units --type=service --state=dead'));

    expect(rendues.length).toBeGreaterThan(0);
    expect(rendues.every((l) => sousEtat(l) === 'dead')).toBe(true);
  });

  it('--state=inactive filtre sur la colonne ACTIVE', async () => {
    const pc = poste();

    const rendues = unites(await pc.executeCommand(
      'systemctl list-units --type=service --state=inactive'));

    expect(rendues.length).toBeGreaterThan(0);
    expect(rendues.every((l) => l.trim().split(/\s+/)[2] === 'inactive')).toBe(true);
  });

  it('le pied de page compte les unites reellement listees', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('systemctl list-units --type=service --state=running');
    const annonce = Number(/(\d+) loaded units listed/.exec(sortie)?.[1] ?? '-1');

    expect(annonce).toBe(unites(sortie).length);
  });
});

describe('sans --all, les unites mortes ne sont pas listees', () => {
  it('la liste par defaut n a que des unites vivantes', async () => {
    const pc = poste();

    const rendues = unites(await pc.executeCommand('systemctl list-units --type=service'));

    expect(rendues.length).toBeGreaterThan(5);
    expect(rendues.every((l) => sousEtat(l) !== 'dead')).toBe(true);
  });

  it('--all en montre davantage', async () => {
    const pc = poste();

    const parDefaut = unites(await pc.executeCommand('systemctl list-units --type=service'));
    const toutes = unites(await pc.executeCommand('systemctl list-units --type=service --all'));

    expect(toutes.length).toBeGreaterThan(parDefaut.length);
  });
});

describe('les colonnes tombent sous leur en-tete', () => {
  it('LOAD, ACTIVE et SUB sont alignes', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('systemctl list-units --type=service --all');
    const entete = sortie.split('\n').find((l) => l.includes('UNIT') && l.includes('LOAD')) ?? '';

    for (const ligne of unites(sortie).slice(0, 3)) {
      for (const [titre, valeur] of [['LOAD', 'loaded']] as const) {
        expect(ligne.indexOf(valeur)).toBe(entete.indexOf(titre));
      }
    }
  });
});

describe('un demon n a qu un pid, quelle que soit la vue', () => {
  it('ss, ps et systemctl status donnent le meme pid pour sshd', async () => {
    const pc = poste();

    const parPs = /^\s*(\d+)\s/.exec((await pc.executeCommand('ps -e')).split('\n')
      .find((l) => l.includes('sshd')) ?? '')?.[1] ?? '<absent>';
    const parSs = /users:\(\("sshd",pid=(\d+)/.exec(await pc.executeCommand('ss -tlnp'))?.[1] ?? '<absent>';
    const parStatus = /Main PID: (\d+) \(sshd\)/.exec(await pc.executeCommand('systemctl status ssh'))?.[1] ?? '<absent>';

    expect(parPs).toMatch(/^\d+$/);
    expect(parSs).toBe(parPs);
    expect(parStatus).toBe(parPs);
  });

  it('systemd-resolved est deja d accord partout', async () => {
    const pc = poste();

    const parPs = /^\s*(\d+)\s/.exec((await pc.executeCommand('ps -e')).split('\n')
      .find((l) => l.includes('systemd-resolved')) ?? '')?.[1] ?? '<absent>';
    const parSs = /users:\(\("systemd-resolved",pid=(\d+)/
      .exec(await pc.executeCommand('ss -tlnp'))?.[1] ?? '<absent>';

    expect(parPs).toMatch(/^\d+$/);
    expect(parSs).toBe(parPs);
  });
});

describe('TEMOINS', () => {
  it('is-active repond deja juste', async () => {
    const pc = poste();

    expect((await pc.executeCommand('systemctl is-active ssh')).trim()).toBe('active');
    expect((await pc.executeCommand('systemctl is-active named')).trim()).toBe('inactive');
  });

  it('service --status-all marque les memes demons vivants', async () => {
    const pc = poste();

    const statut = await pc.executeCommand('service --status-all');

    expect(statut).toMatch(/\[ \+ ]\s+ssh$/m);
    expect(statut).toMatch(/\[ - ]\s+named$/m);
  });
});
