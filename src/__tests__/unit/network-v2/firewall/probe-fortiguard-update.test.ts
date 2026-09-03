/**
 * `execute update-now` tente une mise a jour, et la tentative se voit.
 *
 * Mesure de depart : aucune commande de la famille `update-*` n'existait,
 * et `FORTIGUARD_DATABASES` etait une CONSTANTE DE MODULE -- partagee par
 * tous les pare-feux d'une topologie, immuable, donc rien a mettre a
 * jour. Le rendu de `diagnose autoupdate versions` portait pourtant deja
 * une ligne `Last Update Attempt: n/a`, ecrite en dur et renseignee par
 * personne : le champ existait, sa valeur n'existait pas.
 *
 * `FortiGuardDatabases` est desormais un magasin PAR PEREPHERIQUE et la
 * vue le lit. `execute update-av` n'horodate que les deux bases
 * antivirus, `execute update-ips` que les deux bases IPS, `execute
 * update-now` les cinq -- ce que la famille des commandes promet, et ce
 * qu'un cas eprouve en verifiant que les bases NON visees restent a
 * `n/a`.
 *
 * LA DECISION QUI COMPTE : la tentative n'avance AUCUNE version. Sur ce
 * simulateur le reseau de distribution de FortiGuard n'est pas
 * joignable -- `get system fortiguard-service status` le dit depuis
 * toujours, et les cinq bases portent « Contract Expired ». Faire monter
 * un numero de version reviendrait a simuler une connexion qui n'a pas
 * lieu et un abonnement qui n'existe pas ; c'est le decor que ce depot
 * refuse. Ce qui est vrai et mesurable, c'est qu'une TENTATIVE a eu
 * lieu, et c'est exactement ce que le champ inutilise attendait.
 *
 * L'horodatage reutilise `fmtHumanDate`, deja ecrite pour le journal
 * Linux et qui rend precisement la forme de `ctime()` que ces lignes
 * portent, plutot qu'une troisieme copie -- ce depot en a deja supprime
 * une de cette meme fonction.
 *
 * Trois commandes seulement de la famille sont ouvertes, et c'est
 * delibere : `update-geo-ip`, `update-list` et `update-src-vis` visent
 * des bases que ce simulateur ne porte pas. Leur ouvrir une porte
 * horodaterait une base inexistante ; elles restent donc refusees tant
 * que la base n'existe pas.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 5 cas
 * tombent. Les 3 qui passent des deux cotes sont nommes ici, et DEUX
 * d'entre eux passent AVANT correctif POUR UNE RAISON QUI NE PROUVE
 * RIEN :
 *  - « le magasin est PAR pare-feu » passe parce que la constante rendait
 *    `n/a` pour tout le monde -- deux boitiers etaient donc d'accord en
 *    ne portant rien ; le cas garde l'isolement une fois qu'il y a
 *    quelque chose a isoler ;
 *  - « les bases non portees restent REFUSEES » passe parce que TOUTES
 *    les commandes `update-*` etaient refusees ; le cas garde que le lot
 *    n'a pas ouvert plus de portes qu'il ne porte de bases ;
 *  - le TEMOIN, dont c'est l'objet : la vue rend bien cinq bases non
 *    tentees.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

function boitier(): FortiShell {
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0).getShell() as FortiShell;
}

const lignes = (sh: FortiShell, prefixe: string) =>
  sh.execute('diagnose autoupdate versions').split('\n')
    .filter(l => l.startsWith(prefixe));

describe('FortiGate : les mises a jour FortiGuard', () => {
  it('TEMOIN : la vue rend les cinq bases, non tentees', () => {
    const sh = boitier();
    expect(lignes(sh, 'Version')).toHaveLength(5);
    expect(lignes(sh, 'Last Update Attempt'))
      .toEqual(Array(5).fill('Last Update Attempt: n/a'));
  });

  it('`update-now` horodate les CINQ bases', () => {
    const sh = boitier();
    sh.execute('execute update-now');
    expect(lignes(sh, 'Last Update Attempt').filter(l => l.endsWith('n/a')))
      .toHaveLength(0);
  });

  it('`update-av` ne touche QUE les bases antivirus', () => {
    const sh = boitier();
    sh.execute('execute update-av');
    const tentatives = lignes(sh, 'Last Update Attempt');
    expect(tentatives[0]).not.toContain('n/a');
    expect(tentatives[1]).not.toContain('n/a');
    expect(tentatives[2]).toContain('n/a');
    expect(tentatives[3]).toContain('n/a');
    expect(tentatives[4]).toContain('n/a');
  });

  it('`update-ips` ne touche QUE les bases IPS', () => {
    const sh = boitier();
    sh.execute('execute update-ips');
    const tentatives = lignes(sh, 'Last Update Attempt');
    expect(tentatives[0]).toContain('n/a');
    expect(tentatives[2]).not.toContain('n/a');
    expect(tentatives[3]).not.toContain('n/a');
  });

  it('la tentative n avance AUCUNE version, le FDN n etant pas joignable', () => {
    const sh = boitier();
    const avant = lignes(sh, 'Version');
    sh.execute('execute update-now');
    expect(lignes(sh, 'Version')).toEqual(avant);
    expect(sh.execute('execute update-now'))
      .toContain('FortiGuard Distribution Network is not reachable');
  });

  it('le magasin est PAR pare-feu', () => {
    const un = boitier();
    const deux = boitier();
    un.execute('execute update-now');
    expect(lignes(deux, 'Last Update Attempt'))
      .toEqual(Array(5).fill('Last Update Attempt: n/a'));
  });

  it('les bases que ce simulateur ne porte pas restent REFUSEES', () => {
    const sh = boitier();
    expect(sh.execute('execute update-geo-ip')).toContain('unknown action');
    expect(sh.execute('execute update-src-vis')).toContain('unknown action');
  });

  it('l aide nomme les trois commandes de mise a jour ouvertes', () => {
    const sh = boitier();
    const mots = sh.help('execute up').map(l => l.trim().split(/\s{2,}/)[0]);
    expect(mots.filter(mot => mot.startsWith('update-')))
      .toEqual(['update-av', 'update-ips', 'update-now']);
  });
});
