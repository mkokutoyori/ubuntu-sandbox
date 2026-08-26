/**
 * Une somme de controle d'en-tete fausse fait TOMBER le datagramme —
 * phase 2 du BRD du modele TCP/IP, increment 6.
 *
 * MESURE DE DEPART. La RFC 1812 §5.2.2 est sans ambiguite : un routeur
 * DOIT verifier la somme de controle d'en-tete de tout datagramme recu
 * et jeter EN SILENCE celui dont elle est fausse. `verifyIPv4Checksum`
 * existe dans `core/types.ts` depuis toujours, et `Router` comme
 * `EndHost` l'appellent — le routeur va meme jusqu'a compter
 * `ipInHdrErrors`. Deux equipements de niveau 3 ne l'appelaient NULLE
 * PART :
 *
 *   commutateur de niveau 3, somme 0x1234  -> paquet LIVRE (1)
 *   pare-feu, somme 0x1234                 -> paquet LIVRE (1)
 *
 * Quatrieme et cinquieme ecriture d'un meme fait, et comme partout
 * ailleurs dans ce depot ce sont celles qui ont oublie la regle qui sont
 * les plus permissives. Le champ etait ECRIT par trente-huit sites
 * (`headerChecksum = computeIPv4Checksum(...)`) et LU par deux : un
 * champ qu'on calcule partout et que presque personne ne verifie est
 * exactement le « critere range et jamais evalue » que le CLAUDE.md
 * interdit.
 *
 * CE QUI N'A PAS ETE FAIT, et pourquoi : `verifyIPv4Checksum` n'est PAS
 * deplacee dans `layers/internet/`. Elle est deja l'unique implantation,
 * partagee, et la deplacer churnerait trente-huit sites d'appel sans
 * rien dedupliquer — la regle de reutilisation demande de l'APPELER, pas
 * de la demenager.
 *
 * LE SILENCE EST LA REGLE, pas une facilite : la RFC dit « silently
 * discard », et emettre une erreur ICMP a propos d'un en-tete corrompu
 * serait doublement faux, puisque l'adresse source de cet en-tete est
 * elle-meme suspecte — on repondrait a une victime choisie par l'erreur.
 * C'est la meme famille que l'increment 5.
 *
 * DISCRIMINATION (`git stash` sur `SwitchSvi.ts` et `Firewall.ts`) : les
 * 2 cas de rejet tombent, les 2 TEMOINS passent des deux cotes et LE
 * DOIVENT — sans eux, jeter TOUT paquet passerait la sonde.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
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

const ECHO: ICMPPacket = {
  type: 'icmp', icmpType: 'echo-request', code: 0, id: 1, sequence: 1, dataSize: 8,
};

function compteurIpv4(pc: LinuxPC): () => number {
  let vues = 0;
  const port = pc.getPort('eth0')!;
  const original = port.receiveFrame.bind(port);
  (port as unknown as { receiveFrame: unknown }).receiveFrame = (f: EthernetFrame) => {
    if (f.etherType === ETHERTYPE_IPV4) vues += 1;
    return original(f as never);
  };
  return () => vues;
}

function paquet(somme?: number): IPv4Packet {
  const p = createIPv4Packet(
    new IPAddress('192.168.10.10'), new IPAddress('192.168.20.10'),
    IP_PROTO_ICMP, 64, ECHO, 28);
  if (somme !== undefined) p.headerChecksum = somme;
  return p;
}

async function laboratoireCommutateur() {
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
  await a.executeCommand('ping -c 1 192.168.20.10');
  return { commutateur, a, b };
}

async function laboratoirePareFeu() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const a = new LinuxPC('linux-pc', 'A', -200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('a').connect(a.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('b').connect(fgt.getPort('port3')!, b.getPort('eth0')!);
  await taper(fgt, ['config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'next', 'end']);
  await taper(a, ['ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1']);
  await taper(b, ['ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1']);
  await a.executeCommand('ping -c 1 192.168.20.10');
  return { fgt, a, b };
}

describe('un commutateur de niveau 3 verifie la somme de controle', () => {
  it('une somme FAUSSE ne traverse pas', async () => {
    const { commutateur, a, b } = await laboratoireCommutateur();
    const compte = compteurIpv4(b);
    commutateur.getPort('FastEthernet0/1')!.receiveFrame({
      srcMAC: a.getPort('eth0')!.getMAC(),
      dstMAC: commutateur.getPort('FastEthernet0/1')!.getMAC(),
      etherType: ETHERTYPE_IPV4, payload: paquet(0x1234),
    });
    expect(compte()).toBe(0);
  });

  it('TEMOIN — la meme trame a somme JUSTE traverse', async () => {
    const { commutateur, a, b } = await laboratoireCommutateur();
    const compte = compteurIpv4(b);
    commutateur.getPort('FastEthernet0/1')!.receiveFrame({
      srcMAC: a.getPort('eth0')!.getMAC(),
      dstMAC: commutateur.getPort('FastEthernet0/1')!.getMAC(),
      etherType: ETHERTYPE_IPV4, payload: paquet(),
    });
    expect(compte()).toBeGreaterThan(0);
  });
});

describe('et un pare-feu aussi', () => {
  it('une somme FAUSSE ne traverse pas', async () => {
    const { fgt, a, b } = await laboratoirePareFeu();
    const compte = compteurIpv4(b);
    fgt.getPort('port2')!.receiveFrame({
      srcMAC: a.getPort('eth0')!.getMAC(),
      dstMAC: fgt.getPort('port2')!.getMAC(),
      etherType: ETHERTYPE_IPV4, payload: paquet(0x1234),
    });
    expect(compte()).toBe(0);
  });

  it('TEMOIN — la meme trame a somme JUSTE traverse', async () => {
    const { fgt, a, b } = await laboratoirePareFeu();
    const compte = compteurIpv4(b);
    fgt.getPort('port2')!.receiveFrame({
      srcMAC: a.getPort('eth0')!.getMAC(),
      dstMAC: fgt.getPort('port2')!.getMAC(),
      etherType: ETHERTYPE_IPV4, payload: paquet(),
    });
    expect(compte()).toBeGreaterThan(0);
  });
});
