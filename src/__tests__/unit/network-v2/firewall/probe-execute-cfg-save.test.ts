/**
 * `set cfg-save manual` : la commande PREND effet, mais elle n'est pas
 * SAUVEE tant qu'on ne le demande pas.
 *
 * Ni l'attribut ni les deux commandes qui vont avec n'existaient — `set
 * cfg-save` etait un attribut inconnu et `execute cfg` une action
 * inconnue —, alors que le shell repondait deja `noSaveNeeded()` a
 * `write` : il affirmait donc le mode `automatic` sans que l'autre mode
 * existe pour lui donner un sens.
 *
 * Ce que la reference 6.0.4 attribue a chaque mode est reproduit mot
 * pour mot, y compris les deux refus inertes qui sont le comportement
 * NORMAL du mode par defaut : « no config to be saved. » et « no config
 * to be reloaded. » en automatique, « config saved. » et « configs
 * reloaded. system will reboot. » en manuel. Le second « no config to be
 * saved. » — celui qu'on obtient en manuel quand rien n'a change depuis
 * la derniere sauvegarde — est atteste par la meme page.
 *
 * **Le cas qui porte tout le sens est celui de la PERTE** : en manuel,
 * une modification faite apres la derniere sauvegarde disparait au
 * rechargement. C'est la raison d'etre du mode — se remettre d'une
 * configuration qui coupe l'acces — et un `cfg reload` qui garderait la
 * modification serait la trahison exacte de ce que la commande promet.
 *
 * Rien n'est ecrit pour restaurer : `factoryReset` puis rejeu du texte
 * sauve, c'est-a-dire le chemin que `execute restore config flash` suit
 * deja. Le magasin ne garde qu'UNE chose, l'instantane, et il n'existe
 * qu'en mode manuel — en automatique il n'y a rien a figer, la
 * configuration sauvee ETANT la courante.
 *
 * **`revert` est refuse en nommant ce qui manque** : ce troisieme mode
 * ne differe de `manual` que par un retour arriere declenche par
 * l'INACTIVITE de la session d'administration, minuterie par session que
 * ce simulateur ne tient pas. L'accepter en le traitant comme `manual`
 * ferait croire a une protection qui n'aurait pas lieu, et l'accepter en
 * rangeant `cfg-revert-timeout` sans le lire rangerait un critere que
 * rien n'evalue.
 *
 * Discrimine par `git stash push` : 11 des 13 cas tombent. Les 2 autres
 * sont nommes ici plutot que laisses a decouvrir, et tous deux passaient
 * pour une raison qui ne prouve rien : « une commande PREND effet en
 * mode manuel » parce que `set cfg-save manual` etait refuse, donc la
 * machine restait en automatique ou tout prend effet de toute facon ; et
 * « refuse une operation qui n'existe pas » parce que c'est `cfg`
 * lui-meme qui etait une action inconnue, pas `zorglub`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function banc(): FortiShell {
  return new FortiShell(new FortiGate('firewall-fortinet', 'FGT', 0, 0));
}

function taper(sh: FortiShell, ...lignes: string[]): string {
  let derniere = '';
  for (const ligne of lignes) derniere = sh.execute(ligne);
  return derniere;
}

function mode(sh: FortiShell, valeur: string): string {
  sh.execute('config system global');
  const verdict = sh.execute(`set cfg-save ${valeur}`);
  sh.execute('end');
  return verdict;
}

function nommer(sh: FortiShell, nom: string): void {
  taper(sh, 'config system global', `set hostname "${nom}"`, 'end');
}

function nom(sh: FortiShell): string {
  return (/Hostname: (\S+)/.exec(sh.execute('get system status')) ?? [])[1] ?? '';
}

describe('le mode de sauvegarde de la configuration', () => {
  it('ne sauve rien en mode automatique, et le dit', () => {
    expect(banc().execute('execute cfg save')).toBe('no config to be saved.');
  });

  it('ne recharge rien en mode automatique, et le dit', () => {
    expect(banc().execute('execute cfg reload')).toBe('no config to be reloaded.');
  });

  it('refuse `revert` en nommant la minuterie qui manque', () => {
    const sortie = mode(banc(), 'revert');
    expect(sortie).toContain('Command fail');
    expect(sortie).toContain('idle timer');
  });

  it('accepte `manual` et le rend dans la configuration', () => {
    const sh = banc();
    expect(mode(sh, 'manual')).toBe('');
    expect(sh.execute('show system global')).toContain('set cfg-save manual');
  });

  it('une commande PREND effet en mode manuel, sauvee ou non', () => {
    const sh = banc();
    mode(sh, 'manual');
    nommer(sh, 'MANUEL');
    expect(nom(sh)).toBe('MANUEL');
  });

  it('sauve sur demande', () => {
    const sh = banc();
    mode(sh, 'manual');
    nommer(sh, 'MANUEL');
    expect(sh.execute('execute cfg save')).toBe('config saved.');
  });

  it('ne sauve pas deux fois ce qui n\'a pas change', () => {
    const sh = banc();
    mode(sh, 'manual');
    nommer(sh, 'MANUEL');
    sh.execute('execute cfg save');
    expect(sh.execute('execute cfg save')).toBe('no config to be saved.');
  });

  it('recharge la configuration sauvee et annonce le redemarrage', () => {
    const sh = banc();
    mode(sh, 'manual');
    nommer(sh, 'MANUEL');
    sh.execute('execute cfg save');
    expect(sh.execute('execute cfg reload'))
      .toBe('configs reloaded. system will reboot.');
    expect(nom(sh)).toBe('MANUEL');
  });

  it('PERD au rechargement ce qui n\'avait pas ete sauve', () => {
    const sh = banc();
    mode(sh, 'manual');
    nommer(sh, 'GARDE');
    sh.execute('execute cfg save');
    nommer(sh, 'PERDU');
    expect(nom(sh)).toBe('PERDU');

    sh.execute('execute cfg reload');
    expect(nom(sh)).toBe('GARDE');
  });

  it('revenir en automatique rend le rechargement inerte', () => {
    const sh = banc();
    mode(sh, 'manual');
    nommer(sh, 'MANUEL');
    sh.execute('execute cfg save');
    mode(sh, 'automatic');
    expect(sh.execute('execute cfg reload')).toBe('no config to be reloaded.');
  });

  it('annonce ses deux operations', () => {
    const aide = banc().execute('execute cfg ?');
    expect(aide).toContain('save');
    expect(aide).toContain('reload');
  });

  it('reclame une operation quand il n\'y en a pas', () => {
    expect(banc().execute('execute cfg')).toContain('command parse error');
  });

  it('refuse une operation qui n\'existe pas', () => {
    expect(banc().execute('execute cfg zorglub')).toContain('Unknown action');
  });
});
