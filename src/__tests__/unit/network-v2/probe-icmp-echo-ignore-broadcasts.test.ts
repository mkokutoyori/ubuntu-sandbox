/**
 * `net.ipv4.icmp_echo_ignore_broadcasts` est une CLE, pas un cablage.
 *
 * Ecrit A L'AVEUGLE. Le `TODO.md` porte la mesure : un hote Linux de ce
 * simulateur ne repond jamais a un echo adresse a une diffusion, ce qui
 * est le bon defaut — une vraie Ubuntu met la cle a 1, et c'est la
 * moitie HOTE de la contre-mesure Smurf dont la RFC 2644 est la moitie
 * ROUTEUR. Mais c'est CABLE : la cle n'est publiee nulle part sous
 * `/proc/sys`, donc `sysctl net.ipv4.icmp_echo_ignore_broadcasts` repond
 * `cannot stat`, et le laboratoire qui rend l'amplification VISIBLE —
 * poser la cle a 0, voir tout un segment repondre a un seul paquet — ne
 * peut pas etre joue.
 *
 * Le TEMOIN est le defaut : a 1, personne ne repond. Sans lui, une cle
 * qui ne servirait a rien passerait pour une fonction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask, ETHERTYPE_IPV4, IP_PROTO_ICMP,
  nextIPv4Id, computeIPv4Checksum,
  type EthernetFrame, type IPv4Packet, type ICMPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function segment() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  const hosts = ['A', 'B', 'C'].map((nom, i) => {
    const pc = new LinuxPC('linux-pc', nom, i * 100, 0);
    pc.powerOn();
    new Cable(`c${i}`).connect(pc.getPort('eth0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    pc.configureInterface('eth0',
      new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    return pc;
  });
  return { sw, hosts };
}

const CLE = 'net.ipv4.icmp_echo_ignore_broadcasts';

describe('la cle existe et se lit', () => {
  it('elle vaut 1 par defaut, comme sur une vraie Ubuntu', async () => {
    const { hosts } = segment();

    expect((await hosts[0].executeCommand(`sysctl ${CLE}`)).trim())
      .toBe(`${CLE} = 1`);
  });

  it('le pseudo-fichier la porte aussi — une seule verite', async () => {
    const { hosts } = segment();

    expect((await hosts[0].executeCommand(
      'cat /proc/sys/net/ipv4/icmp_echo_ignore_broadcasts')).trim()).toBe('1');
  });

  it('elle se REGLE', async () => {
    const { hosts } = segment();

    await hosts[0].executeCommand(`sudo sysctl -w ${CLE}=0`);

    expect((await hosts[0].executeCommand(`sysctl ${CLE}`)).trim())
      .toBe(`${CLE} = 0`);
  });
});

function echoDiffuse(source: LinuxPC): EthernetFrame {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-request', code: 0,
    id: 1234, sequence: 1, dataSize: 56,
  };
  const ip: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 84,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 64, protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress('10.0.0.1'),
    destinationIP: new IPAddress('10.0.0.255'),
    payload: icmp,
  };
  ip.headerChecksum = computeIPv4Checksum(ip);
  return {
    srcMAC: source.getPort('eth0')!.getMAC(),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: ip,
  };
}

function reponses(cible: LinuxPC): ICMPPacket[] {
  const vues: ICMPPacket[] = [];
  cible.attachCapture(({ direction, frame }) => {
    if (direction !== 'out' || frame.etherType !== ETHERTYPE_IPV4) return;
    const ip = frame.payload as IPv4Packet;
    const icmp = ip?.payload as ICMPPacket | undefined;
    if (icmp?.type === 'icmp' && icmp.icmpType === 'echo-reply') vues.push(icmp);
  });
  return vues;
}

describe('la valeur decide de la reponse', () => {
  it('TEMOIN: a 1, un echo diffuse ne recoit aucune reponse', async () => {
    const { hosts } = segment();
    const vues = reponses(hosts[1]);

    hosts[1].getPort('eth0')!.receiveFrame(echoDiffuse(hosts[0]));

    expect(vues).toEqual([]);
  });

  it('a 0, l hote repond — c est ce que la cle gouverne', async () => {
    const { hosts } = segment();
    await hosts[1].executeCommand(`sudo sysctl -w ${CLE}=0`);
    const vues = reponses(hosts[1]);

    hosts[1].getPort('eth0')!.receiveFrame(echoDiffuse(hosts[0]));

    expect(vues.length).toBe(1);
  });

  it('TEMOIN: un echo ADRESSE recoit toujours sa reponse, quelle que soit la cle', async () => {
    // Sans ce cas, une cle qui ferait taire l'hote pour TOUT echo
    // passerait pour une contre-mesure.
    const { hosts } = segment();
    const vues = reponses(hosts[1]);

    const sortie = await hosts[0].executeCommand('ping -c 1 10.0.0.2');

    expect(sortie).toMatch(/, 0% packet loss/);
    expect(vues.length).toBeGreaterThan(0);
  });
});
