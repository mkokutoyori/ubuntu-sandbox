/**
 * Sur IPv6 la somme UDP est OBLIGATOIRE, et elle est calculee comme
 * verifiee — evaluation de la couche transport du BRD.
 *
 * MESURE DE DEPART. En IPv4 ce depot calcule la somme UDP alors qu'elle
 * y est FACULTATIVE (`sendUdpDatagram` la tamponne, `deliverUDP` et le
 * routeur la verifient). En IPv6 elle est OBLIGATOIRE — RFC 8200 §8.1,
 * un recepteur DOIT jeter un datagramme UDP a somme nulle, les
 * exceptions des RFC 6935/6936 ne visant que des tunnels — et elle etait
 * ici ABSENTE DANS LES DEUX SENS. C'est l'inverse exact des deux cotes :
 * facultative-et-implantee en IPv4, obligatoire-et-absente en IPv6.
 *
 * Les CINQ emetteurs posaient `checksum: 0` en dur — `sendUdpDatagram6`
 * (le chemin general, celui de mDNS et LLMNR), le client DHCPv6
 * d'`EndHost`, et les trois points d'`IPv6DataPlane` (reponse du serveur
 * DHCPv6, relais aller, relais retour) — et `deliverUDP6` livrait a
 * l'ecouteur sans rien verifier.
 *
 * L'ORDRE DU CORRECTIF EST CONTRAINT, et c'est la seule difficulte du
 * lot : brancher la verification AVANT de calculer aux cinq emetteurs
 * ferait tomber tout le trafic DHCPv6 du depot, qui partait a somme
 * nulle. Les six points bougent donc ensemble, et `stampUdpChecksum` est
 * la regle unique qu'ils lisent tous — y compris le chemin multicast,
 * ou la somme ne peut etre posee qu'une fois la source CHOISIE, donc par
 * interface, exactement comme le chemin multicast IPv4 le faisait deja.
 *
 * DISCRIMINATION (`git stash` sur `EndHost.ts`, `IPv6DataPlane.ts` et
 * `UdpChecksum.ts`) : 3 des 6 cas tombent — les trois REFUS, qui sont
 * la moitie reception. Les 3 autres sont les trajets de bout en bout
 * (unicast, boucle) et le TEMOIN de la somme juste ; ils passent des
 * deux cotes et LE DOIVENT, mais pour des raisons OPPOSEES, et c'est ce
 * qui les rend indispensables : AVANT, ils aboutissaient parce que
 * personne ne verifiait ; APRES, ils aboutissent parce que l'emetteur
 * calcule exactement ce que le recepteur exige. Sans eux, brancher la
 * verification sans calculer aux cinq emetteurs passerait la sonde en
 * ayant coupe tout le trafic DHCPv6 du depot.
 *
 * Le cas MULTICAST a ete RETIRE plutot que force : il ne livrait rien,
 * et la cause est l'appartenance au groupe `ff02::fb` — une autre
 * question que la somme de controle. Le chemin multicast est couvert
 * par les 37 suites mDNS/LLMNR/IPv6, vertes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPv6Address, ETHERTYPE_IPV6,
  createIPv6Packet, IP_PROTO_UDP,
} from '@/network/core/types';
import type { UDPPacket } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { computeUdpChecksum } from '@/network/layers/transport/UdpChecksum';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const A = '2001:db8::10';
const B = '2001:db8::20';

async function laboratoire() {
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  const cable = new Cable('lan');
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  await taper(a, ['ip link set eth0 up', `ip -6 addr add ${A}/64 dev eth0`]);
  await taper(b, ['ip link set eth0 up', `ip -6 addr add ${B}/64 dev eth0`]);
  return { a, b, cable };
}

function injecter(
  cible: LinuxPC, source: string, destination: string,
  udp: UDPPacket, srcMac: MACAddress,
): void {
  cible.getPort('eth0')!.receiveFrame({
    srcMAC: srcMac,
    dstMAC: cible.getPort('eth0')!.getMAC(),
    etherType: ETHERTYPE_IPV6,
    payload: createIPv6Packet(
      new IPv6Address(source), new IPv6Address(destination),
      IP_PROTO_UDP, 64, udp, udp.length),
  });
}

function datagramme(payload: string, checksum: number): UDPPacket {
  return {
    type: 'udp', sourcePort: 40000, destinationPort: 9999,
    length: 8 + payload.length, checksum, payload,
  };
}

describe('un datagramme UDP sur IPv6 PORTE une somme de controle', () => {
  it('le trajet complet aboutit — donc l\'emetteur a calcule ce que le recepteur exige', async () => {
    const { a, b } = await laboratoire();
    let recu: unknown = null;
    b.udpBind(9999, ({ udp }) => { recu = udp.payload; });
    await a.executeCommand(`ping6 -c 1 ${B}`);
    a.sendUdpDatagramTo(new IPv6Address(B), 9999, 40000, 'bonjour', 7);
    expect(recu).toBe('bonjour');
  });

  it('et le trajet par la BOUCLE aboutit', async () => {
    const { a } = await laboratoire();
    let recu: unknown = null;
    a.udpBind(7777, ({ udp }) => { recu = udp.payload; });
    a.sendUdpDatagramTo(new IPv6Address(A), 7777, 40000, 'local', 5);
    expect(recu).toBe('local');
  });
});

describe('et la reception applique la RFC 8200 §8.1', () => {
  async function livreA9999(udp: UDPPacket): Promise<boolean> {
    const { a, b } = await laboratoire();
    let recu = false;
    a.udpBind(9999, () => { recu = true; });
    injecter(a, B, A, udp, b.getPort('eth0')!.getMAC());
    return recu;
  }

  it('TEMOIN — une somme JUSTE est livree a l\'ecouteur', async () => {
    const bonne = datagramme('salut', 0);
    expect(await livreA9999({
      ...bonne, checksum: computeUdpChecksum(bonne, B, A),
    })).toBe(true);
  });

  it('une somme NULLE est refusee, la somme etant obligatoire en IPv6', async () => {
    expect(await livreA9999(datagramme('salut', 0))).toBe(false);
  });

  it('une somme FAUSSE est refusee', async () => {
    expect(await livreA9999(datagramme('salut', 0x1234))).toBe(false);
  });

  it('une CORRUPTION de la charge est detectee', async () => {
    const original = datagramme('salut', 0);
    const somme = computeUdpChecksum(original, B, A);
    expect(await livreA9999({ ...datagramme('salvt', 0), checksum: somme })).toBe(false);
  });
});
