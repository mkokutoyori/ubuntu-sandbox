/**
 * `execute enter <vdom>` fait entrer dans un VDOM, et l'invite le dit.
 *
 * Mesure de depart : la commande n'existait pas (`unknown action
 * "enter"`), alors que TOUT le mecanisme etait deja la -- le registre des
 * VDOM (`VdomRegistry.has`/`names`), le basculement du peripherique
 * (`setActiveVdom`), le suivi de la portee par la coquille (`this.vdom`)
 * et jusqu'a l'invite, qui sait deja ecrire `FGT (global) #`. Il ne
 * manquait que la porte.
 *
 * `official_docs/forti-cli-ref-60.txt` : « Select virtual domain. {name}
 * VDOM name. Use "?" to see a list of available VDOMs. » La derniere
 * phrase est une exigence et non un ornement -- les valeurs sont
 * VIVANTES, donc `?` doit nommer les VDOM que la machine porte a cet
 * instant, ce qu'un cas eprouve en en creant un.
 *
 * DEUX pieges trouves par la mesure, et aucun des deux n'etait
 * previsible depuis le code.
 *
 *  1. `syncActiveVdom()` s'execute apres CHAQUE commande et remettait la
 *     portee a `root` des qu'aucune pile `config vdom` n'etait ouverte.
 *     Un `execute enter` naif etait donc defait au commandement suivant.
 *     La portee ENTREE est desormais la base sur laquelle un bloc
 *     `config vdom` se superpose, au lieu d'un `root` code en dur.
 *  2. L'invite ne connaissait que deux cas, le bloc de configuration et
 *     la portee globale ; entrer dans un VDOM ne se voyait donc nulle
 *     part, alors que c'est la seule confirmation qu'un operateur
 *     obtient. Elle rend `FGT (CLIENT) #`, et `FGT #` sur un boitier a
 *     VDOM unique, ou la vraie machine n'affiche pas d'etiquette.
 *
 * Le cache des specs du socle est INVALIDE par la liste des VDOM : sans
 * cela, un VDOM cree apres le premier appel a l'aide n'aurait jamais
 * paru dans `?`, la cle de contexte de la racine ne portant que le
 * nombre de tables.
 *
 * Le cas de l'aide compare des ENSEMBLES et non des suites : l'ordre que
 * le socle rend ici ignore la casse (`CLIENT, root, TARD`), la reference
 * ne dit rien de l'ordre, et encoder celui que j'avais suppose aurait
 * fige une convention que rien n'atteste.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 5 cas
 * tombent -- j'en avais annonce 6, et c'est le compte MESURE qui est
 * ecrit ici. Le seul qui passe des deux cotes est le TEMOIN, dont c'est
 * l'objet : `config vdom` / `edit` cree bien un VDOM, ce qui a toujours
 * ete vrai et sans quoi rien de ce qui suit ne serait mesurable.
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

function boitier(...vdoms: string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  if (vdoms.length > 0) {
    for (const c of ['config system global', 'set vdom-mode multi-vdom', 'end']) {
      sh.execute(c);
    }
    sh.execute('config vdom');
    for (const nom of vdoms) { sh.execute(`edit ${nom}`); sh.execute('next'); }
    sh.execute('end');
  }
  return { fw, sh };
}

describe('FortiGate : execute enter', () => {
  it('TEMOIN : `config vdom` / `edit` cree bien un VDOM', () => {
    const { fw } = boitier('CLIENT');
    expect(fw.vdomNames()).toContain('CLIENT');
    expect(fw.getVdomRegistry().has('CLIENT')).toBe(true);
  });

  it('la commande fait entrer, et l invite le DIT', () => {
    const { sh } = boitier('CLIENT');
    expect(sh.execute('execute enter CLIENT')).toBe('');
    expect(sh.getPrompt()).toBe('FGT (CLIENT) # ');
  });

  it('la portee SURVIT aux commandes suivantes', () => {
    const { fw, sh } = boitier('CLIENT');
    sh.execute('execute enter CLIENT');
    sh.execute('get system status');
    sh.execute('show system interface');
    expect(sh.getPrompt()).toBe('FGT (CLIENT) # ');
    expect(fw.getVdom().name).toBe('CLIENT');
  });

  it('on revient a root, et l invite n y porte plus d etiquette', () => {
    const { sh } = boitier('CLIENT');
    sh.execute('execute enter CLIENT');
    expect(sh.execute('execute enter root')).toBe('');
    expect(sh.getPrompt()).toBe('FGT # ');
  });

  it('un VDOM inconnu est REFUSE', () => {
    const { sh } = boitier('CLIENT');
    expect(sh.execute('execute enter zorglub'))
      .toContain('virtual domain "zorglub" does not exist');
    expect(sh.getPrompt()).toBe('FGT # ');
    expect(sh.execute('execute enter')).toContain('missing');
  });

  it('`?` nomme les VDOM VIVANTS, y compris un cree apres coup', () => {
    const { sh } = boitier('CLIENT');
    const mots = (l: string) => sh.help(l)
      .map(x => x.trim().split(/\s{2,}/)[0]).filter(w => w !== 'WORD');
    expect([...mots('execute enter ')].sort()).toEqual(['CLIENT', 'root']);

    sh.execute('config vdom');
    sh.execute('edit TARD');
    sh.execute('next');
    sh.execute('end');
    expect([...mots('execute enter ')].sort()).toEqual(['CLIENT', 'TARD', 'root']);
    expect(sh.completions('execute enter TA')).toEqual(['execute enter TARD']);
  });
});
