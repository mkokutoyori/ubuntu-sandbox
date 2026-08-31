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
 * ── Ce que le lot suivant a ferme ───────────────────────────────────
 *
 * Le correctif ci-dessus ne portait que sur le PREMIER mot, et un cas
 * epinglait la limite : `ip ro 10.0.0.0 255.0.0.0 192.168.1.1` restait
 * accepte alors que `ro` abrege `route` autant que `routing` sous `ip`.
 * Elle est levee, par un pont qui va dans l'autre sens. Le trie tient
 * desormais les mots du socle pour des RIVAUX a tous les rangs, via un
 * port en lecture seule (`setRivalKeywordsPort`) qui rend les mots-cles
 * declares sous un chemin. Il les rend depuis les SPECS et ne cree
 * aucun noeud : une premiere version posait un noeud temoin par chemin
 * migre, et la mesure a montre le cout — `interface FastEthernet` etant
 * un mot-cle du socle, le temoin ajoutait un enfant au trie et la
 * tabulation proposait la forme ET les huit ports, la ou elle ecrit le
 * type d'un coup. Un rival ne doit pas devenir un candidat.
 *
 * Le meme lot a retire la resolution PAR LA SUITE, que les deux moteurs
 * portaient chacun de leur cote : `ip rout` seul etait refuse et
 * `ip rout 192.168.9.0 …` POSAIT la route, `route` etant le seul des
 * deux a accepter une adresse. La meme frappe decidait ou non selon ce
 * qu'on ecrivait apres, et une faute de frappe appliquait une commande
 * que personne n'avait tapee. IOS tranche l'inverse, sur une saisie qui
 * porte pourtant un mot de plus : `con t` et `co t` rendent
 * `% Ambiguous command`, et la documentation decrit la reparation comme
 * « trouver QUEL mot allonger » — ce qui n'a de sens que si la ligne
 * entiere reste refusee.
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

describe('l ambiguite se voit a TOUS les rangs, plus seulement au premier', () => {
  it('`ip ro` est refuse — `ro` abrege `route` ET `routing` sous `ip`', async () => {
    const routeur = await enConfig();

    expect(await routeur.executeCommand('ip ro 10.0.0.0 255.0.0.0 192.168.1.1'))
      .toContain('% Ambiguous command');
  });

  it('et aucune abreviation ne les separe — seul le mot entier tranche', async () => {
    const routeur = await enConfig();

    for (const abrege of ['ip ro', 'ip rou', 'ip rout']) {
      expect(await routeur.executeCommand(`${abrege} 10.0.0.0 255.0.0.0 192.168.1.1`), abrege)
        .toContain('% Ambiguous command');
    }
  });

  it('`show ip i` est refuse — `interface` est au socle, `igmp` au trie', async () => {
    const routeur = new CiscoRouter('RA', 0, 0);
    await routeur.executeCommand('enable');

    expect(await routeur.executeCommand('show ip i')).toContain('% Ambiguous command');
  });
});

/**
 * La moitie qui compte vraiment : une abreviation ambigue ne doit rien
 * APPLIQUER. Le message seul ne suffit pas — c'est l'etat de la machine
 * qui dit si la commande a ete executee, et `ip rout` designe justement
 * une commande qui POSE un chemin et une autre qui COUPE le routage.
 */
describe('une abreviation ambigue n APPLIQUE rien', () => {
  it('`no ip rout` ne coupe pas le routage', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('no ip rout');
    await routeur.executeCommand('end');

    expect(await routeur.executeCommand('show running-config'))
      .not.toMatch(/^no ip routing$/m);
  });

  it('`ip rout <prefixe>` ne pose aucune route', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('ip rout 192.168.9.0 255.255.255.0 10.0.0.2');
    await routeur.executeCommand('end');

    expect(await routeur.executeCommand('show running-config'))
      .not.toContain('192.168.9.0');
  });
});

describe('une frappe EXACTE n est jamais ambigue', () => {
  it('`ip routing` s execute bien que `ip route` existe', async () => {
    const routeur = await enConfig();

    expect(await routeur.executeCommand('ip routing')).not.toContain('% Ambiguous');
  });

  it('`no ip routing` COUPE le routage, lui', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('no ip routing');
    await routeur.executeCommand('end');

    expect(await routeur.executeCommand('show running-config')).toMatch(/^no ip routing$/m);
  });

  it('`ip route` pose bien son chemin', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('ip route 192.168.9.0 255.255.255.0 10.0.0.2');
    await routeur.executeCommand('end');

    expect(await routeur.executeCommand('show running-config'))
      .toMatch(/^ip route 192\.168\.9\.0 255\.255\.255\.0 10\.0\.0\.2$/m);
  });
});

describe('TEMOINS — une abreviation qui ne designe QU UNE commande passe', () => {
  it.each([
    ['sh ru', 'Current configuration'],
    ['sh ip int br', 'IP-Address'],
    ['sh ver', 'Cisco IOS Software'],
  ])('`%s`', async (abrege, attendu) => {
    const routeur = new CiscoRouter('RB', 0, 0);
    await routeur.executeCommand('enable');

    expect(await routeur.executeCommand(abrege)).toContain(attendu);
  });

  it('`int g0/0` puis `ip addr` restent servis', async () => {
    const routeur = await enConfig();
    await routeur.executeCommand('int g0/0');

    expect(await routeur.executeCommand('ip addr 1.1.1.1 255.255.255.0'))
      .not.toContain('% ');
  });
});
