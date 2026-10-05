/*
 * tcpdump sur `udp port 67 or udp port 68` : le trafic DHCP se decode en BOOTP/DHCP
 * comme `bootp_print` et `rfc1048_print` de print-bootp.c (depot the-tcpdump-group/tcpdump,
 * branche master, lu en entier : la table tag2str est generee depuis ce fichier).
 * Sans option : « BOOTP/DHCP, Request from <mac>, length N » et « BOOTP/DHCP, Reply,
 * length N ». Avec -v : xid, « Flags [none|Broadcast] », Client-IP / Your-IP / Server-IP /
 * Gateway-IP, Client-Ethernet-Address, cookie magique et options, sans ligne END (le code
 * ne l'imprime qu'a partir de -vvv) ; Parameter-Request sur des lignes de quatre
 * « nom (code) » ; « (0x%04x) » apres Flags seulement avec -vv. -q garde « UDP, length N ».
 * Non porte : la variante CMU du champ vendeur ; le DHCPv6 (546/547) n'est pas decode.
 *
 * Le client est dhclient, drapeau BROADCAST a zero : les reponses sont unicast vers l'adresse
 * proposee, et tcpdump, sur le poste du client, les decode sous « 192.168.1.1.67 > 192.168.1.1xx.68 ».
 *
 * Avant le correctif (git stash des sources) : chaque trame s'affichait « UDP, length N » ;
 * les cas de decodage tombent. Le temoin « quatre trames DORA » et le cas -q passent avant
 * comme apres.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DHCPPacket, DHCP_OPTION } from '@/network/dhcp/DHCPPacket';
import { bootpText, decodeBootp } from '@/network/devices/linux/network/tcpdump/TcpdumpBootp';
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

async function capture(extra = '') {
  const srv = new LinuxServer('linux-server', 'SRV');
  const pc = new LinuxPC('linux-pc', 'C1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(pc.getPorts()[0], sw.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  const conf = 'authoritative;\ndefault-lease-time 7200;\nsubnet 192.168.1.0 netmask 255.255.255.0 {\n  range 192.168.1.100 192.168.1.110;\n  option routers 192.168.1.1;\n  option domain-name-servers 8.8.8.8;\n}\n';
  await srv.executeCommand(`printf '%s' ${JSON.stringify(conf)} > /etc/dhcp/dhcpd.conf`);
  await srv.executeCommand('printf \'INTERFACESv4="eth0"\\n\' > /etc/default/isc-dhcp-server');
  await srv.executeCommand('systemctl start isc-dhcp-server');
  await pc.executeCommand('sudo tcpdump -i eth0 -w /tmp/d.pcap &');
  await pc.executeCommand('dhclient eth0');
  await pc.executeCommand('kill %1');
  const mac = pc.getPorts()[0].getMAC().toString();
  const text = await pc.executeCommand(`tcpdump -nn ${extra} -r /tmp/d.pcap 'udp port 67 or udp port 68'`);
  return { text, mac };
}

describe('tcpdump -nn sur le port 67/68', () => {
  it('temoin : le filtre retient les quatre trames DORA', async () => {
    const { text } = await capture();
    expect(text.split('\n').filter(line => /^\d\d:\d\d:\d\d/.test(line)).length).toBe(4);
  });

  it('Discover et Request : BOOTP/DHCP, Request from <mac>', async () => {
    const { text, mac } = await capture();
    expect(text).toContain(`IP 0.0.0.0.68 > 255.255.255.255.67: BOOTP/DHCP, Request from ${mac}, length`);
  });

  it('Offer et ACK : BOOTP/DHCP, Reply', async () => {
    const { text } = await capture();
    expect(text).toMatch(/192\.168\.1\.1\.67 > 192\.168\.1\.1\d\d\.68: BOOTP\/DHCP, Reply, length \d+/);
  });

  it('rien n est plus affiche comme UDP, length', async () => {
    const { text } = await capture();
    expect(text).not.toContain(': UDP, length');
  });

  it('-q : le comportement UDP est conserve', async () => {
    const { text } = await capture('-q');
    expect(text).not.toContain('BOOTP/DHCP');
  });
});

describe('tcpdump -v', () => {
  it('xid et Flags sans masque hexadecimal, Client-Ethernet-Address', async () => {
    const { text, mac } = await capture('-v');
    expect(text).toMatch(/xid 0x[0-9a-f]+, Flags \[(none|Broadcast)\]\n/);
    expect(text).not.toMatch(/Flags \[[a-zA-Z]+\] \(0x/);
    expect(text).toContain(`\t  Client-Ethernet-Address ${mac}`);
    expect(text).toContain('\t  Vendor-rfc1048 Extensions\n\t    Magic Cookie 0x63825363');
  });

  it('-vv ajoute le masque hexadecimal des Flags', async () => {
    const { text } = await capture('-vv');
    expect(text).toMatch(/Flags \[(none|Broadcast)\] \(0x[0-9a-f]{4}\)/);
  });

  it('options : DHCP-Message, Server-ID, Lease-Time, Subnet-Mask, Default-Gateway, Domain-Name-Server', async () => {
    const { text } = await capture('-v');
    for (const kind of ['Discover', 'Offer', 'Request', 'ACK']) {
      expect(text).toContain(`\t    DHCP-Message (53), length 1: ${kind}`);
    }
    expect(text).toContain('\t    Server-ID (54), length 4: 192.168.1.1');
    expect(text).toContain('\t    Lease-Time (51), length 4: 7200');
    expect(text).toContain('\t    Subnet-Mask (1), length 4: 255.255.255.0');
    expect(text).toContain('\t    Default-Gateway (3), length 4: 192.168.1.1');
    expect(text).toContain('\t    Domain-Name-Server (6), length 4: 8.8.8.8');
  });

  it('pas de ligne END a -v (le code source ne l imprime qu a -vvv)', async () => {
    expect((await capture('-v')).text).not.toContain('END (255)');
    expect((await capture('-vvv')).text).toContain('END (255)');
  });

  it('Hostname est entre guillemets', async () => {
    const { text } = await capture('-v');
    expect(text).toContain('Hostname (12), length 2: "C1"');
  });

  it('Reply : Your-IP et Server-IP', async () => {
    const { text } = await capture('-v');
    expect(text).toMatch(/\t  Your-IP 192\.168\.1\.10\d/);
  });
});

describe('mise en forme des options sur un paquet construit (bootp_print, rfc1048_print)', () => {
  const packet = () => {
    const request = DHCPPacket.createRequest('aa:bb:cc:dd:ee:ff', 0x1234, '10.0.0.5', '10.0.0.1');
    request.setOption(DHCP_OPTION.PARAMETER_REQUEST_LIST, [1, 3, 6, 15, 28, 42, 51]);
    request.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, '01aabbccddeeff');
    request.ciaddr = '10.0.0.5';
    request.hops = 2;
    request.secs = 7;
    return request;
  };
  const render = (verbose: number) => bootpText(decodeBootp(packet())!, verbose, 300);

  it('-v : hops, xid, secs, Flags, Client-IP dans l ordre du code', () => {
    const text = render(1);
    expect(text).toMatch(/^BOOTP\/DHCP, Request from aa:bb:cc:dd:ee:ff, length 300, hops 2, xid 0x1234, secs 7, Flags \[Broadcast\]\n\t  Client-IP 10\.0\.0\.5\n\t  Client-Ethernet-Address aa:bb:cc:dd:ee:ff/);
  });

  it('Parameter-Request : quatre « nom (code) » par ligne, noms de tag2str', () => {
    const text = render(1);
    expect(text).toContain('Parameter-Request (55), length 7: \n\t      Subnet-Mask (1), Default-Gateway (3), Domain-Name-Server (6), Domain-Name (15)\n\t      BR (28), NTP (42), Lease-Time (51)');
  });

  it('Client-ID de type 1 : « ether <mac> »', () => {
    expect(render(1)).toMatch(/Client-ID \(61\), length 7: ether aa:bb:cc:dd:ee:ff/);
  });

  it('Requested-IP et Server-ID : adresses', () => {
    const text = render(1);
    expect(text).toContain('Requested-IP (50), length 4: 10.0.0.5');
    expect(text).toContain('Server-ID (54), length 4: 10.0.0.1');
  });
});

describe('option 61 sur le fil (RFC 2132 §9.14 : octet de type puis identifiant)', () => {
  it('identifiant materiel : type 1 puis six octets, relu sous la meme forme', () => {
    const packet = DHCPPacket.createDiscover('aa:bb:cc:dd:ee:ff', 1);
    packet.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, '01aabbccddeeff');
    const bytes = packet.serialize();
    const at = [...bytes].findIndex((value, index) => index > 240 && value === 61);
    expect([...bytes.subarray(at, at + 9)]).toEqual([61, 7, 1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    expect(DHCPPacket.deserialize(bytes).getOption(DHCP_OPTION.CLIENT_IDENTIFIER)).toBe('01aabbccddeeff');
  });

  it('identifiant libre : type 0 puis le texte, relu sous la meme forme', () => {
    const packet = DHCPPacket.createDiscover('aa:bb:cc:dd:ee:ff', 1);
    packet.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'poste-7');
    const bytes = packet.serialize();
    const at = [...bytes].findIndex((value, index) => index > 240 && value === 61);
    expect([...bytes.subarray(at, at + 4)]).toEqual([61, 8, 0, 'p'.charCodeAt(0)]);
    expect(DHCPPacket.deserialize(bytes).getOption(DHCP_OPTION.CLIENT_IDENTIFIER)).toBe('poste-7');
  });
});
