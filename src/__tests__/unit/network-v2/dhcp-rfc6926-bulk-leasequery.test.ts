/*
 * RFC 6926 (docs/rfc/dhcp/rfc6926.txt) : DHCPBULKLEASEQUERY sur TCP 67, contre
 * le moteur DHCP commun, sur le fil (pile TCP des equipements, trames de
 * message de la §6.1 : deux octets de taille puis le message DHCPv4).
 *
 * Exigences : §6.1 (cadrage), §6.2 (types 14 et 15, options 151 a 157),
 * §8.1 (ecoute sur 67, demandeurs autorises, plafond de connexions), §8.2
 * (chaque requete finit par DHCPLEASEQUERYDONE ; MalformedQuery si ciaddr,
 * yiaddr ou siaddr non nuls ; NotAllowed pour plus d'une requete primaire ;
 * requete par MAC, identifiant client ou identifiant distant ; « toutes les
 * adresses configurees » : chaque adresse une seule fois, ACTIVE ou
 * UNASSIGNED ; qualificatifs de temps), §8.3 (identifiant du serveur dans le
 * premier message seulement ; base-time, start-time-of-state, dhcp-state,
 * lease time, client-last-transaction-time selon l'option 55 ; pas d'option
 * associated-ip), §7 (l'option 92 n'apparait jamais).
 *
 * Avant le correctif le moteur ne connaissait ni les types 14 et 15 ni
 * l'ecoute TCP 67 : les cas positifs tombent. Les cas de refus (fonction
 * desactivee, demandeur non autorise) passent avant pour la meme raison ; ils
 * n'ont de sens que contre les positifs de la meme configuration.
 * Non source : la RFC 6925 (Relay-ID) et 6607 (VPN-ID) ne sont pas dans
 * docs/rfc/dhcp : une requete par Relay-ID ne correspond a rien (le relais
 * du simulateur n'insere pas de Relay-ID) et une requete VPN-ID est terminee
 * par QueryTerminated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPPacket, DHCP_OPTION } from '@/network/dhcp/DHCPPacket';
import { bulkLeaseQuery, frameMessage, unframeMessages, BulkStatus } from '@/network/dhcp/DhcpBulkLeasequery';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const SERVER = '192.168.60.1';

function request(build: (p: DHCPPacket) => void = () => undefined, xid = 1): DHCPPacket {
  const p = new DHCPPacket();
  p.op = 1;
  p.xid = xid;
  p.setOption(DHCP_OPTION.MESSAGE_TYPE, 14);
  p.setOption(DHCP_OPTION.PARAMETER_REQUEST_LIST, [152, 153, 91, 51, 156]);
  build(p);
  return p;
}

const typesOf = (messages: readonly DHCPPacket[]) => messages.map(m => m.getMessageType());
const bindingsOf = (messages: readonly DHCPPacket[]) => messages.filter(m => m.getMessageType() === 'DHCPLEASEACTIVE');

async function lab(server: 'dhcpd' | 'cisco', configure: (engine: DHCPServer) => void = () => undefined) {
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const pcA = new LinuxPC('linux-pc', 'PC-A');
  const pcB = new LinuxPC('linux-pc', 'PC-B');
  const asker = new LinuxPC('linux-pc', 'ASKER');
  let engine: DHCPServer;
  if (server === 'dhcpd') {
    const srv = new LinuxServer('linux-server', 'SRV');
    new Cable('s').connect(srv.getPorts()[0], sw.getPorts()[0]);
    srv.getPorts()[0].configureIP(new IPAddress(SERVER), new SubnetMask('255.255.255.0'));
    srv.powerOn();
    await srv.executeCommand(`printf '%s' ${JSON.stringify('authoritative;\ndefault-lease-time 600;\nsubnet 192.168.60.0 netmask 255.255.255.0 {\n  range 192.168.60.100 192.168.60.103;\n}\n')} > /etc/dhcp/dhcpd.conf`);
    await srv.executeCommand('systemctl start isc-dhcp-server');
    engine = srv.dhcpd.getEngine();
  } else {
    const router = new CiscoRouter('R1');
    new Cable('s').connect(router.getPort('GigabitEthernet0/0')!, sw.getPorts()[0]);
    for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 192.168.60.1 255.255.255.0', 'no shutdown', 'exit',
      'service dhcp', 'ip dhcp pool LAN', 'network 192.168.60.0 255.255.255.0', 'exit', 'ip dhcp excluded-address 192.168.60.1 192.168.60.99',
      'ip dhcp excluded-address 192.168.60.104 192.168.60.254', 'end']) await router.executeCommand(line);
    engine = (router as unknown as { dhcpServer: DHCPServer }).dhcpServer;
  }
  new Cable('a').connect(pcA.getPorts()[0], sw.getPorts()[1]);
  new Cable('b').connect(pcB.getPorts()[0], sw.getPorts()[2]);
  new Cable('r').connect(asker.getPorts()[0], sw.getPorts()[3]);
  asker.getPorts()[0].configureIP(new IPAddress('192.168.60.254'), new SubnetMask('255.255.255.0'));
  for (const pc of [pcA, pcB, asker]) pc.powerOn();
  await pcA.executeCommand('ip link set eth0 up');
  await pcB.executeCommand('ip link set eth0 up');
  configure(engine);
  await pcA.executeCommand('dhclient eth0');
  await pcB.executeCommand('dhclient eth0');
  const query = (packet: DHCPPacket) => bulkLeaseQuery(asker.getTcpStack(), SERVER, packet);
  return { engine, pcA, pcB, asker, query };
}

const addressOf = async (pc: LinuxPC): Promise<string> =>
  /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';

describe('cadrage TCP (§6.1) et options (§6.2)', () => {
  it('un message se cadre par deux octets de taille et se relit', () => {
    const active = new DHCPPacket();
    active.op = 2;
    active.setOption(DHCP_OPTION.MESSAGE_TYPE, 13);
    active.setOption(DHCP_OPTION.BASE_TIME, 1_700_000_000);
    active.setOption(DHCP_OPTION.DHCP_STATE, 2);
    active.setOption(DHCP_OPTION.STATUS_CODE, { code: 4, message: 'no' });
    active.setOption(DHCP_OPTION.RELAY_AGENT_INFORMATION, { circuitId: 'Gi0/1', remoteId: 'R1' });
    const framed = frameMessage(active);
    expect((framed[0] << 8) | framed[1]).toBe(framed.length - 2);
    const [back] = unframeMessages(framed);
    expect(back.getMessageType()).toBe('DHCPLEASEACTIVE');
    expect(back.getOption(DHCP_OPTION.BASE_TIME)).toBe(1_700_000_000);
    expect(back.getOption(DHCP_OPTION.DHCP_STATE)).toBe(2);
    expect(back.getOption(DHCP_OPTION.STATUS_CODE)).toEqual({ code: 4, message: 'no' });
    expect(back.getOption(DHCP_OPTION.RELAY_AGENT_INFORMATION)).toEqual({ circuitId: 'Gi0/1', remoteId: 'R1' });
  });

  it('deux messages a la suite dans le meme flux se separent', () => {
    const one = new DHCPPacket(); one.setOption(DHCP_OPTION.MESSAGE_TYPE, 13);
    const two = new DHCPPacket(); two.setOption(DHCP_OPTION.MESSAGE_TYPE, 15);
    const a = frameMessage(one);
    const b = frameMessage(two);
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a, 0);
    stream.set(b, a.length);
    expect(unframeMessages(stream).map(m => m.getMessageType())).toEqual(['DHCPLEASEACTIVE', 'DHCPLEASEQUERYDONE']);
  });
});

describe('serveur dhcpd Linux', () => {
  it('desactive par defaut : personne n ecoute sur TCP 67', async () => {
    const { query } = await lab('dhcpd');
    expect(query(request()).refused).toBe(true);
  });

  it('TEMOIN : les deux clients ont un bail', async () => {
    const { pcA, pcB } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    expect(await addressOf(pcA)).toMatch(/^192\.168\.60\.10/);
    expect(await addressOf(pcB)).toMatch(/^192\.168\.60\.10/);
  });

  it('par MAC : le bail du client, puis DHCPLEASEQUERYDONE', async () => {
    const { pcA, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const mac = pcA.getPorts()[0].getMAC().toString();
    const outcome = query(request(p => { p.chaddr = mac.toUpperCase(); }));
    expect(outcome.complete).toBe(true);
    expect(typesOf(outcome.messages)).toEqual(['DHCPLEASEACTIVE', 'DHCPLEASEQUERYDONE']);
    expect(outcome.messages[0].ciaddr).toBe(await addressOf(pcA));
  });

  it('par MAC : l autre client n apparait pas', async () => {
    const { pcA, pcB, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => { p.chaddr = pcA.getPorts()[0].getMAC().toString().toUpperCase(); }));
    expect(bindingsOf(outcome.messages).map(m => m.ciaddr)).not.toContain(await addressOf(pcB));
  });

  it('une MAC inconnue : DHCPLEASEQUERYDONE seul, sans code d etat', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => { p.chaddr = '02:99:99:99:99:99'; }));
    expect(typesOf(outcome.messages)).toEqual(['DHCPLEASEQUERYDONE']);
    expect(outcome.messages[0].getOption(DHCP_OPTION.STATUS_CODE)).toBeUndefined();
  });

  it('toutes les adresses configurees : chacune une seule fois, ACTIVE ou UNASSIGNED, puis DONE', async () => {
    const { pcA, pcB, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request());
    const records = outcome.messages.filter(m => m.getMessageType() !== 'DHCPLEASEQUERYDONE');
    const addresses = records.map(m => m.ciaddr);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses.length).toBe(4);
    expect(bindingsOf(outcome.messages).map(m => m.ciaddr).sort()).toEqual([await addressOf(pcA), await addressOf(pcB)].sort());
    expect(records.filter(m => m.getMessageType() === 'DHCPLEASEUNASSIGNED').length).toBe(2);
    expect(outcome.messages[outcome.messages.length - 1].getMessageType()).toBe('DHCPLEASEQUERYDONE');
  });

  it('les options demandees par l option 55 sont renvoyees : base-time, dhcp-state, temps de bail, transaction', async () => {
    const { pcA, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => { p.chaddr = pcA.getPorts()[0].getMAC().toString().toUpperCase(); }));
    const active = outcome.messages[0];
    expect(active.getOption(DHCP_OPTION.BASE_TIME)).toBeGreaterThan(1_000_000_000);
    expect(active.getOption(DHCP_OPTION.DHCP_STATE)).toBe(2);
    expect(active.getOption(DHCP_OPTION.LEASE_TIME)).toBeGreaterThan(0);
    expect(active.getOption(DHCP_OPTION.CLIENT_LAST_TRANSACTION_TIME)).toBeGreaterThanOrEqual(0);
    expect(active.getOption(DHCP_OPTION.START_TIME_OF_STATE)).toBeGreaterThanOrEqual(0);
  });

  it('sans option 55 : aucune de ces options', async () => {
    const { pcA, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => {
      p.chaddr = pcA.getPorts()[0].getMAC().toString().toUpperCase();
      p.removeOption(DHCP_OPTION.PARAMETER_REQUEST_LIST);
    }));
    expect(outcome.messages[0].getOption(DHCP_OPTION.BASE_TIME)).toBeUndefined();
    expect(outcome.messages[0].getOption(DHCP_OPTION.DHCP_STATE)).toBeUndefined();
  });

  it('l identifiant du serveur figure dans le premier message seulement (§8.3)', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request());
    expect(outcome.messages[0].getOption(DHCP_OPTION.SERVER_IDENTIFIER)).toBe(SERVER);
    for (const later of outcome.messages.slice(1)) expect(later.getOption(DHCP_OPTION.SERVER_IDENTIFIER)).toBeUndefined();
  });

  it('l option associated-ip n apparait jamais (§7)', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    for (const message of query(request()).messages) expect(message.getOption(DHCP_OPTION.ASSOCIATED_IP)).toBeUndefined();
  });

  it('ciaddr non nul : DHCPLEASEQUERYDONE avec MalformedQuery', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => { p.ciaddr = '192.168.60.100'; }));
    expect(typesOf(outcome.messages)).toEqual(['DHCPLEASEQUERYDONE']);
    expect((outcome.messages[0].getOption(DHCP_OPTION.STATUS_CODE) as { code: number }).code).toBe(BulkStatus.MalformedQuery);
  });

  it('deux requetes primaires : NotAllowed', async () => {
    const { pcA, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => {
      p.chaddr = pcA.getPorts()[0].getMAC().toString().toUpperCase();
      p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01');
    }));
    expect((outcome.messages[0].getOption(DHCP_OPTION.STATUS_CODE) as { code: number }).code).toBe(BulkStatus.NotAllowed);
  });

  it('une requete de VPN est terminee par QueryTerminated (non prise en charge)', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => { p.setOption(221, new Uint8Array([0, 118])); }));
    expect((outcome.messages[0].getOption(DHCP_OPTION.STATUS_CODE) as { code: number }).code).toBe(BulkStatus.QueryTerminated);
  });

  it('qualificatif de temps : une fenetre dans le futur ne renvoie aucun bail', async () => {
    const { engine, query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    void engine;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const outcome = query(request(p => { p.setOption(DHCP_OPTION.QUERY_START_TIME, future); }));
    expect(typesOf(outcome.messages)).toEqual(['DHCPLEASEQUERYDONE']);
  });

  it('qualificatif de temps : une fenetre qui contient les baux les renvoie', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true));
    const past = Math.floor(Date.now() / 1000) - 3600;
    const outcome = query(request(p => { p.setOption(DHCP_OPTION.QUERY_START_TIME, past); }));
    expect(bindingsOf(outcome.messages).length).toBe(2);
  });

  it('un demandeur qui n est pas autorise est refuse : la connexion n aboutit a aucune reponse', async () => {
    const { query } = await lab('dhcpd', e => e.setBulkLeasequery(true, ['10.9.9.9']));
    const outcome = query(request());
    expect(outcome.messages).toEqual([]);
  });
});

describe('meme moteur sur un routeur Cisco', () => {
  it('le routeur repond a la requete en masse comme le dhcpd', async () => {
    const { pcA, query } = await lab('cisco', e => e.setBulkLeasequery(true));
    const outcome = query(request(p => { p.chaddr = pcA.getPorts()[0].getMAC().toString().toUpperCase(); }));
    expect(typesOf(outcome.messages)).toEqual(['DHCPLEASEACTIVE', 'DHCPLEASEQUERYDONE']);
    expect(outcome.messages[0].ciaddr).toBe(await addressOf(pcA));
  });
});
