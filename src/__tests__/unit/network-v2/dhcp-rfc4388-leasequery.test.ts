/*
 * RFC 4388 (docs/rfc/dhcp/rfc4388.txt) : DHCPLEASEQUERY, au point d'entree que
 * partagent tous les serveurs (buildDhcpServerReply), puis sur le fil contre
 * un dhcpd Linux (`leasequery on;`) ; la mise en oeuvre est dans le moteur
 * commun, donc les routeurs Cisco et Huawei, la SVI, Windows Server et le
 * FortiGate la portent des qu'ils l'activent.
 *
 * Exigences testees : §6.1 (types 10 a 13, options 91 et 92), §6.3 (giaddr non
 * nul, exactement un critere parmi ciaddr, chaddr et client-id), §6.4
 * (LEASEUNKNOWN ne porte aucune autre option, LEASEUNASSIGNED n'en porte
 * aucune, LEASEACTIVE porte ciaddr, chaddr, l'option 91, l'option 92 quand
 * plusieurs adresses, les options demandees par l'option 55, le bail
 * restant), §6.4.3 (reponse unicast a giaddr, silence si giaddr est nul), §7
 * (un serveur ne repond qu'a un demandeur autorise ; desactive par defaut).
 *
 * Avant le correctif le moteur ne connaissait pas les types 10 a 13 : tous les
 * cas positifs tombent. Les cas de silence (fonction desactivee, giaddr nul,
 * deux criteres, demandeur non autorise) passent avant pour la meme raison
 * (rien n'etait repondu) : ils n'ont de sens que contre les positifs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPPacket, DHCP_OPTION } from '@/network/dhcp/DHCPPacket';
import { buildDhcpServerReply, dhcpReplyRoute } from '@/network/dhcp/DhcpServerExchange';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const SERVER = '10.0.0.1';
const RELAY = '10.0.0.254';
const MAC_A = 'aa:bb:cc:00:00:01';
const MAC_B = 'aa:bb:cc:00:00:02';

function server(enable = true): DHCPServer {
  const s = new DHCPServer();
  s.setPingPacketCount(0);
  s.setServerIdentifier(SERVER);
  s.createPool('LAN');
  s.configurePoolNetwork('LAN', '10.0.0.0', '255.255.255.0');
  s.configurePoolLease('LAN', 3600);
  s.configurePoolDNS('LAN', ['8.8.8.8']);
  s.configurePoolRouter('LAN', '10.0.0.1');
  s.addExcludedRange('10.0.0.1', '10.0.0.9');
  if (enable) s.setLeasequery(true);
  return s;
}

const ask = (s: DHCPServer, packet: DHCPPacket) => buildDhcpServerReply(packet, { server: s, localGatewayIP: SERVER });

function lease(s: DHCPServer, mac: string, extra: (p: DHCPPacket) => void = () => undefined): string {
  const discover = DHCPPacket.createDiscover(mac, 1);
  extra(discover);
  const offer = ask(s, discover)!;
  const request = DHCPPacket.createRequest(mac, 2, offer.yiaddr, SERVER);
  extra(request);
  ask(s, request);
  return offer.yiaddr;
}

const query = (q: { ipAddress?: string; hardwareAddress?: string; clientIdentifier?: string; parameterRequestList?: number[]; giaddr?: string }) =>
  DHCPPacket.createLeaseQuery({ giaddr: RELAY, ...q }, 77);

describe('conditions de reponse (§6.3, §6.4.3, §7)', () => {
  it('desactive par defaut : aucune reponse', () => {
    const s = server(false);
    const address = lease(s, MAC_A);
    expect(ask(s, query({ ipAddress: address }))).toBeNull();
  });

  it('giaddr nul : le serveur NE repond PAS', () => {
    const s = server();
    const address = lease(s, MAC_A);
    expect(ask(s, query({ ipAddress: address, giaddr: '0.0.0.0' }))).toBeNull();
  });

  it('deux criteres a la fois : pas de reponse', () => {
    const s = server();
    const address = lease(s, MAC_A);
    expect(ask(s, query({ ipAddress: address, hardwareAddress: MAC_A }))).toBeNull();
  });

  it('aucun critere : pas de reponse', () => {
    expect(ask(server(), query({}))).toBeNull();
  });

  it('un demandeur qui n est pas dans la liste autorisee n obtient rien', () => {
    const s = server();
    s.setLeasequery(true, ['10.0.0.100']);
    const address = lease(s, MAC_A);
    expect(ask(s, query({ ipAddress: address }))).toBeNull();
  });

  it('la reponse part en unicast vers giaddr', () => {
    const s = server();
    const address = lease(s, MAC_A);
    const request = query({ ipAddress: address });
    const reply = ask(s, request)!;
    expect(reply.giaddr).toBe(RELAY);
    expect(dhcpReplyRoute(request, reply)).toEqual({ kind: 'relay', relay: RELAY });
  });
});

describe('requete par adresse IP (§6.4, §6.4.1)', () => {
  it('une adresse que le serveur ne gere pas : DHCPLEASEUNKNOWN, sans autre option', () => {
    const reply = ask(server(), query({ ipAddress: '172.16.0.5' }))!;
    expect(reply.getMessageType()).toBe('DHCPLEASEUNKNOWN');
    expect(reply.getOptionCodes()).toEqual([DHCP_OPTION.MESSAGE_TYPE]);
  });

  it('une adresse geree sans bail : DHCPLEASEUNASSIGNED, ciaddr rempli, sans autre option', () => {
    const reply = ask(server(), query({ ipAddress: '10.0.0.50' }))!;
    expect(reply.getMessageType()).toBe('DHCPLEASEUNASSIGNED');
    expect(reply.ciaddr).toBe('10.0.0.50');
    expect(reply.getOptionCodes()).toEqual([DHCP_OPTION.MESSAGE_TYPE]);
  });

  it('une adresse exclue n est pas geree : DHCPLEASEUNKNOWN', () => {
    expect(ask(server(), query({ ipAddress: '10.0.0.5' }))!.getMessageType()).toBe('DHCPLEASEUNKNOWN');
  });

  it('une adresse louee : DHCPLEASEACTIVE avec ciaddr, chaddr et l option 91', () => {
    const s = server();
    const address = lease(s, MAC_A);
    const reply = ask(s, query({ ipAddress: address }))!;
    expect(reply.getMessageType()).toBe('DHCPLEASEACTIVE');
    expect(reply.ciaddr).toBe(address);
    expect(reply.chaddr.toLowerCase()).toBe(MAC_A);
    expect(reply.getOption(DHCP_OPTION.CLIENT_LAST_TRANSACTION_TIME)).toBeGreaterThanOrEqual(0);
  });

  it('l option 91 est un nombre de secondes dans le PASSE', () => {
    const s = server();
    const address = lease(s, MAC_A);
    s.setClock(() => Date.now() + 90_000);
    const seconds = ask(s, query({ ipAddress: address }))!.getOption(DHCP_OPTION.CLIENT_LAST_TRANSACTION_TIME) as number;
    expect(seconds).toBeGreaterThanOrEqual(89);
    expect(seconds).toBeLessThanOrEqual(92);
  });

  it('un bail expire : DHCPLEASEUNASSIGNED', () => {
    const s = server();
    const address = lease(s, MAC_A);
    s.setClock(() => Date.now() + 2 * 3600_000);
    expect(ask(s, query({ ipAddress: address }))!.getMessageType()).toBe('DHCPLEASEUNASSIGNED');
  });
});

describe('requete par MAC et par identifiant client (§6.4.1)', () => {
  it('par MAC : retrouve l adresse du client', () => {
    const s = server();
    const address = lease(s, MAC_A);
    const reply = ask(s, query({ hardwareAddress: MAC_A }))!;
    expect(reply.getMessageType()).toBe('DHCPLEASEACTIVE');
    expect(reply.ciaddr).toBe(address);
  });

  it('par MAC inconnue : DHCPLEASEUNKNOWN', () => {
    const s = server();
    lease(s, MAC_A);
    expect(ask(s, query({ hardwareAddress: MAC_B }))!.getMessageType()).toBe('DHCPLEASEUNKNOWN');
  });

  it('par identifiant client (option 61)', () => {
    const s = server();
    const address = lease(s, MAC_A, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01'));
    const reply = ask(s, query({ clientIdentifier: 'edge-01' }))!;
    expect(reply.getMessageType()).toBe('DHCPLEASEACTIVE');
    expect(reply.ciaddr).toBe(address);
  });

  it('un identifiant client inconnu : DHCPLEASEUNKNOWN', () => {
    const s = server();
    lease(s, MAC_A, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01'));
    expect(ask(s, query({ clientIdentifier: 'edge-02' }))!.getMessageType()).toBe('DHCPLEASEUNKNOWN');
  });

  it('plusieurs adresses pour un client : ciaddr = la plus recente, associated-ip les liste toutes', () => {
    const s = server();
    const first = lease(s, MAC_A, p => p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01'));
    let now = Date.now() + 60_000;
    s.setClock(() => now);
    const discover = DHCPPacket.createDiscover(MAC_A, 5);
    discover.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01');
    discover.setOption(DHCP_OPTION.REQUESTED_IP, '10.0.0.77');
    ask(s, discover);
    const second = DHCPPacket.createRequest(MAC_A, 6, '10.0.0.77', SERVER);
    second.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01');
    now += 1000;
    ask(s, second);
    const reply = ask(s, query({ hardwareAddress: MAC_A }))!;
    expect(reply.ciaddr).toBe('10.0.0.77');
    expect(new Set(reply.getOption(DHCP_OPTION.ASSOCIATED_IP) as string[])).toEqual(new Set([first, '10.0.0.77']));
  });

  it('un seul bail : pas d option 92', () => {
    const s = server();
    lease(s, MAC_A);
    expect(ask(s, query({ hardwareAddress: MAC_A }))!.getOption(DHCP_OPTION.ASSOCIATED_IP)).toBeUndefined();
  });
});

describe('options demandees (§6.4.2)', () => {
  it('bail restant si l option 51 est demandee', () => {
    const s = server();
    const address = lease(s, MAC_A);
    s.setClock(() => Date.now() + 600_000);
    const left = ask(s, query({ ipAddress: address, parameterRequestList: [51] }))!.getOption(51) as number;
    expect(left).toBeGreaterThan(2900);
    expect(left).toBeLessThanOrEqual(3000);
  });

  it('sans option 55 : pas de temps de bail', () => {
    const s = server();
    const address = lease(s, MAC_A);
    expect(ask(s, query({ ipAddress: address }))!.getOption(51)).toBeUndefined();
  });

  it('T1 est renvoye tant qu il n est pas passe, et omis apres', () => {
    const s = server();
    const address = lease(s, MAC_A);
    const before = ask(s, query({ ipAddress: address, parameterRequestList: [58] }))!;
    expect(before.getOption(58)).toBeGreaterThan(0);
    s.setClock(() => Date.now() + 2000_000);
    expect(ask(s, query({ ipAddress: address, parameterRequestList: [58] }))!.getOption(58)).toBeUndefined();
  });

  it('l identifiant client et l option 82 sont renvoyes quand ils sont demandes', () => {
    const s = server();
    const address = lease(s, MAC_A, p => {
      p.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, 'edge-01');
      p.setOption(82, { circuitId: 'Gi0/1', remoteId: 'R1' });
    });
    const reply = ask(s, query({ ipAddress: address, parameterRequestList: [61, 82] }))!;
    expect(reply.getOption(61)).toBe('edge-01');
    expect(reply.getOption(82)).toEqual({ circuitId: 'Gi0/1', remoteId: 'R1' });
  });

  it('une option « non sensible » configuree est renvoyee (DNS)', () => {
    const s = server();
    const address = lease(s, MAC_A);
    expect(ask(s, query({ ipAddress: address, parameterRequestList: [6] }))!.getOption(6)).toEqual(['8.8.8.8']);
  });

  it('une option retiree de la liste non sensible n est pas renvoyee meme si elle est demandee', () => {
    const s = server();
    s.setLeasequeryNonSensitiveOptions([1]);
    const address = lease(s, MAC_A);
    const reply = ask(s, query({ ipAddress: address, parameterRequestList: [1, 6] }))!;
    expect(reply.getOption(1)).toBe('255.255.255.0');
    expect(reply.getOption(6)).toBeUndefined();
  });
});


interface Requestor { readonly host: LinuxPC; readonly replies: DHCPPacket[] }

function requestor(host: LinuxPC): Requestor {
  const replies: DHCPPacket[] = [];
  host.udpBind(67, (delivery) => {
    const payload = (delivery as { udp: { payload: unknown } }).udp.payload;
    if (payload instanceof DHCPPacket && payload.op === 2) replies.push(payload);
  }, 'relay');
  return { host, replies };
}

function send(from: Requestor, to: string, packet: DHCPPacket): void {
  from.host.sendUdpDatagram(new IPAddress(to), 67, 67, packet, 300);
}

async function segment(server: LinuxServer | CiscoRouter, address: string) {
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const asker = new LinuxPC('linux-pc', 'RELAY');
  const port = server instanceof CiscoRouter ? server.getPort('GigabitEthernet0/0')! : server.getPorts()[0];
  new Cable('c1').connect(port, sw.getPorts()[0]);
  new Cable('c2').connect(pc.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(asker.getPorts()[0], sw.getPorts()[2]);
  asker.getPorts()[0].configureIP(new IPAddress('192.168.60.254'), new SubnetMask('255.255.255.0'));
  if (!(server instanceof CiscoRouter)) server.getPorts()[0].configureIP(new IPAddress(address), new SubnetMask('255.255.255.0'));
  server.powerOn?.();
  pc.powerOn();
  asker.powerOn();
  await pc.executeCommand('ip link set eth0 up');
  return { pc, asker: requestor(asker) };
}

const holder = async (pc: LinuxPC): Promise<string> =>
  /inet (\d+\.\d+\.\d+\.\d+)\//.exec(await pc.executeCommand('ip addr show eth0'))?.[1] ?? '';

describe('sur le fil : dhcpd Linux (`leasequery on;`)', () => {
  async function dhcpd(conf: string) {
    const srv = new LinuxServer('linux-server', 'SRV-DHCP');
    const lab = await segment(srv, '192.168.60.1');
    await srv.executeCommand(`printf '%s' ${JSON.stringify(conf)} > /etc/dhcp/dhcpd.conf`);
    await srv.executeCommand('systemctl start isc-dhcp-server');
    await lab.pc.executeCommand('dhclient eth0');
    return lab;
  }

  const CONF = 'authoritative;\ndefault-lease-time 600;\nsubnet 192.168.60.0 netmask 255.255.255.0 {\n  range 192.168.60.100 192.168.60.150;\n  option routers 192.168.60.254;\n}\n';

  it('TEMOIN : le client obtient un bail', async () => {
    const { pc } = await dhcpd(`leasequery on;\n${CONF}`);
    expect(await holder(pc)).toMatch(/^192\.168\.60\.1/);
  });

  it('un demandeur qui interroge par adresse recoit DHCPLEASEACTIVE, en unicast, sur le fil', async () => {
    const { pc, asker } = await dhcpd(`leasequery on;\n${CONF}`);
    const address = await holder(pc);
    send(asker, '192.168.60.1', DHCPPacket.createLeaseQuery({ giaddr: '192.168.60.254', ipAddress: address, parameterRequestList: [51] }, 5));
    const reply = asker.replies.find(r => r.xid === 5)!;
    expect(reply.getMessageType()).toBe('DHCPLEASEACTIVE');
    expect(reply.ciaddr).toBe(address);
    expect(reply.getOption(51)).toBeGreaterThan(0);
  });

  it('par MAC', async () => {
    const { pc, asker } = await dhcpd(`leasequery on;\n${CONF}`);
    const mac = pc.getPorts()[0].getMAC().toString();
    send(asker, '192.168.60.1', DHCPPacket.createLeaseQuery({ giaddr: '192.168.60.254', hardwareAddress: mac }, 6));
    expect(asker.replies.find(r => r.xid === 6)?.getMessageType()).toBe('DHCPLEASEACTIVE');
  });

  it('une adresse de la plage sans bail : DHCPLEASEUNASSIGNED', async () => {
    const { asker } = await dhcpd(`leasequery on;\n${CONF}`);
    send(asker, '192.168.60.1', DHCPPacket.createLeaseQuery({ giaddr: '192.168.60.254', ipAddress: '192.168.60.140' }, 7));
    expect(asker.replies.find(r => r.xid === 7)?.getMessageType()).toBe('DHCPLEASEUNASSIGNED');
  });

  it('sans `leasequery on;` : aucune reponse', async () => {
    const { pc, asker } = await dhcpd(CONF);
    send(asker, '192.168.60.1', DHCPPacket.createLeaseQuery({ giaddr: '192.168.60.254', ipAddress: await holder(pc) }, 8));
    expect(asker.replies.filter(r => r.xid === 8)).toEqual([]);
  });
});

describe('sur le fil : routeur Cisco (moteur commun, active par le moteur)', () => {
  it('le routeur repond DHCPLEASEACTIVE comme le dhcpd', async () => {
    const router = new CiscoRouter('R1');
    const lab = await segment(router, '192.168.60.1');
    for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 192.168.60.1 255.255.255.0', 'no shutdown', 'exit',
      'service dhcp', 'ip dhcp pool LAN', 'network 192.168.60.0 255.255.255.0', 'exit', 'ip dhcp excluded-address 192.168.60.1 192.168.60.99', 'end']) await router.executeCommand(line);
    (router as unknown as { dhcpServer: DHCPServer }).dhcpServer.setLeasequery(true);
    await lab.pc.executeCommand('dhclient eth0');
    const address = await holder(lab.pc);
    send(lab.asker, '192.168.60.1', DHCPPacket.createLeaseQuery({ giaddr: '192.168.60.254', ipAddress: address }, 9));
    const reply = lab.asker.replies.find(r => r.xid === 9);
    expect(reply?.getMessageType()).toBe('DHCPLEASEACTIVE');
    expect(reply?.ciaddr).toBe(address);
  });
});
