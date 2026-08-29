/**
 * Une abreviation ambigue est refusee, meme quand les deux commandes
 * qu'elle abrege vivent dans des MOTEURS differents.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * Sur une machine neuve, en mode `config` :
 *
 *   rout          -> `% Ambiguous command:  "rout"`   (juste)
 *   rout rip      -> entre en `config-router`          (faux)
 *   rout 1        -> entre en `config-route-map`       (faux, et pire)
 *
 * La MEME abreviation etait donc tranchee differemment selon qu'un
 * argument suivait — et, quand il suivait, resolue vers DEUX commandes
 * differentes selon ce qu'il etait. Un operateur qui tape `rout` obtient
 * un refus ; le meme operateur qui tape `rout 1` se retrouve dans un
 * mode qu'il n'a pas demande, sans un mot.
 *
 * ── La cause, tracee et non supposee ────────────────────────────────
 *
 * Ce depot porte DEUX moteurs de commandes — le socle (`CommandTable`,
 * ou vit `router rip`) et le trie (`CommandTrie`, ou vit `route-map`) —
 * et le socle est consulte en premier. Une trace posee dans le trie
 * montre qu'il n'est JAMAIS atteint pour `rout rip` : le socle a deja
 * repondu. Chaque moteur detecte parfaitement l'ambiguite dans SON
 * vocabulaire, et aucun ne voit celui de l'autre ; `prefixIsUnambiguous`
 * est l'unique pont entre les deux.
 *
 * Ce pont laissait passer ce cas pour deux raisons qui se cumulent :
 * `prefixMatches` ecarte par principe un chemin du trie plus COURT que
 * la frappe — `route-map` fait un mot, `rout rip` en fait deux — et
 * `trieSpellsWhatSocleAbbreviates` RENONCE des que le mot tape abrege le
 * mot-cle du socle, ce qui est exactement la situation ambigue.
 *
 * `firstWordIsAmbiguous` la nomme : quand le mot tape abrege a la fois
 * le mot-cle du socle et un mot-cle DIFFERENT du trie, la ligne est
 * ambigue quoi qu'il suive. C'est la regle d'IOS, dont l'analyseur
 * tranche mot par mot et ne regarde pas la suite de la ligne.
 *
 * ── Ce qui n'est deliberement PAS ferme ─────────────────────────────
 *
 * Le correctif ne porte que sur le PREMIER mot. `ip ro 10.0.0.0
 * 255.0.0.0 192.168.1.1` reste accepte alors que `ro` abrege `route`
 * autant que `routing` sous `ip` — l'ambiguite est au rang 1, et
 * l'etendre a tous les rangs demande de comparer deux vocabulaires dont
 * l'un enumere des LIGNES et l'autre des specs a arguments TYPES, la ou
 * la regle du rang 0 s'appuie sur le fait qu'un premier mot est toujours
 * un mot-cle. Inscrit au `TODO.md` avec sa mesure plutot que force ici,
 * et un cas ci-dessous l'EPINGLE tel qu'il est — pour qu'on sache que
 * c'est connu et non oublie.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `firstWordIsAmbiguous` retiree, 3 des 7 cas tombent. Les 4 autres sont
 * nommes ici : `rout` seul, qui etait DEJA juste et garde qu'on n'a pas
 * casse le chemin qui marchait ; les deux commandes ecrites en entier,
 * qui doivent continuer de fonctionner — c'est ce qui empeche le
 * correctif de refuser tout ce qu'il touche ; et le cas `ip ro`, dont
 * c'est justement l'objet de ne PAS changer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Une machine NEUVE par cas : le mode courant est un etat, pas un detail. */
async function enConfig() {
  const routeur = new CiscoRouter('R', 0, 0);
  await routeur.executeCommand('enable');
  await routeur.executeCommand('configure terminal');
  return routeur;
}

describe('le premier mot est juge sur lui-meme, pas sur la suite', () => {
  it('`rout rip` est ambigu — `rout` abrege `router` ET `route-map`', async () => {
    const routeur = await enConfig();
    expect(await routeur.executeCommand('rout rip')).toContain('% Ambiguous command');
    expect(routeur.getPrompt()).toContain('(config)#');
  });

  it('`rout 1` l\'est aussi, alors qu\'il resolvait vers l\'AUTRE commande', async () => {
    const routeur = await enConfig();
    expect(await routeur.executeCommand('rout 1')).toContain('% Ambiguous command');
    expect(routeur.getPrompt()).not.toContain('route-map');
  });

  it('`rou rip` de meme, plus court encore', async () => {
    const routeur = await enConfig();
    expect(await routeur.executeCommand('rou rip')).toContain('% Ambiguous command');
  });

  it('TEMOIN : `rout` SEUL etait deja juste et le reste', async () => {
    const routeur = await enConfig();
    expect(await routeur.executeCommand('rout')).toContain('% Ambiguous command');
  });
});

describe('ce qui est ecrit en entier passe toujours', () => {
  it('TEMOIN : `router rip` entre bien en configuration de routage', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('router rip');
    expect(routeur.getPrompt()).toContain('(config-router)#');
  });

  it('TEMOIN : `route-map` entre bien dans son propre mode', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('route-map TEST permit 10');
    expect(routeur.getPrompt()).toContain('(config-route-map)#');
  });
});

describe('la limite assumee du correctif', () => {
  it('`ip ro` reste accepte — l\'ambiguite au rang 1 n\'est pas traitee', async () => {
    const routeur = await enConfig();
    const sortie = await routeur.executeCommand('ip ro 10.0.0.0 255.0.0.0 192.168.1.1');
    expect(sortie.trim()).toBe('');
  });
});
