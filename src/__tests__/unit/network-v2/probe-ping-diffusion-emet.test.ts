/**
 * `ping -b` met vraiment une trame sur le fil.
 *
 * Ecrit A L'AVEUGLE. Mesure inscrite au `TODO.md` en fermant la cle
 * `net.ipv4.icmp_echo_ignore_broadcasts` : `ping -b -c 1 10.0.0.255`
 * rend `From  icmp_seq=1 Destination Host Unreachable` — l'adresse
 * apres `From` est VIDE, donc c'est un ICMP fabrique localement — et
 * `100% packet loss`. Aucune trame ne part. La cause est en amont de
 * l'envoi : la destination passe par une resolution ARP, alors qu'une
 * diffusion ne se resout pas, elle s'adresse a `ff:ff:ff:ff:ff:ff`.
 *
 * Consequence pedagogique : le laboratoire Smurf — poser la cle a 0 sur
 * un segment et voir tout le monde repondre a un seul paquet — restait
 * injouable alors que ses DEUX autres moities (le routeur qui explose
 * la diffusion dirigee, l'hote qui decide de repondre) sont livrees.
 *
 * Le TEMOIN est l'envoi ORDINAIRE : si la resolution ARP disparaissait
 * pour tout le monde, un ping normal cesserait de fonctionner et le
 * correctif serait pire que le defaut.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  resetCounters, MACAddress, IPAddress, SubnetMask, ETHERTYPE_IPV4, IP_PROTO_ICMP,
  type IPv4Packet, type ICMPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { framesSentOn } from '../../support/wireWatch';

const CLE = 'net.ipv4.icmp_echo_ignore_broadcasts';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function segment(repondeurs: boolean) {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  const hosts = ['A', 'B', 'C'].map((nom, i) => {
    const pc = new LinuxPC('linux-pc', nom, i * 100, 0);
    pc.powerOn();
    new Cable(`c${i}`).connect(pc.getPort('eth0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    pc.configureInterface('eth0',
      new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    return pc;
  });
  if (repondeurs) {
    for (const pc of hosts.slice(1)) await pc.executeCommand(`sudo sysctl -w ${CLE}=0`);
  }
  return { sw, hosts };
}

function echosParmi(sorties: readonly { etherType: number; payload: unknown }[]) {
  return sorties.filter(f => {
    if (f.etherType !== ETHERTYPE_IPV4) return false;
    const ip = f.payload as IPv4Packet | undefined;
    return ip?.protocol === IP_PROTO_ICMP
      && (ip.payload as ICMPPacket)?.icmpType === 'echo-request';
  });
}

describe('la trame part, et elle part en diffusion', () => {
  it('une trame quitte la machine', async () => {
    const { hosts } = await segment(true);
    const sorties = framesSentOn(hosts[0], 'eth0');

    await hosts[0].executeCommand('ping -b -c 1 10.0.0.255');

    expect(echosParmi(sorties).length).toBeGreaterThan(0);
  });

  it('son adresse de destination de couche lien est la diffusion', async () => {
    const { hosts } = await segment(true);
    const sorties = framesSentOn(hosts[0], 'eth0');

    await hosts[0].executeCommand('ping -b -c 1 10.0.0.255');

    const echos = sorties.filter(f => {
      const ip = f.payload as IPv4Packet | undefined;
      return ip?.protocol === IP_PROTO_ICMP
        && (ip.payload as ICMPPacket)?.icmpType === 'echo-request';
    });
    expect(echos.length).toBeGreaterThan(0);
    expect(echos.every(f => f.dstMAC.isBroadcast())).toBe(true);
  });

  it('l adresse de diffusion n est jamais RESOLUE par ARP', async () => {
    // Une diffusion ne se resout pas : elle s'adresse. Ce qui est exclu
    // est la DEMANDE portant 10.0.0.255 pour cible — une reponse ARP
    // faite a un voisin qui, lui, cherche notre adresse est legitime et
    // n'a rien a voir avec l'envoi.
    const { hosts } = await segment(true);
    const sorties = framesSentOn(hosts[0], 'eth0');

    await hosts[0].executeCommand('ping -b -c 1 10.0.0.255');

    const demandes = sorties.filter(f => {
      if (f.etherType !== 0x0806) return false;
      const arp = f.payload as { operation?: string; targetIP?: { toString(): string } };
      return arp?.operation === 'request' && arp.targetIP?.toString() === '10.0.0.255';
    });
    expect(demandes).toEqual([]);
  });
});

describe('le segment repond, et c est l amplification', () => {
  it('la cle a 0 sur les voisins, les reponses reviennent', async () => {
    const { hosts } = await segment(true);

    const sortie = await hosts[0].executeCommand('ping -b -c 1 10.0.0.255');

    expect(sortie).not.toMatch(/100% packet loss/);
  });

  it('TEMOIN: la cle a 1 — la trame part quand meme, personne ne repond', async () => {
    // Ce qui distingue les deux moities : l'emission est le sujet de ce
    // lot, la reponse celui du precedent.
    const { hosts } = await segment(false);
    const sorties = framesSentOn(hosts[0], 'eth0');

    const sortie = await hosts[0].executeCommand('ping -b -c 1 10.0.0.255');

    expect(sorties.length).toBeGreaterThan(0);
    expect(sortie).toMatch(/100% packet loss/);
  });
});

describe('ce qui ne doit PAS changer', () => {
  it('TEMOIN: un ping ordinaire resout toujours par ARP et aboutit', async () => {
    const { hosts } = await segment(false);
    const sorties = framesSentOn(hosts[0], 'eth0');

    const sortie = await hosts[0].executeCommand('ping -c 1 10.0.0.2');

    expect(sortie).toMatch(/, 0% packet loss/);
    expect(sorties.some(f => f.etherType === 0x0806)).toBe(true);
  });

  it('TEMOIN: une destination hors du segment echoue encore proprement', async () => {
    const { hosts } = await segment(false);

    const sortie = await hosts[0].executeCommand('ping -c 1 192.0.2.9');

    expect(sortie).toMatch(/100% packet loss|unreachable/);
  });
});
