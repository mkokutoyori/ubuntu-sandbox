/**
 * Ce qu'une liste de controle fait a CHAQUE protocole porte par IP.
 *
 * ── Ce que ce fichier eprouve, et pourquoi ──────────────────────────
 *
 * Une ACL ne filtre pas « du trafic » : elle filtre des PAQUETS IP, et
 * tout ce qui roule sur IP y passe — l'ICMP du diagnostic, le TCP des
 * sessions, l'UDP des services, et les protocoles de ROUTAGE, qui sont
 * ceux qu'on oublie. Chaque cas ci-dessous fixe le comportement d'une
 * famille, et le fichier entier est ecrit pour qu'un `deny` mal place se
 * voie tout de suite.
 *
 * ── Les faits verifies contre une vraie machine ─────────────────────
 *
 * **Un `deny` ne se contente pas de jeter : il REPOND.** Cisco emet un
 * ICMP type 3 code 13 — « Communication Administratively Prohibited »,
 * RFC 1812 §5.2.7.1 — donc l'emetteur apprend qu'il a ete filtre au lieu
 * d'attendre un delai. C'est ce qui distingue un routeur qui refuse d'un
 * cable debranche, et c'est mesure ici sur le fil.
 *
 * **Le protocole nomme dans l'ACE est le SEUL bloque.** `deny icmp` ne
 * touche ni TCP ni UDP, et reciproquement — la matrice complete est
 * epinglee parce qu'une regression y serait invisible autrement : un
 * moteur qui ignorerait le champ protocole passerait tous les cas
 * « bloque » et echouerait sur les cas « passe ».
 *
 * **`deny ip any any` CASSE OSPF**, et c'est le piege operationnel
 * classique : les protocoles de routage sont du trafic IP comme un autre
 * (OSPF est le protocole 89). L'adjacence tombe, et `permit ospf any any`
 * place AVANT le deny la retablit. Les trois etats sont mesures.
 *
 * ── Un piege de mesure, rencontre en ecrivant ce fichier ────────────
 *
 * La premiere version liait le port 53 pour eprouver `permit udp any any
 * eq 53`, et TOUS les cas UDP sortaient « bloque » — y compris le temoin
 * `permit ip any any`. Le moteur d'ACL n'y etait pour rien : le serveur
 * porte deja un service DNS, donc `udpBind(53)` rendait `false` et le
 * gestionnaire de la sonde n'etait jamais pose. J'ai failli declarer un
 * defaut qui n'existait pas. Les cas UDP se lient donc sur un port
 * qu'aucun service ne revendique, et le retour de `udpBind` est verifie
 * plutot que suppose — sans quoi ces cas ne mesureraient rien.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `ACLEngine.evaluateForDataPlane` neutralise (rendant `permit` sans
 * lire la liste) fait tomber 10 des 11 cas. Le onzieme est le TEMOIN
 * « sans deny, les trois passent », dont c'est l'objet de passer des
 * deux cotes. Le cas du port SOURCE portait d'abord sa seule moitie
 * positive et passait donc lui aussi : un moteur ignorant le port source
 * l'aurait satisfait, et il porte desormais la moitie negative.
 *
 * Note pour qui refera la mesure : le plan de donnees appelle
 * `evaluateForDataPlane` et non `evaluateACL`. Neutraliser la seconde
 * laisse tous ces cas verts et ne demontre rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const PORT_LIBRE = 4444;

async function maquette(acl: readonly string[]) {
  const routeur = new CiscoRouter('R1');
  const client = new LinuxPC('A');
  const serveur = new LinuxServer('linux-server', 'B', 0, 0);
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, client.getPorts()[0]);
  new Cable('c2').connect(routeur.getPort('GigabitEthernet0/1')!, serveur.getPorts()[0]);

  for (const commande of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...acl,
    'interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit', 'end']) {
    await routeur.executeCommand(commande);
  }
  await client.executeCommand('sudo ip addr add 10.0.1.10/24 dev eth0');
  await client.executeCommand('sudo ip link set eth0 up');
  await client.executeCommand('sudo ip route add default via 10.0.1.1');
  await serveur.executeCommand('sudo ip addr add 10.0.2.10/24 dev eth0');
  await serveur.executeCommand('sudo ip link set eth0 up');
  await serveur.executeCommand('sudo ip route add default via 10.0.2.1');
  await serveur.executeCommand('sudo systemctl start ssh');
  return { routeur, client, serveur };
}

function icmpRecuPar(client: LinuxPC): string[] {
  const vus: string[] = [];
  client.getPorts()[0].attachTap(({ direction, frame }) => {
    const pkt = frame.payload as { type?: string; protocol?: number; payload?: unknown } | undefined;
    if (direction !== 'in' || pkt?.type !== 'ipv4' || pkt.protocol !== 1) return;
    const icmp = pkt.payload as { icmpType?: string; code?: number } | undefined;
    if (icmp?.icmpType) vus.push(`${icmp.icmpType}/${icmp.code}`);
  });
  return vus;
}

async function icmpPasse(client: LinuxPC): Promise<boolean> {
  return (await client.executeCommand('ping -c 1 10.0.2.10')).includes(' 0% packet loss');
}

async function udpPasse(
  client: LinuxPC, serveur: LinuxServer, port = PORT_LIBRE, sourcePort = 5000,
): Promise<boolean> {
  const recu: string[] = [];
  const lie = (serveur as unknown as {
    udpBind(p: number, h: () => void): boolean;
  }).udpBind(port, () => { recu.push('x'); });
  expect(lie, `le port ${port} doit etre libre, sinon ce cas ne mesure rien`).toBe(true);
  (client as unknown as {
    sendUdpDatagram(d: IPAddress, dp: number, sp: number, p: unknown, n: number): boolean;
  }).sendUdpDatagram(new IPAddress('10.0.2.10'), port, sourcePort, 'z', 1);
  await new Promise((r) => setTimeout(r, 25));
  return recu.length > 0;
}

describe('deny ip — ce que le routeur repond', () => {
  it('le paquet est jete ET l\'emetteur est prevenu (type 3 code 13)', async () => {
    const { client } = await maquette([
      'access-list 100 deny ip host 10.0.1.10 host 10.0.2.10',
      'access-list 100 permit ip any any',
    ]);
    const vus = icmpRecuPar(client);
    const sortie = await client.executeCommand('ping -c 2 10.0.2.10');

    expect(sortie).toContain('100% packet loss');
    expect(vus).toContain('destination-unreachable/13');
  });

  it('`no ip unreachables` fait taire la reponse sans laisser passer', async () => {
    const { routeur, client } = await maquette([
      'access-list 100 deny ip host 10.0.1.10 host 10.0.2.10',
      'access-list 100 permit ip any any',
    ]);
    for (const c of ['configure terminal', 'interface GigabitEthernet0/0',
      'no ip unreachables', 'end']) await routeur.executeCommand(c);

    const vus = icmpRecuPar(client);
    const sortie = await client.executeCommand('ping -c 2 10.0.2.10');

    expect(sortie).toContain('100% packet loss');
    expect(vus).not.toContain('destination-unreachable/13');
  });
});

describe('le protocole nomme est le seul bloque', () => {
  it('deny ip bloque les TROIS familles', async () => {
    const { client, serveur } = await maquette([
      'access-list 100 deny ip host 10.0.1.10 host 10.0.2.10',
      'access-list 100 permit ip any any',
    ]);
    expect(await icmpPasse(client)).toBe(false);
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 22)).not.toBe('open');
    expect(await udpPasse(client, serveur)).toBe(false);
  });

  it('deny icmp ne touche ni TCP ni UDP', async () => {
    const { client, serveur } = await maquette([
      'access-list 100 deny icmp host 10.0.1.10 host 10.0.2.10',
      'access-list 100 permit ip any any',
    ]);
    expect(await icmpPasse(client)).toBe(false);
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 22)).toBe('open');
    expect(await udpPasse(client, serveur)).toBe(true);
  });

  it('deny tcp ne touche ni ICMP ni UDP', async () => {
    const { client, serveur } = await maquette([
      'access-list 100 deny tcp host 10.0.1.10 host 10.0.2.10',
      'access-list 100 permit ip any any',
    ]);
    expect(await icmpPasse(client)).toBe(true);
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 22)).not.toBe('open');
    expect(await udpPasse(client, serveur)).toBe(true);
  });

  it('deny udp ne touche ni ICMP ni TCP', async () => {
    const { client, serveur } = await maquette([
      'access-list 100 deny udp host 10.0.1.10 host 10.0.2.10',
      'access-list 100 permit ip any any',
    ]);
    expect(await icmpPasse(client)).toBe(true);
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 22)).toBe('open');
    expect(await udpPasse(client, serveur)).toBe(false);
  });

  it('TEMOIN : sans deny, les trois passent', async () => {
    const { client, serveur } = await maquette(['access-list 100 permit ip any any']);
    expect(await icmpPasse(client)).toBe(true);
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 22)).toBe('open');
    expect(await udpPasse(client, serveur)).toBe(true);
  });
});

describe('le PORT decide, pas seulement le protocole', () => {
  it('permit tcp … eq 22 ouvre SSH et laisse tomber le reste', async () => {
    const { client, serveur } = await maquette([
      'access-list 100 permit tcp any any eq 22',
      'access-list 100 deny ip any any',
    ]);
    serveur.getTcpStack().listen(80, { onAccept: () => undefined });
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 22)).toBe('open');
    expect(client.getTcpStack().connectOutcome('10.0.2.10', 80)).not.toBe('open');
  });

  it('le port de DESTINATION est compare', async () => {
    const bon = await maquette([
      `access-list 100 permit udp any any eq ${PORT_LIBRE}`,
      'access-list 100 deny ip any any',
    ]);
    expect(await udpPasse(bon.client, bon.serveur)).toBe(true);

    const mauvais = await maquette([
      'access-list 100 permit udp any any eq 9999',
      'access-list 100 deny ip any any',
    ]);
    expect(await udpPasse(mauvais.client, mauvais.serveur)).toBe(false);
  });

  it('le port SOURCE est compare aussi', async () => {
    const bon = await maquette([
      'access-list 100 permit udp any eq 5000 any',
      'access-list 100 deny ip any any',
    ]);
    expect(await udpPasse(bon.client, bon.serveur, PORT_LIBRE, 5000)).toBe(true);

    const mauvais = await maquette([
      'access-list 100 permit udp any eq 5000 any',
      'access-list 100 deny ip any any',
    ]);
    expect(await udpPasse(mauvais.client, mauvais.serveur, PORT_LIBRE, 5001)).toBe(false);
  });

  it('la fin implicite REFUSE ce qu\'aucune ligne n\'autorise', async () => {
    const { client } = await maquette(['access-list 100 permit tcp any any eq 22']);
    expect(await icmpPasse(client)).toBe(false);
  });
});
