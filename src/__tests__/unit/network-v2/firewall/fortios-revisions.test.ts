/**
 * La configuration garde son HISTORIQUE.
 *
 * §6.5 du carnet nomme le point. La mesure le reduit et le precise :
 * `execute backup` et `restore` existent depuis E42 et passent par un vrai
 * TFTP ; ce qui manque est l'historique. `execute revision` n'existe pas
 * du tout, `execute restore config flash <id>` est refuse, et
 * `revision-backup-on-logout` est absent du schema alors que c'est le
 * reglage qui CREE une revision sur un vrai boitier.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. `revision-backup-on-logout` se regle, et il est DESACTIVE par
 *      defaut — un boitier qui archiverait a chaque deconnexion sans
 *      qu'on le lui demande remplirait sa memoire tout seul.
 *   2. Sous ce reglage, la deconnexion d'un administrateur CREE une
 *      revision. Sans lui, aucune.
 *   3. `execute revision list config` rend les colonnes du vrai outil :
 *      `ID`, `TIME`, `ADMIN`, `FIRMWARE VERSION`, `COMMENT`.
 *   4. La revision porte le nom de l'administrateur qui se deconnecte et
 *      la version du micrologiciel — pas des constantes.
 *   5. `execute restore config flash <id>` REMET la configuration
 *      d'alors : c'est la seule chose qui distingue un historique d'une
 *      liste decorative.
 *   6. `execute revision delete config <id>` la retire, et une
 *      identifiante inconnue est refusee plutot qu'ignoree.
 *   7. Les identifiants ne sont PAS reutilises apres suppression : un
 *      numero qui revient designerait deux configurations differentes.
 *   8. L'historique est BORNE — sinon il croit sans fin.
 *
 * Et deux cas qui n'appartiennent pas au sujet mais que la mesure a
 * trouves en chemin, donc eprouves ici :
 *
 *   9. `exit` ne doit pas laisser fuir une sentinelle interne.
 *  10. `vdom-mode` est une commande CACHEE sur un vrai 7.4/7.6 : elle
 *      n'apparait ni dans `show`, ni dans `show full`, ni dans la liste
 *      du `?`. Elle reste acceptee et honoree — cachee ne veut pas dire
 *      absente.
 *
 * Discrimination (`git stash push -- src/network/ src/terminal/`) : 11
 * des 15 cas tombent avant correctif. Les 4 autres sont nommes ici :
 *   - « une identifiante inconnue est REFUSEE » (pour `delete`) et
 *     « une revision inconnue est REFUSEE » (pour `restore ... flash`)
 *     passaient parce que la commande ENTIERE etait refusee, faute
 *     d'exister — vrai pour la mauvaise raison ;
 *   - « `restore config tftp` fonctionne toujours » est le TEMOIN de
 *     non-regression, dont c'est l'objet de passer des deux cotes ;
 *   - « cachee ne veut pas dire absente » passait parce que `vdom-mode`
 *     etait deja acceptee et honoree ; il garde le mecanisme, il ne le
 *     prouve pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { MAX_CONFIG_REVISIONS } from '@/network/devices/firewall/config/RevisionStore';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

let horloge = 1_700_000_000_000;

function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  horloge = 1_700_000_000_000;
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => horloge });
  return { fw, sh: fw.getShell() };
}

function archiveALaDeconnexion(sh: FortiShell, actif: boolean): string {
  return run(sh, 'config system global',
    `set revision-backup-on-logout ${actif ? 'enable' : 'disable'}`, 'end');
}

function seDeconnecte(fw: FortiGate, admin = 'admin'): void {
  fw.onAdminLogout(admin);
  horloge += 60_000;
}

describe('une revision naît d une deconnexion, et seulement si on l a demande', () => {
  beforeEach(() => { Logger.reset(); });

  it('le reglage est DESACTIVE par defaut', () => {
    const { sh } = laboratoire();
    expect(run(sh, 'show full-configuration system global'))
      .toContain('set revision-backup-on-logout disable');
  });

  it('sans le reglage, une deconnexion ne cree AUCUNE revision', () => {
    const { fw, sh } = laboratoire();
    seDeconnecte(fw);
    expect(run(sh, 'execute revision list config')).not.toMatch(/^1\s/m);
  });

  it('avec le reglage, une deconnexion cree une revision', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);

    seDeconnecte(fw);

    expect(fw.getRevisions().list()).toHaveLength(1);
  });

  it('la revision porte l administrateur et la version du micrologiciel', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);

    seDeconnecte(fw, 'auditeur');

    const revision = fw.getRevisions().list()[0];
    expect(revision?.admin).toBe('auditeur');
    expect(revision?.firmware).toContain(fw.getProfile().defaultVersion);
  });

  it('l historique est BORNE', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);

    for (let i = 0; i < MAX_CONFIG_REVISIONS + 5; i++) seDeconnecte(fw);

    expect(fw.getRevisions().list()).toHaveLength(MAX_CONFIG_REVISIONS);
  });
});

describe('`execute revision` lit et retire l historique', () => {
  beforeEach(() => { Logger.reset(); });

  it('`list config` rend les colonnes du vrai outil', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);
    seDeconnecte(fw);

    const vue = run(sh, 'execute revision list config');

    expect(vue).toContain('ID');
    expect(vue).toContain('TIME');
    expect(vue).toContain('ADMIN');
    expect(vue).toContain('FIRMWARE VERSION');
    expect(vue).toContain('COMMENT');
    expect(vue).toMatch(/^1\s/m);
  });

  it('`delete config <id>` retire la revision', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);
    seDeconnecte(fw);
    expect(fw.getRevisions().list()).toHaveLength(1);

    run(sh, 'execute revision delete config 1');

    expect(fw.getRevisions().list()).toHaveLength(0);
  });

  it('une identifiante inconnue est REFUSEE', () => {
    const { sh } = laboratoire();
    const refus = run(sh, 'execute revision delete config 42');
    expect(refus).not.toBe('');
  });

  it('un identifiant supprime n est pas reutilise', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);
    seDeconnecte(fw);
    run(sh, 'execute revision delete config 1');

    seDeconnecte(fw);

    expect(fw.getRevisions().list()[0]?.id).toBe(2);
  });
});

describe('`execute restore config flash <id>` remet la configuration d alors', () => {
  beforeEach(() => { Logger.reset(); });

  it('la configuration d alors revient', () => {
    const { fw, sh } = laboratoire();
    archiveALaDeconnexion(sh, true);
    run(sh, 'config firewall address', 'edit "avant"',
      'set subnet 10.1.0.0 255.255.0.0', 'next', 'end');
    seDeconnecte(fw);

    run(sh, 'config firewall address', 'edit "apres"',
      'set subnet 10.2.0.0 255.255.0.0', 'next', 'end');
    expect(run(sh, 'show firewall address')).toContain('"apres"');

    run(sh, 'execute restore config flash 1');

    const rendu = run(sh, 'show firewall address');
    expect(rendu).toContain('"avant"');
    expect(rendu).not.toContain('"apres"');
  });

  it('une revision inconnue est REFUSEE', () => {
    const { sh } = laboratoire();
    const refus = run(sh, 'execute restore config flash 42');
    expect(refus).not.toBe('');
  });

  it('`restore config tftp` fonctionne toujours — non-regression', () => {
    const { sh } = laboratoire();
    const refus = run(sh, 'execute restore config tftp');
    expect(refus).toContain('TFTP server address is missing');
  });
});

describe('deux points trouves en chemin', () => {
  beforeEach(() => { Logger.reset(); });

  it('`exit` ne laisse pas fuir de sentinelle interne', () => {
    const { sh } = laboratoire();
    expect(run(sh, 'exit')).not.toContain(' ');
  });

  it('`vdom-mode` est CACHEE de `show`, de `show full` et du `?`', () => {
    const { sh } = laboratoire();
    run(sh, 'config system global', 'set vdom-mode multi-vdom', 'end');

    expect(run(sh, 'show system global')).not.toContain('vdom-mode');
    expect(run(sh, 'show full-configuration system global'))
      .not.toContain('vdom-mode');

    run(sh, 'config system global');
    expect(run(sh, 'set ?')).not.toContain('vdom-mode');
    run(sh, 'end');
  });

  it('cachee ne veut pas dire absente : elle est acceptee et HONOREE', () => {
    const { fw, sh } = laboratoire();
    const refus = run(sh, 'config system global', 'set vdom-mode multi-vdom', 'end');

    expect(refus).toBe('');
    expect(fw.multiVdomEnabled()).toBe(true);
  });
});
