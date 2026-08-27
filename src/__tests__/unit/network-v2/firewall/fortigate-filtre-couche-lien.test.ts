/**
 * BRD-Modele-TCP-IP phase 2 — une interface ROUTEE n'accepte que ce qui
 * lui est adresse ; un PONT accepte tout.
 *
 * Ecrit A L'AVEUGLE. La phase 1 a mesure que `Firewall.handleFrame` n'a
 * AUCUN filtre de couche lien : il accepte toute trame quelle qu'en soit
 * l'adresse MAC de destination. Ce n'etait donc pas une copie de la
 * regle a dedupliquer — c'est une absence, et la combler CHANGE un
 * comportement, ce que le contrat de la phase 1 interdisait. D'ou le
 * report ici.
 *
 * **La decision depend du MODE**, et c'est ce qui rend ce lot juste ou
 * faux. En mode NAT/route, FortiOS achemine sur l'ADRESSE IP : une
 * interface routee se comporte comme n'importe quelle carte reseau et
 * ecarte ce qui ne lui est pas destine. En mode transparent, le VDOM est
 * un PONT qui achemine sur l'adresse MAC : il doit accepter une trame
 * adressee a quelqu'un d'autre, sans quoi il ne peut rien relayer — ce
 * serait detruire le mode transparent en croyant durcir le mode routé.
 *
 * Le TEMOIN en mode transparent est donc la moitie qui compte : sans
 * lui, un filtre pose partout passerait pour un progres.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, ETHERTYPE_IPV4, ETHERTYPE_ARP, IP_PROTO_ICMP,
  nextIPv4Id, computeIPv4Checksum,
  type EthernetFrame, type IPv4Packet, type ICMPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { framesSentOn } from '../../../support/wireWatch';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(opmode: 'nat' | 'transparent' = 'nat') {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(srvDmz, [
    'ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1',
  ]);

  await taper(fgt, [
    'config system interface',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1', 'set name "LAN-DMZ"',
    'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);
  if (opmode === 'transparent') {
    await taper(fgt, ['config system settings', 'set opmode transparent', 'end']);
  }
  return { fgt, pcLan, srvDmz };
}

function echoTo(source: LinuxPC, destinationMac: string, destinationIp: string): EthernetFrame {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-request', code: 0,
    id: 4242, sequence: 1, dataSize: 56,
  };
  const ip: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 64, protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress('192.168.10.10'),
    destinationIP: new IPAddress(destinationIp),
    payload: icmp,
  };
  ip.headerChecksum = computeIPv4Checksum(ip);
  return {
    srcMAC: source.getPort('eth0')!.getMAC(),
    dstMAC: new MACAddress(destinationMac),
    etherType: ETHERTYPE_IPV4,
    payload: ip,
  };
}

const AUTRE_MAC = '02:00:00:00:00:99';

describe('en mode route, une interface ecarte ce qui ne lui est pas adresse', () => {
  it('TEMOIN: une trame adressee a l interface est traitee', async () => {
    const { fgt, pcLan } = await laboratoire();
    const sortantes = framesSentOn(fgt, 'port3');
    const ownMac = fgt.getPort('port2')!.getMAC().toString();

    fgt.getPort('port2')!.receiveFrame(echoTo(pcLan, ownMac, '192.168.20.10'));

    expect(sortantes.length).toBeGreaterThan(0);
  });

  it('TEMOIN: une DIFFUSION est traitee — l ARP recoit sa reponse', async () => {
    // Une regle de couche lien qui ecarterait la diffusion couperait
    // l'ARP, donc tout le reste. C'est la moitie du filtre qu'il ne faut
    // pas rater, et elle s'observe : la reponse part sur le fil.
    const { fgt, pcLan } = await laboratoire();
    const sortantes = framesSentOn(fgt, 'port2');

    await pcLan.executeCommand('ip neigh flush dev eth0');
    await pcLan.executeCommand('ping -c 1 192.168.10.1');

    expect(sortantes.some(f => f.etherType === ETHERTYPE_ARP)).toBe(true);
  });

  it('une trame adressee a une AUTRE machine ne traverse pas', async () => {
    const { fgt, pcLan } = await laboratoire();
    const sortantes = framesSentOn(fgt, 'port3');

    fgt.getPort('port2')!.receiveFrame(echoTo(pcLan, AUTRE_MAC, '192.168.20.10'));

    expect(sortantes).toEqual([]);
  });
});

async function laboratoirePont() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-02', 0, 0);
  const gauche = new LinuxPC('linux-pc', 'GAUCHE', -200, 0);
  const droite = new LinuxPC('linux-pc', 'DROITE', 200, 0);
  gauche.powerOn(); droite.powerOn();

  new Cable('g').connect(gauche.getPort('eth0')!, fgt.getPort('port1')!);
  new Cable('d').connect(fgt.getPort('port2')!, droite.getPort('eth0')!);

  await taper(fgt, [
    'config system settings', 'set opmode transparent',
    'set manageip 192.168.1.99 255.255.255.0', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next',
    'edit 2',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end',
  ]);
  await taper(gauche, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  await taper(droite, ['ip link set eth0 up', 'ip addr add 192.168.1.20/24 dev eth0']);

  return { fgt, gauche, droite };
}

describe('en mode transparent, le pont accepte tout — sinon il ne ponte rien', () => {
  it('TEMOIN: le pont apprend l adresse source de ce qui le traverse', async () => {
    // Ce que le pont fait VRAIMENT aujourd'hui, et qu'une autre suite
    // epingle deja. Le ping de bout en bout a travers le pont n'est
    // asserte nulle part dans ce depot — le prendre pour temoin
    // exigerait une fonction que rien n'a jamais promise.
    const { fgt, gauche } = await laboratoirePont();

    await gauche.executeCommand('ping -c 1 192.168.1.20');

    expect(fgt.getBridge().lookup(gauche.getPort('eth0')!.getMAC().toString().toLowerCase()))
      .toBe('port1');
  });

  it('une trame adressee a une AUTRE machine que le pare-feu est relayee', async () => {
    const { fgt, gauche, droite } = await laboratoirePont();
    await gauche.executeCommand('ping -c 1 192.168.1.20');
    const sortantes = framesSentOn(fgt, 'port2');

    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-request', code: 0,
      id: 7, sequence: 1, dataSize: 56,
    };
    const ip: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_ICMP, headerChecksum: 0,
      sourceIP: new IPAddress('192.168.1.10'),
      destinationIP: new IPAddress('192.168.1.20'),
      payload: icmp,
    };
    ip.headerChecksum = computeIPv4Checksum(ip);
    fgt.getPort('port1')!.receiveFrame({
      srcMAC: gauche.getPort('eth0')!.getMAC(),
      dstMAC: droite.getPort('eth0')!.getMAC(),
      etherType: ETHERTYPE_IPV4,
      payload: ip,
    });

    expect(sortantes.length).toBeGreaterThan(0);
  });
});

describe('le trafic normal n a pas change', () => {
  it('un ping traverse encore le pare-feu en mode route', async () => {
    const { pcLan } = await laboratoire();

    const sortie = await pcLan.executeCommand('ping -c 2 192.168.20.10');

    expect(sortie).toMatch(/, 0% packet loss/);
  });

  it('un ping vers l interface elle-meme repond encore', async () => {
    const { pcLan } = await laboratoire();

    const sortie = await pcLan.executeCommand('ping -c 2 192.168.10.1');

    expect(sortie).toMatch(/, 0% packet loss/);
  });
});

describe('une grappe presente une adresse VIRTUELLE, pas celle du chassis', () => {
  it('la formule est celle de Fortinet', async () => {
    const { clusterVirtualMac } = await import('@/network/devices/firewall/ha/clusterVirtualMac');
    const haVirtualMac = (g: number, i: number, v?: 1 | 2) => clusterVirtualMac(g, i, v).toString();
    // 00-09-0f-09-<groupe>-(<vcluster> + <index>) — port1 a l'index 0.
    expect(haVirtualMac(0, 0)).toBe('00:09:0f:09:00:00');
    expect(haVirtualMac(0, 3)).toBe('00:09:0f:09:00:03');
    expect(haVirtualMac(1, 0)).toBe('00:09:0f:09:01:00');
    // Le second cluster virtuel decale de 0x20.
    expect(haVirtualMac(0, 0, 2)).toBe('00:09:0f:09:00:20');
    // Au-dela de 255, le prefixe change de jeu.
    expect(haVirtualMac(256, 0)).toBe('e0:23:ff:fc:00:00');
  });

  it('une machine SEULE garde l adresse de son chassis', async () => {
    const { fgt } = await laboratoire();
    const propre = fgt.getPort('port2')!.getMAC().toString().toLowerCase();

    expect(propre.startsWith('00:09:0f')).toBe(false);
  });
});
