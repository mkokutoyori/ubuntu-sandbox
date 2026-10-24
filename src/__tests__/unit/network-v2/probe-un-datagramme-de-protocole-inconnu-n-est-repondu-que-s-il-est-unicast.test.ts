/**
 * Un datagramme IPv4 dont le protocole n'est celui d'aucune couche de la machine recoit « protocol unreachable » (type 3, code 2) quand il
 * est adresse a une machine, et rien quand il est adresse a un groupe : RFC 1122 §3.2.2 interdit l'erreur pour une adresse de diffusion ou de
 * groupe, et la diffusion DIRIGEE (celle du sous-reseau, que `mayGenerateICMPError` ne peut pas voir faute de masque) est ecartee par
 * l'aiguillage lui-meme. Ce fichier est ne d'un mutant que les autres sondes laissaient vivre : l'aiguillage vers la couche superieure,
 * extrait de handleIPv4 par le lot de la chaine OUTPUT de nat pour que l'arrivee sur une interface et la jambe de bouclage prennent le meme
 * chemin, combine « diffusion OU groupe » ; remplacer le OU par un ET faisait repondre a une diffusion dirigee.
 *
 * Discrimination : les trois cas passent des deux cotes, avant comme apres le lot : c'est une non-regression de l'extraction, pas un
 * correctif. Mesure laissee ouverte : un datagramme unicast qui arrive dans une trame de diffusion de niveau 2 est repondu, alors que le noyau
 * se tait (`__icmp_send` : « No replies to physical multicast/broadcast », `pkt_type != PACKET_HOST`) ; ce fichier ne fige pas ce defaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ETHERTYPE_IPV4, IPAddress, MACAddress, SubnetMask, createIPv4Packet, resetCounters,
  type EthernetFrame,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const UNKNOWN_PROTOCOL = 253;

function pair(): { sender: LinuxPC; receiver: LinuxPC; answers: string[] } {
  const sender = new LinuxPC('linux-pc', 'A');
  const receiver = new LinuxPC('linux-pc', 'B');
  const mask = new SubnetMask('255.255.255.0');
  sender.configureInterface('eth0', new IPAddress('10.0.0.1'), mask);
  receiver.configureInterface('eth0', new IPAddress('10.0.0.2'), mask);
  new Cable('link').connect(sender.getPort('eth0')!, receiver.getPort('eth0')!);
  const answers: string[] = [];
  receiver.getBus().subscribe('port.frame.tx-requested', (event: unknown) => {
    const packet = (event as { payload: { frame: EthernetFrame } }).payload.frame.payload as
      { type?: string; payload?: { type?: string; icmpType?: string; code?: number } };
    if (packet?.type === 'ipv4' && packet.payload?.type === 'icmp') answers.push(`${packet.payload.icmpType}/${packet.payload.code}`);
  });
  return { sender, receiver, answers };
}

function deliver(lab: ReturnType<typeof pair>, destination: string, frameDestination: MACAddress): void {
  const datagram = createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress(destination), UNKNOWN_PROTOCOL, 64, { type: 'raw' } as never, 8);
  lab.receiver.getPort('eth0')!.receiveFrame({
    srcMAC: lab.sender.getPort('eth0')!.getMAC(), dstMAC: frameDestination, etherType: ETHERTYPE_IPV4, payload: datagram,
  } as EthernetFrame);
}

describe('a datagram of a protocol nobody handles is answered only when it is addressed to one machine', () => {
  it('TEMOIN : a unicast datagram gets protocol unreachable', () => {
    const lab = pair();
    deliver(lab, '10.0.0.2', lab.receiver.getPort('eth0')!.getMAC());
    expect(lab.answers).toEqual(['destination-unreachable/2']);
  });

  it('a datagram sent to the broadcast address of the subnet gets nothing', () => {
    const lab = pair();
    deliver(lab, '10.0.0.255', MACAddress.broadcast());
    expect(lab.answers).toEqual([]);
  });

  it('a datagram sent to the limited broadcast address gets nothing', () => {
    const lab = pair();
    deliver(lab, '255.255.255.255', MACAddress.broadcast());
    expect(lab.answers).toEqual([]);
  });
});
