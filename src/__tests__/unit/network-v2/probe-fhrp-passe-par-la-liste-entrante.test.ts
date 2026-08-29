/**
 * Une liste entrante voit AUSSI le plan de controle multicast.
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * En eprouvant l'ACL protocole par protocole, HSRP et VRRP ne
 * repondaient a RIEN : `deny ip any any` pose en entree laissait
 * `show standby` afficher le pair, et `show access-lists` comptait ZERO
 * correspondance. La sonde a d'abord regarde le fil : 80 paquets HSRP
 * (UDP vers 224.0.0.2) arrivaient bel et bien sur l'interface, et la
 * liste n'en voyait aucun.
 *
 * `CiscoRouter.handleFrame` — et son jumeau Huawei — interceptaient
 * IGMP, PIM, HSRP, GLBP et VRRP a la COUCHE LIEN, avant meme que
 * `processIPv4` soit appelee, donc avant la liste entrante. OSPF et
 * EIGRP, eux, sont repartis dans `handleLocalDelivery`, c'est-a-dire
 * APRES elle. La meme machine repondait donc deux choses differentes a
 * « ma liste entrante voit-elle mon plan de controle ? » selon le
 * protocole, et rien ne disait laquelle etait la bonne.
 *
 * ── L'autorite ──────────────────────────────────────────────────────
 *
 * La documentation de depannage HSRP de Cisco tranche : si une liste
 * entrante bloque l'UDP 1985 vers 224.0.0.2, les DEUX routeurs
 * deviennent Actifs, chacun n'entendant plus l'autre — et le remede
 * qu'elle donne est d'ajouter `permit udp any host 224.0.0.2 eq 1985`
 * a la liste ENTRANTE. Cette phrase n'a de sens que si la liste voit
 * ces paquets. Le simulateur ne pouvait donc pas enseigner la panne la
 * plus classique du filtrage sur une interface FHRP.
 *
 * ── Deux defauts trouves en chemin, et corriges avec ────────────────
 *
 * **HSRP et GLBP etaient deja repartis correctement.**
 * `CiscoRouter.receiveControlPlaneUdp` — la couture d'apres-liste
 * introduite pour les agents UDP — les traite deja tous les deux ; le
 * bloc de `handleFrame` etait un DOUBLON qui l'ombrait. Les supprimer
 * suffit, sans une ligne de remplacement : c'est la duplication qui
 * produisait le defaut, pas une regle manquante.
 *
 * **Un protocole ecrit par son NUMERO n'appariait rien.**
 * `permit 112 any any` — la SEULE facon d'ecrire VRRP sur IOS, qui n'a
 * pas de mot-cle `vrrp` — comptait zero correspondance. La comparaison
 * traduisait le numero du paquet en NOM (`protocolKeywordFor`), qui
 * rend `ip` pour tout numero sans mot-cle, et comparait `'ip'` a
 * `'112'`. Tout protocole sans mot-cle etait donc impossible a
 * permettre : 112 (VRRP), 41 (IPv6 dans IPv4), 46 (RSVP), 115 (L2TP).
 * `ipProtocolMatches` vit dans `AclSyntax.ts`, ou le vocabulaire est
 * deja partage entre Cisco et Huawei, et compare des NUMEROS.
 * `getProtocolName` n'avait plus de lecteur et est supprimee.
 *
 * ── Ce qui n'est deliberement PAS change ────────────────────────────
 *
 * La couture est consultee juste APRES la liste entrante et AVANT la
 * decision d'acheminement, et non dans `handleLocalDelivery` ou vivent
 * OSPF et EIGRP. La raison est mesurable : un rapport IGMP est adresse
 * au GROUPE (239.1.1.1 par exemple), c'est-a-dire a du multicast
 * ROUTABLE, que `processIPv4` envoie a `forwardMulticast` et non a la
 * remise locale — le poser dans `handleLocalDelivery` le rendrait
 * inatteignable.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * 5 des 13 cas tombent contre l'etat d'avant — les quatre
 * `deny ip any any`, un par protocole, plus le cas du mot-cle qui ne
 * designe pas 112. Les 8 autres sont nommes ici plutot que laisses a
 * decouvrir, chacun avec sa raison de passer des deux cotes :
 *
 *   les QUATRE cas sans liste     le pair, le relayeur ou le groupe
 *                                 doivent etre vus, c'est ce qui prouve
 *                                 que la maquette converge ;
 *   les QUATRE cas `permit`       ils passaient DEJA — non parce que la
 *                                 liste permettait, mais parce qu'elle
 *                                 ne voyait RIEN et que le paquet
 *                                 arrivait de toute facon.
 *
 * Ces quatre derniers ne prouvent donc rien seuls : ils ne valent qu'a
 * cote de leur voisin `deny ip any any`, qui, lui, tombe. C'est le
 * couple qui mesure, pas la ligne.
 *
 * Note pour qui refera la mesure : ces cinq cas ne tombent que si les
 * CINQ fichiers du correctif sont restaures ensemble
 * (`Router`, `CiscoRouter`, `HuaweiRouter`, `ACLEngine`, `AclSyntax`).
 * Retirer le parametre de la seule base ne change RIEN, les deux
 * redefinitions le laissant tomber en appelant `super` — c'est
 * exactement ce qui avait cache le correctif au premier essai.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const DENY_TOUT = 'access-list 100 deny ip any any';

async function paireFhrp(acl: readonly string[], groupe: readonly string[]) {
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);

  for (const [routeur, n] of [[r1, '1'], [r2, '2']] as const) {
    for (const commande of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${n} 255.255.255.0`,
      'no shutdown', ...groupe, 'exit',
      ...(routeur === r1 ? acl : []),
      ...(routeur === r1 && acl.length
        ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
      'end']) {
      await routeur.executeCommand(commande);
    }
  }
  horloge.advance(120000);
  return r1;
}

/** Le pair que R1 voit — `unknown`/`local` quand il n'entend plus rien. */
async function pairHsrp(acl: readonly string[]): Promise<string> {
  const r1 = await paireFhrp(acl, ['standby 1 ip 10.0.12.254']);
  const vue = await r1.executeCommand('show standby');
  return vue.match(/Standby router is (\S+)/)?.[1] ?? 'absent';
}

/** L'etat VRRP de R1 : `Backup` tant qu'il entend R2, `Master` sinon. */
async function etatVrrp(acl: readonly string[]): Promise<string> {
  const r1 = await paireFhrp(acl, ['vrrp 1 ip 10.0.12.253']);
  const vue = await r1.executeCommand('show vrrp');
  return vue.match(/State is (\S+)/)?.[1] ?? 'absent';
}

describe('HSRP passe par la liste entrante', () => {
  it('TEMOIN : sans liste, R1 voit son pair en veille', async () => {
    expect(await pairHsrp([])).toBe('10.0.12.2');
  });

  it('`deny ip any any` fait perdre le pair — la panne que Cisco documente', async () => {
    expect(await pairHsrp([DENY_TOUT])).toBe('unknown');
  });

  it('`permit udp any any eq 1985` le retablit', async () => {
    expect(await pairHsrp(
      ['access-list 100 permit udp any any eq 1985', DENY_TOUT])).toBe('10.0.12.2');
  });
});

/**
 * GLBP apprend ses relayeurs par ses hellos : R1 declare le sien et
 * APPREND celui de R2. Un relayeur `(learnt)` est donc la preuve qu'un
 * paquet du pair est arrive, la ou `show glbp brief` reste identique
 * dans les trois cas et ne distingue rien.
 */
async function relayeursGlbp(acl: readonly string[]): Promise<number> {
  const r1 = await paireFhrp(acl, ['glbp 1 ip 10.0.12.252']);
  const vue = await r1.executeCommand('show glbp');
  return (vue.match(/\(learnt\)/g) ?? []).length;
}

/**
 * Un rapport IGMP est adresse au GROUPE — 239.1.1.1, c'est-a-dire du
 * multicast ROUTABLE — et non a 224.0.0.0/24. C'est ce cas qui a decide
 * de l'endroit ou poser la couture : `processIPv4` envoie une telle
 * destination a `forwardMulticast` et non a la remise locale, donc une
 * couture posee dans `handleLocalDelivery` l'aurait rendue
 * inatteignable. Mesure plutot que raisonnement.
 */
async function groupeVuParLeRouteur(acl: readonly string[]): Promise<boolean> {
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('P');
  new Cable('cm').connect(routeur.getPorts()[0], poste.getPorts()[0]);
  for (const commande of ['enable', 'configure terminal', 'ip multicast-routing',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'ip pim sparse-mode', 'ip igmp version 2', 'exit',
    ...acl,
    ...(acl.length ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
    'end']) {
    await routeur.executeCommand(commande);
  }
  await poste.executeCommand('sudo ip addr add 10.0.0.10/24 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');
  await poste.executeCommand('sudo ip route add default via 10.0.0.1');
  horloge.advance(5000);
  await poste.executeCommand('sudo ip maddr add 239.1.1.1 dev eth0');
  horloge.advance(5000);
  return (await routeur.executeCommand('show ip igmp groups')).includes('239.1.1.1');
}

describe('GLBP aussi — le relayeur APPRIS est la preuve du paquet recu', () => {
  it('TEMOIN : sans liste, R1 apprend le relayeur de R2', async () => {
    expect(await relayeursGlbp([])).toBe(1);
  });

  it('`deny ip any any` le laisse seul avec le sien', async () => {
    expect(await relayeursGlbp([DENY_TOUT])).toBe(0);
  });

  it('`permit udp any any eq 3222` le retablit', async () => {
    expect(await relayeursGlbp(
      ['access-list 100 permit udp any any eq 3222', DENY_TOUT])).toBe(1);
  });
});

describe('IGMP passe par la liste, et son groupe est ROUTABLE', () => {
  it('TEMOIN : sans liste, le routeur voit l\'abonnement a 239.1.1.1', async () => {
    expect(await groupeVuParLeRouteur([])).toBe(true);
  });

  it('`deny ip any any` le lui cache', async () => {
    expect(await groupeVuParLeRouteur([DENY_TOUT])).toBe(false);
  });

  it('`permit igmp any any` le retablit', async () => {
    expect(await groupeVuParLeRouteur(
      ['access-list 100 permit igmp any any', DENY_TOUT])).toBe(true);
  });
});

describe('VRRP aussi, et il s\'ecrit par son NUMERO de protocole', () => {
  it('TEMOIN : sans liste, R1 reste Backup derriere R2', async () => {
    expect(await etatVrrp([])).toBe('Backup');
  });

  it('`deny ip any any` le fait passer Master — les deux se croient seuls', async () => {
    expect(await etatVrrp([DENY_TOUT])).toBe('Master');
  });

  it('`permit 112 any any` le remet en Backup', async () => {
    expect(await etatVrrp(['access-list 100 permit 112 any any', DENY_TOUT])).toBe('Backup');
  });

  it('un mot-cle qui ne designe PAS le protocole 112 ne le sauve pas', async () => {
    expect(await etatVrrp(['access-list 100 permit ospf any any', DENY_TOUT])).toBe('Master');
  });
});
