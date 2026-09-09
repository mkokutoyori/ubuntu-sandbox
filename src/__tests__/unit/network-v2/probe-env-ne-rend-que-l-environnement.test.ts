/**
 * `env` rend l'ENVIRONNEMENT, pas la table de variables du shell.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : un poste Linux neuf, puis
 * `env | sort`.
 *
 * ```
 * #=0
 * *=
 * 0=bash
 * @=
 * EUID=1000
 * HOME=/home/user
 * HOSTNAME=linux-pc
 * …
 * UID=1000
 * ```
 *
 * Six lignes qui n'ont rien a faire la. `$#`, `$*`, `$@` et `$0` sont
 * des PARAMETRES du shell — le nombre d'arguments, la liste des
 * arguments, le nom du programme — et n'entrent jamais dans
 * l'environnement d'un processus. `UID`, `EUID` et `HOSTNAME` sont des
 * variables que bash pose pour lui-meme et n'exporte pas.
 *
 * Le mecanisme existait pourtant : `Environment` tient un ensemble
 * `exported` et rend `getExported()`, que `export -p` lit. Mais
 * l'interprete passait `getAll()` — TOUTE la table — au processus
 * enfant. Un critere stocke et jamais evalue : c'est la regle 6, et la
 * consequence porte loin, puisque cette table est ce que voient `env`,
 * `printenv`, `ssh hote env`, `sudo env` et tout script enfant.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * RELEVE sur le GNU/Linux qui execute ce depot, ce qui prime sur toute
 * documentation :
 *
 * ```
 * $ bash -c 'for v in HOSTNAME PPID BASH OSTYPE SHELL PWD OLDPWD IFS PS1; do
 *     printf "%-10s env=%s set=%s\n" "$v" "$(env|grep -c "^$v=")" "${!v:+yes}"; done'
 * HOSTNAME   env=0 set=yes
 * PPID       env=0 set=yes
 * BASH       env=0 set=yes
 * OSTYPE     env=0 set=yes
 * SHELL      env=1 set=yes
 * PWD        env=1 set=yes
 * OLDPWD     env=1 set=yes
 * IFS        env=0 set=yes
 * PS1        env=0 set=
 * $ bash -c 'env | grep -c "^EUID="; env | grep -c "^UID="'
 * 0
 * 0
 * ```
 *
 * `SHELL`, `PWD` et `OLDPWD` sont dans l'environnement ; `HOSTNAME`,
 * `PPID`, `BASH`, `OSTYPE`, `IFS`, `UID` et `EUID` sont POSES et
 * VISIBLES dans le shell sans y etre. La distinction n'est donc pas
 * « connu / inconnu » mais « exporte / pas exporte ».
 *
 * ── Discrimination (`git stash push -- src/network src/bash`) ──────
 *
 * Mesuree : 5 cas sur 11 tombent contre l'etat d'avant. Les SIX autres
 * passent des deux cotes, et chacun a sa raison :
 *  - TEMOINS — « export -p rend deja la bonne liste » et « set rend la
 *    table complete du shell » : les DEUX vues qui encadrent le
 *    defaut. `export -p` lisait deja `getExported()` et disait donc la
 *    verite pendant qu'`env` mentait ; `set` doit continuer de montrer
 *    `UID` et `HOME`, ce qui prouve qu'on n'a pas EFFACE les variables
 *    non exportees mais seulement cesse de les transmettre ;
 *  - NON-REGRESSION — « ce que la session a herite y est » : ce cas
 *    n'aurait pas du bouger, et il garde la reparation honnete. Une
 *    correction qui viderait l'environnement le ferait tomber ;
 *  - NON-REGRESSION — « $UID reste lisible dans le shell » : meme
 *    role, cote lecture ;
 *  - DEJA JUSTES — « printenv rend le meme ensemble qu'env » (les deux
 *    lisaient deja la meme table, fausse ensemble) et « une variable
 *    exportee passe » (le cas nominal, qui marchait). Le premier
 *    devient utile maintenant qu'il y a deux tables possibles a
 *    confondre.
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

async function noms(pc: Poste, commande = 'env'): Promise<string[]> {
  return (await pc.executeCommand(commande)).split('\n')
    .map((l) => l.split('=')[0])
    .filter((n) => n.length > 0);
}

describe('l environnement ne contient pas les parametres du shell', () => {
  it('les parametres speciaux n y sont pas', async () => {
    const pc = poste();

    const presents = await noms(pc);

    for (const parametre of ['#', '*', '@', '0', '?', '$']) {
      expect(presents).not.toContain(parametre);
    }
  });

  it('les variables que bash n exporte pas n y sont pas', async () => {
    const pc = poste();

    const presents = await noms(pc);

    for (const variable of ['UID', 'EUID', 'HOSTNAME', 'PPID', 'IFS', 'PS1']) {
      expect(presents).not.toContain(variable);
    }
  });

  it('printenv rend exactement le meme ensemble qu env', async () => {
    const pc = poste();

    expect((await noms(pc, 'printenv')).sort()).toEqual((await noms(pc)).sort());
  });

  it('ce que la session a herite y est', async () => {
    const pc = poste();

    const presents = await noms(pc);

    for (const variable of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TERM', 'LANG']) {
      expect(presents).toContain(variable);
    }
  });
});

describe('le shell voit ce qu il n exporte pas', () => {
  it('$UID reste lisible dans le shell', async () => {
    const pc = poste();

    expect((await pc.executeCommand('echo $UID')).trim()).toMatch(/^\d+$/);
    expect((await pc.executeCommand('echo $HOSTNAME')).trim()).not.toBe('');
  });

  it('printenv UID refuse, puisque UID n est pas dans l environnement', async () => {
    const pc = poste();

    expect((await pc.executeCommand('printenv UID')).trim()).toBe('');
  });
});

describe('export decide de ce qui passe au processus enfant', () => {
  it('une variable simplement posee ne passe pas', async () => {
    const pc = poste();

    const vu = await pc.executeCommand('MAVAR=bonjour; env | grep MAVAR');

    expect(vu.trim()).toBe('');
  });

  it('une variable exportee passe', async () => {
    const pc = poste();

    const vu = await pc.executeCommand('export MAVAR=bonjour; env | grep MAVAR');

    expect(vu.trim()).toBe('MAVAR=bonjour');
  });

  it('export -n la retire de l environnement', async () => {
    const pc = poste();

    const vu = await pc.executeCommand('export MAVAR=bonjour; export -n MAVAR; env | grep MAVAR');

    expect(vu.trim()).toBe('');
  });
});

describe('TEMOINS', () => {
  it('export -p rend deja la bonne liste', async () => {
    const pc = poste();

    const liste = await pc.executeCommand('export MAVAR=bonjour; export -p');

    expect(liste).toContain('MAVAR="bonjour"');
    expect(liste).not.toMatch(/declare -x (UID|EUID)=/);
  });

  it('set rend la table complete du shell, elle', async () => {
    const pc = poste();

    const table = await pc.executeCommand('set');

    expect(table).toMatch(/^UID=/m);
    expect(table).toMatch(/^HOME=/m);
  });
});
