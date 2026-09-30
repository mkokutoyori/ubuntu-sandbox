/*
 * Une machine tierce du LAN qui ecoute (`tcpdump` sur un port du commutateur) doit voir
 * l'echange DHCP dans l'ordre ou il s'est passe : Discover, Offer, Request, ACK, et des
 * horodatages qui ne reculent pas. La livraison des trames est synchrone et imbriquee :
 * le commutateur inonde le Discover vers le serveur, qui repond DANS cet appel, avant que
 * le Discover n'atteigne l'observateur. L'observateur voyait donc l'Offer avant le
 * Discover, ACK avant Request, avec l'heure de reception.
 * Correctif : chaque trame porte une lignee (numero d'emission et heure de sa premiere
 * emission), conservee d'un port a l'autre ; la capture remet ses trames dans l'ordre de
 * cette lignee et horodate a l'emission.
 *
 * Avant le correctif : les 2 cas d'ordre tombent (Offer avant Discover, ACK avant Request) ; le temoin « quatre messages vus » et les horodatages (qui passent parce que la reception est deja croissante) passent avant comme apres. Un Release unicast vers le serveur n'est pas vu par un observateur : le commutateur a appris l'adresse du serveur, comme un vrai.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lan() {
  const srv = new LinuxServer('linux-server', 'SRV');
  const client = new LinuxPC('linux-pc', 'C1');
  const observer = new LinuxPC('linux-pc', 'OBS');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(client.getPorts()[0], sw.getPorts()[1]);
  new Cable('c').connect(observer.getPorts()[0], sw.getPorts()[2]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  await observer.executeCommand('ip link set eth0 up');
  await srv.executeCommand(`printf '%s' ${JSON.stringify('authoritative;\nsubnet 192.168.1.0 netmask 255.255.255.0 { range 192.168.1.100 192.168.1.110; }\n')} > /etc/dhcp/dhcpd.conf`);
  await srv.executeCommand('printf \'INTERFACESv4="eth0"\\n\' > /etc/default/isc-dhcp-server');
  await srv.executeCommand('systemctl start isc-dhcp-server');
  return { srv, client, observer };
}

async function observe(rounds: number) {
  const { client, observer } = await lan();
  await observer.executeCommand('sudo tcpdump -i eth0 -w /tmp/o.pcap &');
  for (let round = 0; round < rounds; round++) {
    await client.executeCommand('dhclient eth0');
    await client.executeCommand('dhclient -r eth0');
  }
  await observer.executeCommand('kill %1');
  const text = await observer.executeCommand("tcpdump -nn -v -r /tmp/o.pcap 'udp port 67 or udp port 68'");
  const lines = text.split('\n');
  return {
    kinds: lines.map(line => /DHCP-Message \(53\), length 1: (\w+)/.exec(line)?.[1]).filter((kind): kind is string => !!kind),
    stamps: lines.map(line => /^(\d\d):(\d\d):(\d\d\.\d+)/.exec(line)).filter((m): m is RegExpExecArray => !!m)
      .map(m => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])),
  };
}

describe('observateur tiers sur le commutateur', () => {
  it('temoin : les quatre messages du DORA sont vus', async () => {
    const { kinds } = await observe(1);
    expect(kinds.slice(0, 4).sort()).toEqual(['ACK', 'Discover', 'Offer', 'Request']);
  });

  it('ordre : Discover, Offer, Request, ACK', async () => {
    const { kinds } = await observe(1);
    expect(kinds.slice(0, 4)).toEqual(['Discover', 'Offer', 'Request', 'ACK']);
  });

  it('les horodatages ne reculent pas', async () => {
    const { stamps } = await observe(1);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
  });

  it('deux echanges de suite : l ordre est conserve ; le Release, unicast vers le serveur, n atteint pas l observateur', async () => {
    const { kinds } = await observe(2);
    expect(kinds).toEqual(['Discover', 'Offer', 'Request', 'ACK', 'Discover', 'Offer', 'Request', 'ACK']);
  });
});
