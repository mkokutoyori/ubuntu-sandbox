/**
 * Une commande du SOUS-MODE prime celle qu'il herite de son ancetre.
 *
 * MESURE DE DEPART : sous `interface GigabitEthernet0/1`,
 * `no ip vrf forwarding` est ACCEPTE, rend la chaine vide, et ne detache
 * l'interface d'aucune VRF — alors que `no ip vrf forwarding A`, la
 * meme commande avec le nom, la detache correctement. Une interface
 * restait donc rattachee a une VRF qu'on venait de lui retirer, ce qui
 * est exactement l'isolation que le scenario 15 existe pour eprouver.
 *
 * LA CAUSE N'EST PAS DANS LE GESTIONNAIRE, qui est juste et n'etait pas
 * appele. `CommandTable.modeAdmits` admet une commande declaree en
 * `config` depuis `config-if`, parce que `config` est un ANCETRE de
 * `config-if` — regle voulue, et qui reproduit ce que fait IOS. Mais le
 * socle est consulte AVANT le trie, si bien que le `no ip vrf` GLOBAL,
 * admis par heritage, servait la frappe et lisait `forwarding` comme le
 * NOM d'une VRF a supprimer. Il supprimait donc une VRF appelee
 * « forwarding », qui n'existe pas, et se taisait.
 *
 * LA REGLE POSEE : une commande admise par HERITAGE est un repli, et un
 * repli ne prime pas une commande que le mode courant declare pour de
 * bon. C'est la meme garde que `tryMigratedCommand` appliquait deja a
 * `incomplete` et a `invalid` — « le trie garde la main s'il a la
 * suite » — etendue au cas `ok`.
 *
 * DISCRIMINATION : 2 des 8 cas tombent avant correctif — les deux qui
 * observent l'interface DETACHEE. Les 6 autres sont nommes ici plutot
 * que laisses a decouvrir, parce que la plupart ne pouvaient pas
 * discriminer et qu'il vaut mieux le dire que gonfler le compte :
 *  - « la forme avec le nom detache » : c'est le TEMOIN, la forme qui
 *    fonctionnait deja, sans laquelle un gestionnaire entierement casse
 *    et une precedence inversee seraient indiscernables.
 *  - « elle ne supprime AUCUNE VRF au passage » : avant correctif la
 *    frappe supprimait une VRF nommee « forwarding », qui n'existe pas,
 *    donc les deux vraies survivaient de toute facon. Le cas garde que
 *    le correctif ne se met pas a en supprimer une.
 *  - « rattacher apres avoir detache fonctionne » : le gestionnaire
 *    POSITIF retire deja l'interface des autres VRF, donc il rattrapait
 *    le detachement manquant.
 *  - « une commande globale reste joignable depuis un sous-mode », « le
 *    mode ne bouge pas » et « la VRF se supprime depuis le mode
 *    global » : ce sont les cas de NON-REGRESSION de l'heritage
 *    lui-meme, dont l'objet est de passer des deux cotes.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type VrfMap = Map<string, { interfaces: Set<string> }>;

function vrfs(r: CiscoRouter): VrfMap {
  return (r as unknown as { _vrfs?: VrfMap })._vrfs ?? new Map();
}

function lien(r: CiscoRouter): Map<string, string> {
  return (r as unknown as { _ifaceVrf?: Map<string, string> })._ifaceVrf ?? new Map();
}

async function labo(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  for (const c of ['enable', 'configure terminal',
    'ip vrf CLIENT-A', 'exit', 'ip vrf CLIENT-B', 'exit',
    'interface GigabitEthernet0/1', 'ip vrf forwarding CLIENT-A']) {
    await r.executeCommand(c);
  }
  return r;
}

describe('`no ip vrf forwarding` detache l\'interface', () => {
  it('la forme NUE detache, comme sur IOS', async () => {
    const r = await labo();
    await r.executeCommand('no ip vrf forwarding');
    for (const [, vrf] of vrfs(r)) {
      expect(vrf.interfaces.has('GigabitEthernet0/1')).toBe(false);
    }
    expect(lien(r).has('GigabitEthernet0/1')).toBe(false);
  });

  it('la forme avec le NOM detache aussi', async () => {
    const r = await labo();
    await r.executeCommand('no ip vrf forwarding CLIENT-A');
    expect(vrfs(r).get('CLIENT-A')!.interfaces.has('GigabitEthernet0/1')).toBe(false);
  });

  it('et elle ne supprime AUCUNE VRF au passage', async () => {
    const r = await labo();
    await r.executeCommand('no ip vrf forwarding');
    expect([...vrfs(r).keys()].sort()).toEqual(['CLIENT-A', 'CLIENT-B']);
  });

  it('l\'autre VRF garde son interface', async () => {
    const r = await labo();
    for (const c of ['exit', 'interface GigabitEthernet0/2',
      'ip vrf forwarding CLIENT-B', 'exit',
      'interface GigabitEthernet0/1', 'no ip vrf forwarding']) {
      await r.executeCommand(c);
    }
    expect(vrfs(r).get('CLIENT-B')!.interfaces.has('GigabitEthernet0/2')).toBe(true);
    expect(vrfs(r).get('CLIENT-B')!.interfaces.has('GigabitEthernet0/1')).toBe(false);
    expect(vrfs(r).get('CLIENT-A')!.interfaces.has('GigabitEthernet0/1')).toBe(false);
  });

  it('rattacher apres avoir detache fonctionne', async () => {
    const r = await labo();
    await r.executeCommand('no ip vrf forwarding');
    await r.executeCommand('ip vrf forwarding CLIENT-B');
    expect(vrfs(r).get('CLIENT-B')!.interfaces.has('GigabitEthernet0/1')).toBe(true);
    expect(vrfs(r).get('CLIENT-A')!.interfaces.has('GigabitEthernet0/1')).toBe(false);
  });
});

describe('l\'heritage du mode global reste entier', () => {
  it('une commande globale reste joignable depuis un sous-mode', async () => {
    const r = await labo();
    await r.executeCommand('ip vrf CLIENT-C');
    expect([...vrfs(r).keys()]).toContain('CLIENT-C');
  });

  it('et le mode ne bouge pas', async () => {
    const r = await labo();
    await r.executeCommand('hostname AUTRE');
    await r.executeCommand('description depuis l\'interface');
    expect(String(await r.executeCommand('show running-config')))
      .toContain('description depuis l\'interface');
  });

  it('la VRF globale se supprime encore depuis le mode global', async () => {
    const r = await labo();
    await r.executeCommand('exit');
    await r.executeCommand('no ip vrf CLIENT-B');
    expect([...vrfs(r).keys()]).not.toContain('CLIENT-B');
  });
});
