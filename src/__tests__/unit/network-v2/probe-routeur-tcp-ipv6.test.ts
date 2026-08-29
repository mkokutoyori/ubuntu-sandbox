/**
 * Un routeur ouvre ET accepte une connexion TCP en IPv6
 * (BRD-Modele-TCP-IP.md phase 8, lot 4).
 *
 * ── Ce que la mesure a trouve : TROIS defauts empiles ───────────────
 *
 * **(1) Le routeur n'avait pas les crochets.** `TcpStack.resolveEgress6`
 * sort par son garde `if (!this.host.resolveRoute6 || !this.host.
 * localAddress6) return null;` AVANT meme de regarder l'adresse, et
 * l'objet `tcpHost` que `Router` construit ne declarait ni l'un ni
 * l'autre. Un routeur ne pouvait donc joindre AUCUNE destination IPv6 en
 * TCP — ni session BGP IPv6, ni SSH sortant vers une adresse v6 — et le
 * refus etait muet. C'est le jumeau IPv6 exact du defaut ferme pour IPv4
 * par « TCP originé par un routeur suit la table de routage », sur le
 * MEME objet ; `EndHost` declarait les deux depuis toujours.
 *
 * **(2) Le routeur ne LIVRAIT pas le TCP IPv6 recu.**
 * `IPv6DataPlane.handleLocalDelivery` aiguille OSPFv3, ICMPv6 et le DHCPv6
 * porte par UDP — et RIEN pour TCP, si bien qu'un segment adresse au
 * routeur etait jete en silence. Corriger le seul (1) ne suffisait donc
 * pas : la mesure montrait le pair ACCEPTER la connexion pendant que le
 * routeur restait en `syn-sent`, sa poignee de main morte au retour. Un
 * routeur ne pouvait pas davantage RECEVOIR une session TCP en IPv6 —
 * pas de serveur SSH en v6, pas de pair BGP v6 entrant. `TcpStack.
 * handleIp6` existait deja et n'avait aucun appelant cote routeur.
 *
 * **(3) Le demultiplexage TCP etait sensible a l'ORTHOGRAPHE, et ce
 * defaut-la n'a rien a voir avec le routeur.** `connect()` rangeait
 * l'adresse distante TELLE QUE L'APPELANT L'AVAIT ECRITE, tandis que
 * `handleSegment` recoit celle du paquet, normalisee par `IPv6Address`.
 * Les sockets etant indexes par une chaine, `connect('2001:DB8::2', …)`
 * n'a jamais retrouve la reponse venue de `2001:db8::2` : la connexion
 * restait en `syn-sent` pour une simple majuscule. Le cas entre deux
 * hotes Linux ci-dessous le montre sans routeur. IPv4 n'y etait pas
 * exposee, sa notation pointee etant deja canonique — c'est pourquoi le
 * defaut a pu vivre si longtemps. La regle du depot le corrige a sa
 * racine : on ANALYSE A LA FRONTIERE, donc `connect()` canonicalise ce
 * qu'on lui donne une fois pour toutes.
 *
 * ── Reutilisation, plutot qu'une seconde pile ───────────────────────
 *
 * Rien n'est ecrit ici qui n'existait deja : `IPv6DataPlane.lookupRoute`
 * est la recherche de route du plan d'acheminement, et `queueAndResolve`
 * l'envoi NDP-conscient qu'il emploie pour le transit — celui qui MET EN
 * FILE sur cache froid au lieu de lire le cache et d'esperer. Le premier
 * paquet d'une connexion arrive justement sur un cache froid, donc c'est
 * cette propriete-la qui compte. `resolvePath` est EXTRAIT de
 * `resolveEgress` plutot que recopie, si bien que la route qu'emprunte
 * une connexion TCP est celle qu'emprunte un paquet de transit.
 *
 * La SELECTION DE L'ADRESSE SOURCE etait deja ecrite DEUX fois — dans le
 * `tcpHost` d'`EndHost` et dans `IPv6DataPlane.resolveEgress` — avec la
 * meme regle. En ajouter une troisieme dans `Router` aurait ete la
 * duplication que ce depot traite comme un defaut ; elle descend donc
 * dans la couche internet et les TROIS appelants la lisent.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * La selection d'adresse source IPv6 est normalisee par la RFC 6724
 * (Standards Track, qui remplace la RFC 3484). La regle appliquee ici est
 * sa **regle 2, « Prefer appropriate scope »** : entre deux sources
 * candidates on prend celle dont la portee correspond a celle de la
 * destination. Ce que ce simulateur applique en est un sous-ensemble
 * assume — deux portees, lien-local et globale — et non les huit regles.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur cinq tombent contre l'etat d'avant. Le cinquieme est le
 * TEMOIN IPv4 monte dans le MEME laboratoire, et il passe des deux cotes
 * comme il le doit : sans lui, un laboratoire mal cable et une fonction
 * absente seraient indiscernables — c'est exactement le piege qui avait
 * fait passer pour un refus correct, la veille, ce qui n'etait qu'une
 * sortie jamais trouvee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routeurEtPoste() {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, poste.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal',
    'ipv6 unicast-routing', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'ipv6 address 2001:DB8::1/64', 'no shutdown', 'end']) {
    await routeur.executeCommand(c);
  }
  await poste.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await poste.executeCommand('sudo ip -6 addr add 2001:DB8::2/64 dev eth0');
  await poste.executeCommand('sudo ip link set eth0 up');
  return { routeur, poste };
}

describe('un routeur origine du TCP en IPv6', () => {
  it('la connexion vers un voisin IPv6 sur le lien ABOUTIT', async () => {
    const { routeur, poste } = await routeurEtPoste();
    let accepte = false;
    poste.getTcpStack().listen(9000, { onAccept: () => { accepte = true; } });

    const socket = routeur.getTcpStack().connect('2001:DB8::2', 9000);
    expect(socket).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(accepte).toBe(true);
    expect(socket!.state).toBe('established');
  });

  it('l\'adresse source est la GLOBALE du port, pas sa lien-local', async () => {
    const { routeur, poste } = await routeurEtPoste();
    poste.getTcpStack().listen(9001, { onAccept: () => undefined });
    const socket = routeur.getTcpStack().connect('2001:DB8::2', 9001);
    expect(socket).not.toBeNull();
    expect(socket!.localIp).toBe('2001:db8::1');
  });

  it('un vrai segment TCP traverse le fil en IPv6', async () => {
    const { routeur, poste } = await routeurEtPoste();
    const vus: string[] = [];
    poste.getPort('eth0')!.attachTap(({ direction, frame }) => {
      if (direction !== 'in') return;
      const pkt = frame.payload as { type?: string; nextHeader?: number } | undefined;
      if (pkt?.type === 'ipv6' && pkt.nextHeader === 6) vus.push('tcp6');
    });
    poste.getTcpStack().listen(9002, { onAccept: () => undefined });
    routeur.getTcpStack().connect('2001:DB8::2', 9002);
    await new Promise((r) => setTimeout(r, 60));
    expect(vus.length).toBeGreaterThan(0);
  });

  it('entre deux HOTES, une adresse ecrite en majuscules joint quand meme', async () => {
    const un = new LinuxPC('A');
    const deux = new LinuxPC('B');
    new Cable('c2').connect(un.getPort('eth0')!, deux.getPort('eth0')!);
    for (const [pc, addr] of [[un, '2001:DB8::10'], [deux, '2001:DB8::20']] as const) {
      await pc.executeCommand(`sudo ip -6 addr add ${addr}/64 dev eth0`);
      await pc.executeCommand('sudo ip link set eth0 up');
    }
    let accepte = false;
    deux.getTcpStack().listen(9100, { onAccept: () => { accepte = true; } });

    const socket = un.getTcpStack().connect('2001:DB8::20', 9100);
    expect(socket).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(accepte).toBe(true);
    expect(socket!.state).toBe('established');
  });

  it('TEMOIN : la meme maquette laisse deja passer le TCP en IPv4', async () => {
    const { routeur, poste } = await routeurEtPoste();
    let accepte = false;
    poste.getTcpStack().listen(9003, { onAccept: () => { accepte = true; } });
    const socket = routeur.getTcpStack().connect('10.0.0.2', 9003);
    expect(socket).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(accepte).toBe(true);
  });
});
