/**
 * Un commutateur de niveau 3 n'emet pas d'erreur ICMP a propos de
 * n'importe quoi — phase 2 du BRD du modele TCP/IP, increment 5.
 *
 * MESURE DE DEPART, sur un Catalyst a deux SVI (Vlan10 192.168.10.1,
 * Vlan20 192.168.20.1) :
 *
 *   erreur EN REPONSE a une erreur ICMP        1   <- interdit
 *   erreur a propos d'un paquet vers 239.1.1.1 1   <- interdit
 *   erreur a propos d'un FRAGMENT non initial  1   <- interdit
 *   TEMOIN : un vrai TTL expire                1   <- correct
 *
 * Trois interdits sur trois. La RFC 1122 §3.2.2 les nomme tous : une
 * erreur ICMP NE DOIT PAS repondre a une autre erreur ICMP (c'est ainsi
 * qu'on evite les tempetes), ni a un fragment non initial, ni a un
 * paquet destine a une adresse de diffusion ou de groupe, ni a un paquet
 * dont la source n'est pas un unicast valide.
 *
 * LA REGLE EXISTAIT DEJA ET ETAIT JUSTE : `mayGenerateICMPError` de
 * `core/IcmpErrors.ts`, lue par `Router`, `Firewall` et `EndHost`. Le
 * SVI ne l'appelait NULLE PART — quatrieme ecriture d'un meme fait, et
 * comme toujours dans ce depot c'est celle qui a oublie la regle qui est
 * la plus permissive. Le cas du groupe est le plus couteux : il fait du
 * commutateur un amplificateur Smurf, un increment apres que la moitie
 * routeur de cette meme contre-mesure a ete livree (RFC 2644).
 *
 * DEUX AUTRES DEFAUTS DU MEME SUJET, fermes avec :
 *  - `core/IcmpErrors.ts` DELEGUE a ses appelants le controle de la
 *    diffusion DIRIGEE (« callers that know the mask must check
 *    `isBroadcastFor()` themselves »), et AUCUN des trois ne le faisait.
 *    Il devient faisable ici parce que l'increment 4 a pose
 *    `isDirectedBroadcast` dans la couche.
 *  - le SVI portait DEUX emetteurs quasi identiques, ne differant que
 *    par le type et le code, et aucun des deux ne lisait `buildICMPError`
 *    du module partage. Il n'en reste qu'un.
 *
 * PORTEE, MESUREE ET NON SUPPOSEE. Le controle de diffusion dirigee est
 * pose sur le SVI seul, et les deux autres appelants ont ete mesures
 * plutot que corriges par precaution :
 *  - `Router` : l'increment 4 (RFC 2644) attrape la diffusion dirigee
 *    AVANT le chemin d'erreur, donc l'y ajouter serait une ceinture sur
 *    des bretelles.
 *  - `EndHost` : un routeur Linux a deux pattes, `ip_forward` a 1,
 *    recevant un TTL 1 vers `192.168.20.255` emet ZERO erreur — et ce
 *    zero est atteste par un TEMOIN monte dans le MEME laboratoire, un
 *    TTL 1 vers `192.168.20.10`, qui en emet exactement UNE. Sans ce
 *    temoin, un laboratoire mal bati et une absence de defaut seraient
 *    indiscernables, et c'est exactement le piege dans lequel le cas
 *    « source non unicast » ci-dessous etait tombe.
 *
 * DISCRIMINATION (`git stash` sur `SwitchSvi.ts`) : 4 des 6 cas tombent.
 * Les 2 autres sont nommes plutot que comptes :
 *  - le TEMOIN passe des deux cotes et LE DOIT : tout son objet est que
 *    le correctif ne supprime pas les erreurs LEGITIMES. Sans lui,
 *    `return` en tete de l'emetteur passerait la sonde.
 *  - « une source qui n'est pas un unicast » passait deja, et pour une
 *    raison qui ne prouve rien de la regle : la source est 0.0.0.0, donc
 *    `lookupRoute` ne trouvait aucune route de retour et l'ancien
 *    emetteur sortait de lui-meme. Le silence etait un accident de
 *    routage, pas une decision ; il est desormais decide.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4,
  createIPv4Packet, IP_PROTO_ICMP,
} from '@/network/core/types';
import type { EthernetFrame, ICMPPacket, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire() {
  const commutateur = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('a').connect(a.getPort('eth0')!, commutateur.getPort('FastEthernet0/1')!);
  new Cable('b').connect(b.getPort('eth0')!, commutateur.getPort('FastEthernet0/2')!);
  await taper(commutateur, ['enable', 'configure terminal', 'ip routing',
    'vlan 10', 'exit', 'vlan 20', 'exit',
    'interface FastEthernet0/1', 'switchport mode access',
    'switchport access vlan 10', 'exit',
    'interface FastEthernet0/2', 'switchport mode access',
    'switchport access vlan 20', 'exit',
    'interface Vlan10', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Vlan20', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'exit',
    'end']);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1']);
  await taper(b, ['ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1']);
  return { commutateur, a, b };
}

function compteurErreurs(pc: LinuxPC): () => number {
  let vues = 0;
  const port = pc.getPort('eth0')!;
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) {
      const ip = f.payload as IPv4Packet | undefined;
      const icmp = ip?.payload as ICMPPacket | undefined;
      if (icmp?.type === 'icmp'
        && (icmp.icmpType === 'time-exceeded'
          || icmp.icmpType === 'destination-unreachable')) vues += 1;
    }
    return original(f as never);
  };
  return () => vues;
}

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 1, sequence: 1, dataSize: 8,
};

function trame(
  commutateur: CiscoSwitch, source: string, destination: string,
  ttl: number, charge: unknown,
): EthernetFrame {
  return {
    srcMAC: new MACAddress('02:aa:bb:cc:dd:ee'),
    dstMAC: commutateur.getPort('FastEthernet0/1')!.getMAC(),
    etherType: ETHERTYPE_IPV4,
    payload: createIPv4Packet(
      new IPAddress(source), new IPAddress(destination), IP_PROTO_ICMP, ttl, charge, 28),
  };
}

async function erreursEmises(
  destination: string, charge: unknown,
  retoucher?: (p: IPv4Packet) => void,
): Promise<number> {
  const { commutateur, a } = await laboratoire();
  const compte = compteurErreurs(a);
  const f = trame(commutateur, '192.168.10.10', destination, 1, charge);
  retoucher?.(f.payload as IPv4Packet);
  commutateur.getPort('FastEthernet0/1')!.receiveFrame(f);
  return compte();
}

describe('la RFC 1122 §3.2.2 vaut aussi pour un commutateur de niveau 3', () => {
  it('aucune erreur EN REPONSE a une erreur ICMP', async () => {
    const erreur: ICMPPacket = {
      type: 'icmp', icmpType: 'destination-unreachable', code: 1,
      id: 0, sequence: 0, dataSize: 0,
    };
    expect(await erreursEmises('192.168.99.9', erreur)).toBe(0);
  });

  it('aucune erreur a propos d\'un paquet adresse a un GROUPE', async () => {
    expect(await erreursEmises('239.1.1.1', ECHO)).toBe(0);
  });

  it('aucune erreur a propos d\'un FRAGMENT non initial', async () => {
    expect(await erreursEmises('192.168.99.9', ECHO, (p) => { p.fragmentOffset = 185; }))
      .toBe(0);
  });

  it('aucune erreur a propos d\'une source qui n\'est pas un unicast', async () => {
    const { commutateur, a } = await laboratoire();
    const compte = compteurErreurs(a);
    commutateur.getPort('FastEthernet0/1')!
      .receiveFrame(trame(commutateur, '0.0.0.0', '192.168.99.9', 1, ECHO));
    expect(compte()).toBe(0);
  });

  it('aucune erreur a propos d\'une DIFFUSION DIRIGEE d\'un SVI', async () => {
    expect(await erreursEmises('192.168.20.255', ECHO)).toBe(0);
  });

  it('TEMOIN — un vrai TTL expire donne bien UNE erreur', async () => {
    expect(await erreursEmises('192.168.20.10', ECHO)).toBe(1);
  });
});
