/**
 * Une reponse d'echo renvoie la route — RFC 1122 §3.2.2.6, et les deux
 * forces y sont DIFFERENTES, ce qui est tout l'objet de ce fichier.
 *
 *   Record Route / Timestamp : « SHOULD be updated to include the
 *   current host and included in the IP header of the Echo Reply
 *   message, without "truncation". Thus, the recorded route will be
 *   for the entire round trip. »
 *
 *   Source route : « the return route MUST be reversed and used as a
 *   Source Route option for the Echo Reply message. »
 *
 * MESURE DE DEPART, et les deux equipements mesures se contredisaient :
 *
 *   hote (`EndHost`)  -> ihl 5, AUCUNE option
 *   pare-feu          -> ihl 9, [12, 10.0.1.1, 10.0.2.1, 0,0,0,0]
 *
 * L'hote JETAIT l'option : une route enregistree arrivait complete chez
 * la cible et ne revenait jamais, donc l'operateur qui demande la route
 * recevait une reponse vide. Le pare-feu la RECOPIAIT telle quelle,
 * pointeur compris, sans y mettre sa propre adresse — sa reponse
 * affirmait un trajet qu'elle n'avait pas fait. Deux reponses fausses,
 * differemment, a la meme question : le §3 dans sa forme nue.
 *
 * POURQUOI LES DEUX DIVERGEAIENT. Le fait « batir la reponse a partir de
 * la requete » etait ecrit QUATRE fois — `EndHost`, `Router`,
 * `SwitchSvi`, `FirewallEgress` — et les quatre avaient deja diverge sur
 * autre chose que les options — le bit DF, et de TROIS manieres :
 *
 *   `EndHost`        le recopiait EXPRES, commentaire a l'appui (« an
 *                    echo request that made it here unfragmented took a
 *                    path whose MTU allows that size [...] rather than
 *                    picking up this stack's DF-by-default and
 *                    bouncing »)
 *   `FirewallEgress` le recopiait PAR ACCIDENT, par l'etalement
 *                    `{ ...packet }` qui emporte tous les champs
 *   `Router`         le FORCAIT a 1, sans le vouloir : `createIPv4Packet`
 *   `SwitchSvi`      pose DF par DEFAUT, et ni l'un ni l'autre ne passait
 *                    de drapeau
 *
 * Un fait ecrit quatre fois, trois comportements, dont deux que personne
 * n'avait choisis. C'est la prediction du §2 verifiee sur piece, et le
 * defaut du routeur est precisement celui que le commentaire d'`EndHost`
 * decrivait par avance. `buildEchoReply` est desormais l'unique
 * implantation, et elle garde la MEILLEURE des quatre lectures, pas la
 * plus repandue.
 *
 * UN DEFAUT QUE LE LOT PRECEDENT AVAIT REND ATTEIGNABLE. `FirewallEgress
 * .icmpEchoReply` derivait sa reponse en etalant la requete
 * (`{ ...packet }`). Tant que `IPv4Packet` n'avait pas de champ
 * `options`, cet etalement ne transportait rien ; depuis qu'il en a un,
 * il transportait l'option VERBATIM — y compris une source route non
 * inversee, dont le pointeur designe le trajet ALLER. Ajouter un champ a
 * une structure etalee ailleurs reveille les etalements : celui-la est
 * ferme ici.
 *
 * L'EMISSION AUSSI. Les trois emetteurs routaient la reponse d'apres la
 * SOURCE DE LA REQUETE. Sans inversion c'est la meme adresse et personne
 * ne pouvait le voir ; avec, la reponse doit partir vers le PREMIER SAUT
 * de la route inverse. Les trois lisent maintenant
 * `replyIP.destinationIP`, ce qui est un remplacement sans effet dans le
 * cas ordinaire et le seul correct dans l'autre.
 *
 * DISCRIMINATION (`git stash push -- src/network`) : 4 des 7 cas
 * tombent. Les TROIS autres passent des deux cotes et sont nommes, parce
 * qu'un cas qui ne discrimine pas doit dire pourquoi il est la :
 *
 *   - le ping ordinaire aller-retour est le TEMOIN du laboratoire ; sans
 *     lui, une maquette ou aucune reponse ne revient rendrait les quatre
 *     refus verts sans rien prouver ;
 *   - le DF d'une requete qui le PORTE est un TEMOIN DE NON-REGRESSION :
 *     il passait avant — par accident chez le pare-feu, par defaut chez
 *     le routeur — et il doit passer apres, par decision ;
 *   - l'en-tete de 20 octets sur une requete sans option est le TEMOIN
 *     qu'on n'a pas mis d'option la ou il n'en faut pas.
 *
 * La premiere ecriture de ce fichier annoncait 5 cas sur 6 et se
 * trompait DEUX FOIS sur le meme cas. D'abord le DF etait mesure sur le
 * pare-feu, qui le recopiait deja par etalement ; deplace sur le
 * routeur, il ne discriminait toujours pas, parce que le routeur ne
 * PERD pas le bit — `createIPv4Packet` le pose par defaut, donc une
 * requete qui porte DF recevait une reponse qui le porte aussi, pour la
 * mauvaise raison. Le seul cas qui distingue est la requete SANS DF, et
 * c'est celui qui est ecrit.
 *
 * CE QUI N'EST PAS FAIT. Le Timestamp, que la meme phrase de la RFC 1122
 * nomme a cote du Record Route, n'est pas reflechi : il n'est ni
 * construit ni horodate ailleurs dans ce simulateur, pour la raison
 * mesuree qui est dans `TODO.md` — le RTT vaut 0 ms en temps virtuel.
 * Reflechir une option que personne ne remplit n'aurait rien ajoute.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4, createIPv4Packet,
  verifyIPv4Checksum, IP_PROTO_ICMP,
  IP_OPTION_RECORD_ROUTE, IP_OPTION_LOOSE_SOURCE_ROUTE,
  type EthernetFrame, type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '@/network/core/types';
import {
  buildRecordRouteOption, buildSourceRouteOption, routeAddressesOf,
} from '@/network/layers/internet/Ipv4Options';
import { IPV4_FLAG_DF } from '@/network/core/Ipv4Fragmentation';
import { icmpEchoReply } from '@/network/devices/firewall/l3/FirewallEgress';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function type(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

function watchIpv4(port: { receiveFrame(f: EthernetFrame): unknown }): () => IPv4Packet[] {
  const seen: IPv4Packet[] = [];
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) seen.push(f.payload as IPv4Packet);
    return original(f);
  };
  return () => seen;
}

async function lab() {
  const r1 = new CiscoRouter('R1');
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);

  new Cable('a-r1').connect(a.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('r1-b').connect(r1.getPort('GigabitEthernet0/1')!, b.getPort('eth0')!);

  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
  await type(a, ['ip link set eth0 up', 'ip addr add 10.0.0.10/24 dev eth0',
    'ip route add default via 10.0.0.1']);
  await type(b, ['ip link set eth0 up', 'ip addr add 10.0.1.10/24 dev eth0',
    'ip route add default via 10.0.1.1']);

  await a.executeCommand('ping -c 1 10.0.1.10');
  return { r1, a, b };
}

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 7, sequence: 1, dataSize: 8,
};

function inject(
  r1: CiscoRouter, a: LinuxPC, destination: string, ipOptions: IPv4Option[], flags = 0,
): void {
  const packet = createIPv4Packet(
    new IPAddress('10.0.0.10'), new IPAddress(destination),
    IP_PROTO_ICMP, 64, ECHO, 16, { ipOptions, flags });
  r1.getPort('GigabitEthernet0/0')!.receiveFrame({
    srcMAC: a.getPort('eth0')!.getMAC(),
    dstMAC: r1.getPort('GigabitEthernet0/0')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });
}

function optionOf(packet: IPv4Packet, optionType: number): IPv4Option | undefined {
  return packet.options?.find(o => o.type === optionType);
}

function repliesAt(seen: () => IPv4Packet[]): IPv4Packet[] {
  return seen().filter(p => (p.payload as ICMPPacket)?.icmpType === 'echo-reply');
}

describe('the recorded route comes back, for the entire round trip', () => {
  it('a plain echo request is answered — WITNESS', async () => {
    const { r1, a } = await lab();
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(r1, a, '10.0.1.10', []);

    const replies = repliesAt(atA);
    expect(replies).toHaveLength(1);
    expect(replies[0].sourceIP.toString()).toBe('10.0.1.10');
    expect(verifyIPv4Checksum(replies[0])).toBe(true);
  });

  it('the reply carries the outbound hops, the responder and the return hops', async () => {
    const { r1, a } = await lab();
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(r1, a, '10.0.1.10', [buildRecordRouteOption(4)]);

    const replies = repliesAt(atA);
    expect(replies).toHaveLength(1);
    const option = optionOf(replies[0], IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString()))
      .toEqual(['10.0.1.1', '10.0.1.10', '10.0.0.1']);
    expect(verifyIPv4Checksum(replies[0])).toBe(true);
  });
});

describe('the return route is reversed, as the RFC requires', () => {
  it('a source-routed request is answered along the reversed path', async () => {
    const { r1, a } = await lab();
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(r1, a, '10.0.0.1',
      [buildSourceRouteOption([new IPAddress('10.0.1.10')], false)]);

    const replies = repliesAt(atA);
    expect(replies).toHaveLength(1);
    expect(replies[0].sourceIP.toString()).toBe('10.0.1.10');
    expect(replies[0].destinationIP.toString()).toBe('10.0.0.10');
    const option = optionOf(replies[0], IP_OPTION_LOOSE_SOURCE_ROUTE)!;
    expect(option.data).toEqual([8, 10, 0, 0, 1]);
  });
});

describe('one builder, and it keeps the best of the four readings', () => {
  it('the firewall inserts its own address instead of copying the route', () => {
    const request = createIPv4Packet(
      new IPAddress('10.0.0.10'), new IPAddress('10.0.1.10'),
      IP_PROTO_ICMP, 64, ECHO, 16,
      { ipOptions: [{ type: IP_OPTION_RECORD_ROUTE, data: [8, 10, 0, 1, 1, 0, 0, 0, 0] }] });

    const reply = icmpEchoReply(request)!;
    const option = optionOf(reply, IP_OPTION_RECORD_ROUTE)!;
    expect(routeAddressesOf(option).map(ip => ip.toString()))
      .toEqual(['10.0.1.1', '10.0.1.10']);
    expect(verifyIPv4Checksum(reply)).toBe(true);
  });

  it('the router answers a DF-clear request without forcing DF on', async () => {
    const { r1, a } = await lab();
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(r1, a, '10.0.0.1', [], 0);

    const replies = repliesAt(atA);
    expect(replies).toHaveLength(1);
    expect(replies[0].flags).toBe(0);
  });

  it('a DF-set request is still answered with DF set — WITNESS', () => {
    const request = createIPv4Packet(
      new IPAddress('10.0.0.10'), new IPAddress('10.0.1.10'),
      IP_PROTO_ICMP, 64, ECHO, 16, { flags: IPV4_FLAG_DF });

    expect(icmpEchoReply(request)!.flags).toBe(IPV4_FLAG_DF);
  });

  it('a reply to an option-less request stays a 20-byte header — WITNESS', async () => {
    const { r1, a } = await lab();
    const atA = watchIpv4(a.getPort('eth0')!);
    inject(r1, a, '10.0.1.10', []);

    const replies = repliesAt(atA);
    expect(replies[0].ihl).toBe(5);
    expect(replies[0].options).toBeUndefined();
  });
});
