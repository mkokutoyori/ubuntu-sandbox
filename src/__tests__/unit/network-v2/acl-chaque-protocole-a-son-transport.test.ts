/**
 * Chaque protocole a SON transport, et la ligne qui le sauve n'est pas
 * la meme.
 *
 * ── Ce que ce fichier fixe ──────────────────────────────────────────
 *
 * Le fichier voisin (`acl-deny-ip-par-protocole`) montre qu'une liste
 * filtre les paquets IP et non « du trafic ». Celui-ci va au bout de la
 * consequence : quatre protocoles de service, quatre transports
 * differents, et permettre le mauvais ne sauve RIEN.
 *
 *   OSPF    protocole IP 89          `permit ospf any any`
 *   EIGRP   protocole IP 88          `permit eigrp any any`
 *   RIP     UDP 520                  `permit udp any any eq 520`
 *   BGP     TCP 179                  `permit tcp … eq 179`
 *   DHCP    UDP 67 et 68             `permit udp … eq 67` et `eq 68`
 *
 * Le piege qui donne son sens au fichier est le voisinage des NUMEROS :
 * EIGRP est 88 et OSPF 89, donc `permit ospf` — une faute de frappe
 * d'un chiffre — laisse l'adjacence EIGRP a terre, et le message
 * d'erreur n'existe pas puisque la commande est valide. Chaque cas
 * « mauvaise ligne » est donc epingle a cote de sa « bonne ligne »,
 * sans quoi un moteur qui ignorerait le champ protocole passerait la
 * moitie des cas.
 *
 * ── Ce que chaque cas OBSERVE, et pourquoi ce n'est pas la CLI ──────
 *
 * Un protocole de routage se juge sur ce qu'il a APPRIS, pas sur ce
 * qu'il a accepte de configurer : la route `R`/`D` dans la table, le
 * voisin EIGRP, l'etat `Established` de BGP, le bail DHCP reellement
 * pose sur l'interface du client. Une configuration acceptee ne
 * demontre rien — c'est justement le defaut que ce depot referme le
 * plus souvent.
 *
 * ── Une mesure qui a corrige une supposition ────────────────────────
 *
 * J'attendais que BGP exige `permit tcp any eq 179 any` — la reponse du
 * pair venant du port 179 — et que `permit tcp any any eq 179` seul ne
 * suffise pas. Les DEUX suffisent, mesure : les deux routeurs ouvrent
 * chacun leur session, donc l'une des deux traverse quelle que soit
 * celle des deux lignes qui est ecrite. C'est le vrai comportement de
 * BGP et non une facilite du simulateur ; le cas epingle les deux
 * formes plutot que la seule que j'avais prevue.
 *
 * ── Un protocole deliberement ABSENT, et pourquoi ───────────────────
 *
 * GRE n'est pas ici : son moteur d'encapsulation est reel mais n'est
 * cable que pour la commande Linux `ip tunnel`, et la CLI Cisco
 * `tunnel source`/`tunnel destination` ne remplit aucune table de
 * donnees — un cas GRE sur routeur Cisco ne mesurerait donc pas l'ACL
 * mais l'absence du tunnel. IPsec a son propre fichier
 * (`probe-liste-entrante-ne-juge-que-l-entrant`), le defaut qu'il a
 * revele depassant le cadre de la matrice.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `ACLEngine.evaluateForDataPlane` neutralise (rendant `permit` sans
 * lire la liste), 9 des 18 cas tombent. Les 9 autres sont exactement
 * ceux dont le verdict attendu EST « le trafic passe » — les quatre
 * TEMOINS sans liste, et les cinq cas ou la BONNE ligne retablit ce que
 * le `deny` avait coupe. Ils ne peuvent pas discriminer par
 * construction, et ils sont indispensables : sans eux, une maquette qui
 * ne convergerait jamais donnerait le meme « rien appris » que le
 * filtrage, et on croirait avoir demontre quelque chose.
 *
 * Note pour qui refera la mesure : le plan de donnees appelle
 * `evaluateForDataPlane` et non `evaluateACL`. Neutraliser la seconde
 * laisse les 18 cas verts et ne demontre rien.
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

/**
 * Deux routeurs sur 10.0.12.0/24, chacun portant une boucle qu'il
 * annonce a l'autre. La liste eprouvee est posee EN ENTREE sur R1
 * seulement : ce qui se voit alors est ce que R1 APPREND de R2.
 */
async function deuxRouteurs(acl: readonly string[], protocole: readonly string[]) {
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);

  for (const [routeur, n] of [[r1, '1'], [r2, '2']] as const) {
    const pair = n === '1' ? '2' : '1';
    for (const commande of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${n} 255.255.255.0`,
      'no shutdown', 'exit',
      'interface Loopback0', `ip address ${n}.${n}.${n}.${n} 255.255.255.0`, 'exit',
      ...(routeur === r1 ? acl : []),
      ...(routeur === r1 && acl.length
        ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
      ...protocole.map((c) => c.replace(/\$N/g, n).replace(/\$P/g, pair)),
      'end']) {
      await routeur.executeCommand(commande);
    }
  }
  horloge.advance(300000);
  return { r1, r2 };
}

const RIP = ['router rip', 'version 2', 'no auto-summary',
  'network 10.0.0.0', 'network $N.0.0.0', 'exit'];
const EIGRP = ['router eigrp 1', 'no auto-summary',
  'network 10.0.12.0 0.0.0.255', 'network $N.$N.$N.0 0.0.0.255', 'exit'];
const BGP = ['router bgp 6500$N', 'neighbor 10.0.12.$P remote-as 6500$P',
  'network $N.$N.$N.0 mask 255.255.255.0', 'exit'];

/** R1 a-t-il APPRIS le reseau de boucle de R2 ? */
async function apprisDeR2(acl: readonly string[], protocole: readonly string[],
                          code: string): Promise<boolean> {
  const { r1 } = await deuxRouteurs(acl, protocole);
  const table = await r1.executeCommand('show ip route');
  return new RegExp(`^${code}\\s+2\\.2\\.2\\.0/24`, 'm').test(table);
}

async function voisinEigrp(acl: readonly string[]): Promise<boolean> {
  const { r1 } = await deuxRouteurs(acl, EIGRP);
  return (await r1.executeCommand('show ip eigrp neighbors')).includes('10.0.12.2');
}

async function sessionBgp(acl: readonly string[]): Promise<string> {
  const { r1 } = await deuxRouteurs(acl, BGP);
  const vue = await r1.executeCommand('show ip bgp summary');
  return vue.match(/Established|Active|Connect|Idle/)?.[0] ?? 'absent';
}

/** Le client obtient-il un bail, c'est-a-dire une adresse REELLE sur eth0 ? */
async function bailDhcp(acl: readonly string[]): Promise<boolean> {
  const routeur = new CiscoRouter('R');
  const client = new LinuxPC('P');
  new Cable('cd').connect(routeur.getPorts()[0], client.getPorts()[0]);
  for (const commande of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.5.1 255.255.255.0',
    'no shutdown', 'exit',
    ...acl,
    ...(acl.length ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
    'ip dhcp pool LAN', 'network 192.168.5.0 255.255.255.0',
    'default-router 192.168.5.1', 'exit', 'end']) {
    await routeur.executeCommand(commande);
  }
  await client.executeCommand('sudo ip link set eth0 up');
  await client.executeCommand('sudo dhclient eth0');
  return (await client.executeCommand('ip -4 addr show eth0')).includes('inet 192.168.5.');
}

describe('OSPF et EIGRP roulent sur IP, chacun sous SON numero', () => {
  it('TEMOIN : sans liste, EIGRP forme son voisinage', async () => {
    expect(await voisinEigrp([])).toBe(true);
  });

  it('`deny ip any any` fait tomber le voisin EIGRP', async () => {
    expect(await voisinEigrp([DENY_TOUT])).toBe(false);
  });

  it('`permit eigrp any any` le retablit', async () => {
    expect(await voisinEigrp(['access-list 100 permit eigrp any any', DENY_TOUT])).toBe(true);
  });

  it('`permit ospf any any` ne le sauve PAS — 89 n\'est pas 88', async () => {
    expect(await voisinEigrp(['access-list 100 permit ospf any any', DENY_TOUT])).toBe(false);
  });

  it('et la route EIGRP suit le voisinage', async () => {
    expect(await apprisDeR2([], EIGRP, 'D')).toBe(true);
    expect(await apprisDeR2([DENY_TOUT], EIGRP, 'D')).toBe(false);
  });
});

describe('RIP roule sur UDP 520, pas sur un numero de protocole', () => {
  it('TEMOIN : sans liste, R1 apprend la route RIP', async () => {
    expect(await apprisDeR2([], RIP, 'R')).toBe(true);
  });

  it('`deny ip any any` la fait disparaitre', async () => {
    expect(await apprisDeR2([DENY_TOUT], RIP, 'R')).toBe(false);
  });

  it('`permit udp any any eq 520` la retablit', async () => {
    expect(await apprisDeR2(
      ['access-list 100 permit udp any any eq 520', DENY_TOUT], RIP, 'R')).toBe(true);
  });

  it('`permit ospf any any` ne sauve pas RIP — ce n\'est pas le meme transport', async () => {
    expect(await apprisDeR2(
      ['access-list 100 permit ospf any any', DENY_TOUT], RIP, 'R')).toBe(false);
  });
});

describe('BGP roule sur TCP 179', () => {
  it('TEMOIN : sans liste, la session est Established', async () => {
    expect(await sessionBgp([])).toBe('Established');
  });

  it('`deny ip any any` la laisse Idle', async () => {
    expect(await sessionBgp([DENY_TOUT])).toBe('Idle');
  });

  it('le port de DESTINATION 179 suffit', async () => {
    expect(await sessionBgp(
      ['access-list 100 permit tcp any any eq 179', DENY_TOUT])).toBe('Established');
  });

  it('le port SOURCE 179 suffit aussi — les deux pairs ouvrent leur session', async () => {
    expect(await sessionBgp(
      ['access-list 100 permit tcp any eq 179 any', DENY_TOUT])).toBe('Established');
  });

  it('refuser les deux formes la laisse Idle', async () => {
    expect(await sessionBgp([
      'access-list 100 deny tcp any any eq 179',
      'access-list 100 deny tcp any eq 179 any',
      'access-list 100 permit ip any any',
    ])).toBe('Idle');
  });

  it('`permit ospf any any` ne sauve pas BGP', async () => {
    expect(await sessionBgp(
      ['access-list 100 permit ospf any any', DENY_TOUT])).toBe('Idle');
  });
});

describe('DHCP roule sur UDP 67 et 68', () => {
  it('TEMOIN : sans liste, le client obtient une adresse', async () => {
    expect(await bailDhcp([])).toBe(true);
  });

  it('`deny ip any any` le laisse sans adresse', async () => {
    expect(await bailDhcp([DENY_TOUT])).toBe(false);
  });

  it('permettre les deux ports du BOOTP le retablit', async () => {
    expect(await bailDhcp([
      'access-list 100 permit udp any any eq 67',
      'access-list 100 permit udp any any eq 68',
      DENY_TOUT,
    ])).toBe(true);
  });
});
