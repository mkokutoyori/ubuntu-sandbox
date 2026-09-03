/**
 * `execute factoryreset2` remet tout a zero SAUF le reseau, et c'est la
 * difference avec `execute factoryreset` qui fait toute la commande.
 *
 * Elle repondait « unknown action ». Ce qu'elle demande est pourtant
 * ecrit noir sur blanc dans la reference 6.0.4, jusqu'a la liste des
 * branches epargnees : « Reset to factory default except
 * system.global.vdom-admin / VDOMs / system.interface / system.settings
 * / router.static / router.static6 ». C'est la commande qu'on tape pour
 * repartir d'une configuration propre SANS perdre l'acces au boitier —
 * une remise a zero ordinaire couperait la session par laquelle on la
 * tape, ce que la reference dit elle-meme de `factoryreset`.
 *
 * Rien n'est ecrit pour cela : la configuration rendue est deja
 * rejouable — c'est ce que `execute restore` et `execute cfg reload`
 * font —, donc il suffit d'en GARDER les blocs nommes, de remettre a
 * zero, et de les rejouer. `keepConfigBlocks` compte les `config` et les
 * `end` pour suivre l'imbrication, un bloc d'interface pouvant en
 * contenir un autre.
 *
 * **Le cas qui prouve la commande est le TEMOIN inverse** : `execute
 * factoryreset` sur le meme laboratoire EFFACE l'adresse d'interface.
 * Sans lui, une remise a zero qui ne remettrait rien a zero passerait
 * tous les autres cas.
 *
 * **UN DEFAUT PREEXISTANT a ete trouve en chemin et corrige avec** :
 * `execute factoryreset` vidait l'ARBRE de configuration et laissait les
 * magasins VIVANTS intacts. Mesure : apres une remise a zero, `show
 * firewall policy` rendait un bloc vide pendant que le magasin de
 * politiques portait toujours la regle — une machine « remise a zero »
 * continuait donc d'autoriser du trafic que sa propre configuration ne
 * decrivait plus. `factoryReset` supprime desormais chaque objet par la
 * porte qui l'a cree, `onDelete`, dans l'ordre INVERSE du rendu pour que
 * les feuilles partent avant les conteneurs — un domaine virtuel refuse
 * d'etre supprime tant qu'il possede une interface. Le meme defaut
 * touchait `execute restore`, qui remet a zero avant de rejouer.
 *
 * Un point n'est pas atteste et est tranche plutot que laisse au
 * hasard : la reference ne donne pas l'avertissement propre a
 * `factoryreset2`. Celui de `factoryreset` est repris tel quel — il
 * reste vrai, la machine revient bien aux valeurs d'usine — plutot que
 * d'en inventer un second.
 *
 * Discrimine par `git stash push` : 9 des 12 cas tombent, `keepConfigBlocks`
 * etant remis en place pendant la mesure — sans lui le fichier n'importe
 * pas et les douze « echouent » sans rien prouver. Les 3 qui passent des
 * deux cotes sont nommes ici : le TEMOIN `factoryreset`, dont c'est
 * l'objet, et les deux cas unitaires de `keepConfigBlocks`, module neuf
 * et purement additif qu'ils gardent plutot qu'ils n'eprouvent. Trois
 * autres cas ont du etre RENFORCES pour discriminer : « garde l'adresse
 * de l'interface », « garde la route statique » et « garde les domaines
 * virtuels » passaient a vide, une commande inconnue ne detruisant rien ;
 * chacun verifie desormais, dans le meme cas, qu'autre chose a bien ete
 * remis a zero.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { keepConfigBlocks } from '@/network/devices/firewall/vendors/fortios/config/keepConfigBlocks';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function banc() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  for (const ligne of [
    'config system global', 'set hostname "PERSO"', 'end',
    'config system interface', 'edit port1', 'set mode static',
    'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping https', 'next', 'end',
    'config router static', 'edit 1', 'set dst 0.0.0.0 0.0.0.0',
    'set gateway 10.0.0.254', 'set device port1', 'next', 'end',
    'config firewall address', 'edit "LAN"',
    'set subnet 10.0.0.0 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1', 'set name "P"',
    'set srcintf "port1"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set schedule "always"', 'set action accept', 'next', 'end',
  ]) sh.execute(ligne);
  return { fw, sh };
}

describe('execute factoryreset2', () => {
  it('garde l\'adresse de l\'interface, et remet le reste a zero', () => {
    const { sh } = banc();
    sh.execute('execute factoryreset2');
    expect(sh.execute('show system interface port1'))
      .toContain('set ip 10.0.0.1 255.255.255.0');
    expect(sh.execute('show firewall address')).not.toContain('LAN');
  });

  it('garde la route statique, et remet le reste a zero', () => {
    const { sh } = banc();
    sh.execute('execute factoryreset2');
    const routes = sh.execute('show router static');
    expect(routes).toContain('set gateway 10.0.0.254');
    expect(routes).toContain('set device "port1"');
    expect(sh.execute('get system status')).not.toContain('Hostname: PERSO');
  });

  it('TEMOIN : `factoryreset` EFFACE la meme adresse', () => {
    const { sh } = banc();
    sh.execute('execute factoryreset');
    expect(sh.execute('show system interface port1'))
      .not.toContain('set ip 10.0.0.1 255.255.255.0');
  });

  it('remet le nom d\'hote a sa valeur d\'usine', () => {
    const { sh } = banc();
    expect(sh.execute('get system status')).toContain('Hostname: PERSO');
    sh.execute('execute factoryreset2');
    expect(sh.execute('get system status')).not.toContain('Hostname: PERSO');
  });

  it('efface les objets d\'adresse', () => {
    const { sh } = banc();
    sh.execute('execute factoryreset2');
    expect(sh.execute('show firewall address')).not.toContain('LAN');
  });

  it('efface les politiques', () => {
    const { fw, sh } = banc();
    expect(fw.getPolicyStore().ordered().filter(r => !r.implicit)).toHaveLength(1);
    sh.execute('execute factoryreset2');
    expect(fw.getPolicyStore().ordered().filter(r => !r.implicit)).toHaveLength(0);
  });

  it('annonce la remise a zero', () => {
    expect(banc().sh.execute('execute factoryreset2'))
      .toContain('This operation will reset the system to factory default!');
  });

  it('demande confirmation avant d\'agir', () => {
    const { sh } = banc();
    const plan = sh.interactionPlanFor('execute factoryreset2');
    expect(plan).not.toBeNull();
    expect(plan!.steps.some(step => step.kind === 'confirmation')).toBe(true);
  });

  it('figure dans l\'aide a cote de `factoryreset`', () => {
    const aide = banc().sh.execute('execute factory?');
    expect(aide).toContain('factoryreset');
    expect(aide).toContain('factoryreset2');
  });

  it('garde les domaines virtuels', () => {
    const { fw, sh } = banc();
    sh.execute('config vdom');
    sh.execute('edit CLIENT');
    sh.execute('end');
    expect(fw.vdomNames()).toContain('CLIENT');

    sh.execute('execute factoryreset2');
    expect(fw.vdomNames()).toContain('CLIENT');
    expect(sh.execute('get system status')).not.toContain('Hostname: PERSO');
  });

  it('ne garde que les branches nommees', () => {
    const texte = [
      'config router static', '    edit 1', '    next', 'end',
      'config firewall address', '    edit "LAN"', '    next', 'end',
    ].join('\n');
    expect(keepConfigBlocks(texte, ['router static']))
      .toBe('config router static\n    edit 1\n    next\nend');
  });

  it('suit l\'imbrication d\'un bloc dans un bloc', () => {
    const texte = [
      'config system interface', '    edit port1',
      '        config secondaryip', '            edit 1', '            next',
      '        end', '    next', 'end',
      'config firewall address', 'end',
    ].join('\n');
    const garde = keepConfigBlocks(texte, ['system interface']);
    expect(garde.split('\n')).toHaveLength(8);
    expect(garde).not.toContain('firewall address');
  });
});
