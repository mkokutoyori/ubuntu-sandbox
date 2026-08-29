/**
 * Une liste ENTRANTE ne juge que ce qui ENTRE.
 *
 * ── Ce que la mesure a trouve, et comment ───────────────────────────
 *
 * En eprouvant l'ACL protocole par protocole, le cas IPsec ne se
 * comportait pas : avec `permit udp any any eq 500` + `permit esp any
 * any` — c'est-a-dire exactement ce qu'un cours enseigne d'ecrire sur
 * l'interface exterieure d'un tunnel — l'association IKE montait
 * (QM_IDLE) et le ping restait a 100 % de perte. Les compteurs de
 * `show access-lists` disaient le reste : `permit esp` comptait QUATRE
 * correspondances alors que DEUX paquets ESP seulement etaient arrives,
 * et `deny ip any any` en comptait DEUX qu'aucun paquet entrant
 * n'expliquait.
 *
 * Deux defauts distincts, chacun etabli par une mesure DECISIVE plutot
 * que par l'arithmetique des compteurs.
 *
 * **(1) La liste entrante jugeait les paquets que le routeur EMET.**
 * `Router.forwardPacket` chiffre, puis rend le paquet chiffre a
 * `processIPv4(route.iface, p)` — la porte d'ARRIVEE — donc la liste
 * `ip access-group N in` de l'interface de SORTIE examinait un paquet
 * que le routeur etait en train de transmettre. La mesure qui tranche :
 * `deny esp host <adresse de R1 lui-meme> any` tuait le tunnel de R1,
 * et zero ESP quittait l'interface ; le TEMOIN, la meme regle sur une
 * adresse source etrangere, laissait tout passer. Une liste entrante
 * refusant a une machine d'emettre ses propres paquets est fausse sur
 * n'importe quelle version d'IOS.
 *
 * **(2) Le paquet DECHIFFRE etait rejuge par la meme liste entrante.**
 * `processIPv4(inPort, inner)` apres decapsulation ESP/AH/GRE fait
 * repasser le contenu en clair par la liste qui venait de voir
 * l'enveloppe. Mesure qui tranche : ajouter `permit ip 192.168.2.0
 * 0.0.0.255 192.168.1.0 0.0.0.255` — le trafic INTERIEUR du tunnel —
 * faisait passer le ping, et cette ligne prenait exactement les deux
 * correspondances manquantes.
 *
 * ── L'autorite, et pourquoi (2) est date ────────────────────────────
 *
 * Ce second comportement a EXISTE : avant Cisco IOS 12.3(8)T il y avait
 * bien un double controle sur les paquets entrants, une fois sur le
 * paquet chiffre puis une seconde fois sur le paquet en clair qui vient
 * d'etre dechiffre. La fonction « Crypto Access Check on Clear-Text
 * Packets » l'a RETIRE : depuis 12.3(8)T les paquets en clair qui
 * traversent le tunnel ne sont plus controles contre la liste de
 * l'interface physique exterieure, et l'operateur qui veut les filtrer
 * declare une liste sous la crypto map. Ce simulateur rend un IOS 15 :
 * il portait donc le comportement d'avant 12.3(8)T.
 *
 * La consequence n'etait pas cosmetique : un operateur suivant la
 * pratique moderne ecrit `permit udp … eq 500` et `permit esp`, et son
 * tunnel monte sans rien transporter. Le diagnostic qu'il en tire —
 * « la liste est bonne, c'est donc la configuration crypto » — l'envoie
 * chercher au mauvais endroit.
 *
 * ── Pourquoi le premier correctif n'a rien change ───────────────────
 *
 * `processIPv4` est ecrite TROIS fois : la base, et une redefinition
 * chez `CiscoRouter` comme chez `HuaweiRouter`, chacune avec sa propre
 * repartition par protocole et sa propre re-entree apres decapsulation
 * GRE. Ajouter le parametre a la base seule n'a produit AUCUN
 * changement mesurable, les deux redefinitions le laissant tomber en
 * appelant `super`. TypeScript ne pouvait pas le dire : une
 * redefinition qui prend MOINS de parametres reste assignable. C'est la
 * duplication qui a cache le correctif, pas le correctif qui etait
 * faux.
 *
 * ── Ce qui n'est deliberement PAS fait ──────────────────────────────
 *
 * L'autre moitie de la fonction 12.3(8)T — le controle du paquet en
 * clair AVANT chiffrement contre la liste SORTANTE, et le controle du
 * paquet CHIFFRE a sa place — n'est pas traitee : le chiffrement se
 * fait dans `forwardPacket` APRES la liste sortante, donc l'inverser
 * deplace le chiffrement dans le pipeline plutot que d'ajouter une
 * garde. Inscrit au `TODO.md`. Les listes declarees SOUS la crypto map
 * (`set ip access-group`), qui sont la maniere moderne de filtrer le
 * clair, n'existent pas davantage.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Le parametre retire des trois ecritures, 3 des 7 cas tombent —
 * j'en avais annonce 4 avant de mesurer, et c'est la mesure qui a
 * raison. Les 4 TEMOINS sont nommes ici plutot que laisses a
 * decouvrir, chacun avec sa raison de passer des deux cotes :
 *
 *   sans aucune liste            le tunnel doit transporter, c'est le
 *                                temoin qui prouve la maquette ;
 *   `deny esp` source etrangere  la regle ne vise aucun paquet reel,
 *                                donc rien ne doit changer ;
 *   `deny ip any any`            l'ENVELOPPE entre vraiment, donc elle
 *                                doit rester refusee — ce cas garde
 *                                qu'on n'a pas rendu la liste
 *                                permissive ;
 *   `permit esp` SEUL            echoue avant comme apres, mais pour la
 *                                BONNE raison des deux cotes : sans
 *                                `permit udp eq 500` l'IKE n'aboutit
 *                                pas, donc il n'y a pas de tunnel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const R1_EXTERIEUR = '203.0.113.1';
const R2_EXTERIEUR = '203.0.113.2';

async function cote(
  r: CiscoRouter, exterieur: string, interieur: string, pair: string,
  local: string, distant: string, acl: readonly string[],
) {
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${exterieur} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${interieur} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256',
    'authentication pre-share', 'group 14', 'lifetime 86400', 'exit',
    `crypto isakmp key SECRET address ${pair}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL',
    `permit ip ${local} 0.0.0.255 ${distant} 0.0.0.255`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp', `set peer ${pair}`, 'set transform-set TSET',
    'match address VPN_ACL', 'exit',
    ...acl,
    'interface GigabitEthernet0/1', 'crypto map CMAP',
    ...(acl.length ? ['ip access-group 100 in'] : []), 'exit',
    `ip route ${distant} 255.255.255.0 ${pair}`, 'end']) {
    await r.executeCommand(c);
  }
}

/**
 * Deux sites derriere deux routeurs, un tunnel entre eux, et la liste
 * eprouvee posee EN ENTREE sur l'interface exterieure de R1 seulement —
 * c'est la que la question se pose.
 */
async function tunnel(acl: readonly string[]) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const p1 = new LinuxPC('P1');
  const p2 = new LinuxPC('P2');
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('l1').connect(r1.getPort('GigabitEthernet0/0')!, p1.getPorts()[0]);
  new Cable('l2').connect(r2.getPort('GigabitEthernet0/0')!, p2.getPorts()[0]);

  await cote(r1, R1_EXTERIEUR, '192.168.1.1', R2_EXTERIEUR, '192.168.1.0', '192.168.2.0', acl);
  await cote(r2, R2_EXTERIEUR, '192.168.2.1', R1_EXTERIEUR, '192.168.2.0', '192.168.1.0', []);
  for (const [p, n] of [[p1, '1'], [p2, '2']] as const) {
    await p.executeCommand(`sudo ip addr add 192.168.${n}.10/24 dev eth0`);
    await p.executeCommand('sudo ip link set eth0 up');
    await p.executeCommand(`sudo ip route add default via 192.168.${n}.1`);
  }
  return { r1, p1 };
}

async function traverse(acl: readonly string[]): Promise<boolean> {
  const { p1 } = await tunnel(acl);
  const sortie = await pingOnSimulatedClock(p1, 'ping -c 2 192.168.2.10');
  return sortie.includes(', 0% packet loss');
}

const PERMET_LE_TUNNEL = [
  'access-list 100 permit udp any any eq 500',
  'access-list 100 permit esp any any',
  'access-list 100 deny ip any any',
];

describe('une liste entrante ne juge pas ce que le routeur EMET', () => {
  it('refuser l\'ESP dont la source est le routeur LUI-MEME ne l\'empeche pas d\'emettre', async () => {
    expect(await traverse([
      `access-list 100 deny esp host ${R1_EXTERIEUR} any`,
      'access-list 100 permit ip any any',
    ])).toBe(true);
  });

  it('TEMOIN : la meme regle sur une source etrangere ne gene rien non plus', async () => {
    expect(await traverse([
      'access-list 100 deny esp host 198.51.100.9 any',
      'access-list 100 permit ip any any',
    ])).toBe(true);
  });
});

describe('une liste entrante ne rejuge pas le contenu DECHIFFRE', () => {
  it('permettre l\'ISAKMP et l\'ESP suffit a faire passer le trafic du tunnel', async () => {
    expect(await traverse(PERMET_LE_TUNNEL)).toBe(true);
  });

  it('et il n\'est plus besoin de permettre le trafic INTERIEUR', async () => {
    const avec = [
      'access-list 100 permit udp any any eq 500',
      'access-list 100 permit esp any any',
      'access-list 100 permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255',
      'access-list 100 deny ip any any',
    ];
    expect(await traverse(avec)).toBe(true);
    expect(await traverse(PERMET_LE_TUNNEL)).toBe(true);
  });

  it('TEMOIN : sans aucune liste, le tunnel transporte', async () => {
    expect(await traverse([])).toBe(true);
  });
});

describe('la liste entrante garde toujours ce qui ENTRE vraiment', () => {
  it('`deny ip any any` coupe le tunnel — l\'enveloppe est du trafic IP', async () => {
    expect(await traverse(['access-list 100 deny ip any any'])).toBe(false);
  });

  it('TEMOIN : `permit esp` SEUL ne suffit pas, l\'IKE n\'aboutit pas', async () => {
    const { r1, p1 } = await tunnel([
      'access-list 100 permit esp any any',
      'access-list 100 deny ip any any',
    ]);
    const sortie = await pingOnSimulatedClock(p1, 'ping -c 2 192.168.2.10');
    expect(sortie).toContain(', 100% packet loss');
    expect(await r1.executeCommand('show crypto isakmp sa')).not.toContain('QM_IDLE');
  });
});
