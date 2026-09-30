/*
 * RFC 8415 : Server Unicast (§21.12, §18.4), Information Refresh Time (§21.23,
 * §18.2.12), Reconfigure (§18.2.11, §18.3.11, §16.11) avec son authentification
 * RKAP (§20.4), et HOP_COUNT_LIMIT de la table du §7.6, dont la RFC fournie
 * dit qu'elle est passee de 32 a 8.
 *
 * Exigences : un serveur qui annonce Server Unicast accepte alors Request,
 * Renew, Release et Decline en unicast vers cette adresse et repond UseMulticast
 * a toute autre ; Solicit, Confirm, Rebind et Information-request unicast restent
 * ecartes. La reponse a un Information-request porte l'Information Refresh Time
 * seulement si l'ORO le demande, jamais sous IRT_MINIMUM (600 s), et le client
 * rafraichit a l'echeance, sauf pour l'infini (0xffffffff). Un serveur configure
 * pour Reconfigure et un client qui l'accepte echangent la cle RKAP dans le Reply ;
 * le Reconfigure est un HMAC-MD5 verifie par le client (serveur, client, cle,
 * message), declenche un Renew, un Rebind ou un Information-request, est repete
 * jusqu'a REC_MAX_RC (8) sans reponse et cesse des que le message attendu arrive.
 * Un relais ecarte un Relay-forward dont le hop-count atteint HOP_COUNT_LIMIT (8).
 *
 * Le codec sur octets, le HMAC calcule dessus, la retransmission temporisee et le
 * Reconfigure derriere un relais sont sondes dans
 * dhcpv6-rfc8415-fil-relais-temporisation.test.ts.
 *
 * Avant le correctif : aucune de ces options n'existait et la limite de relais
 * valait 32 : les 37 cas tombent (dont ceux qui importent les nouveaux modules), sauf le temoin nomme « temoin » qui passe sur l'ancien code ; mutations verifiees : verifyReconfigure toujours vrai fait tomber 2 cas, la limite de relais a 32 en fait tomber 2 (constante et hop-count 8).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { DHCPv6Server } from '@/network/dhcpv6/DHCPv6Server';
import {
  DHCPv6Packet, DHCPV6_STATUS, DHCPV6_OPTION, DHCPV6_IRT_INFINITY, DHCPV6_HOP_COUNT_LIMIT,
} from '@/network/dhcpv6/DHCPv6Packet';
import { buildDhcpv6ServerReply } from '@/network/dhcpv6/Dhcpv6ServerExchange';
import { buildReconfigure, verifyReconfigure } from '@/network/dhcpv6/Dhcpv6Reconfigure';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };

async function lab(extra: string[] = []) {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  await run(r1, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800',
    'dns-server 2001:4860:4860::8888', ...extra, 'exit',
    'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1', 'exit', 'end',
  ]);
  const server = r1._getDHCPv6ServerInternal();
  let now = 1_000_000;
  server.setClock(() => now);
  return { h1, r1, server, advance: (ms: number) => { now += ms; } };
}

function engine(): DHCPv6Server {
  const server = new DHCPv6Server();
  server.createPool('P');
  server.configurePoolPrefix('P', '2001:db8:9::', 64);
  server.configurePoolRanges('P', [{ startIp: '2001:db8:9::10', endIp: '2001:db8:9::20' }]);
  return server;
}

const CTX = { poolName: 'P', relayed: false, unicast: false } as const;
const UNI = (destination: string) => ({ poolName: 'P', relayed: false, unicast: true, destination }) as const;
const ia = (iaid: number, address?: string) => ({
  iaid, t1: 0, t2: 0, addresses: address ? [{ address, preferredLifetime: 0, validLifetime: 0 }] : [],
});

describe('temoin', () => {
  it('un client sans option particuliere obtient son bail comme avant', async () => {
    const { h1, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    expect(server.getBindings().length).toBe(1);
    expect(h1.getDhcpv6Lease('eth0')).toMatchObject({ serverUnicast: null, reconfigureKey: null });
  });
});

describe('Server Unicast (§21.12, §18.4)', () => {
  it('serveur configure : l Advertise et le Reply portent l adresse', () => {
    const server = engine();
    server.configurePoolServerUnicast('P', '2001:db8:9::1');
    const adv = buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    expect(adv.serverUnicast).toBe('2001:db8:9::1');
  });

  it('serveur non configure : pas d option', () => {
    const adv = buildDhcpv6ServerReply(engine(), DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    expect(adv.serverUnicast).toBeNull();
  });

  it('un Request unicast vers l adresse annoncee est servi', () => {
    const server = engine();
    server.configurePoolServerUnicast('P', '2001:db8:9::1');
    const adv = buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    const request = DHCPv6Packet.createClientMessage('REQUEST', 'c1', server.getServerDuid(), 2, adv.ias);
    const reply = buildDhcpv6ServerReply(server, request, UNI('2001:db8:9::1'))!;
    expect(reply.ias[0].addresses.length).toBe(1);
    expect(reply.statusCode).toBeNull();
  });

  it('un Request unicast vers une autre adresse : UseMulticast', () => {
    const server = engine();
    server.configurePoolServerUnicast('P', '2001:db8:9::1');
    const request = DHCPv6Packet.createClientMessage('REQUEST', 'c1', server.getServerDuid(), 2, [ia(1)]);
    expect(buildDhcpv6ServerReply(server, request, UNI('2001:db8:9::77'))!.statusCode).toBe(DHCPV6_STATUS.UseMulticast);
  });

  it('serveur non configure : le meme Request unicast recoit UseMulticast', () => {
    const server = engine();
    const request = DHCPv6Packet.createClientMessage('REQUEST', 'c1', server.getServerDuid(), 2, [ia(1)]);
    expect(buildDhcpv6ServerReply(server, request, UNI('2001:db8:9::1'))!.statusCode).toBe(DHCPV6_STATUS.UseMulticast);
  });

  it('Solicit, Confirm, Rebind, Information-request unicast restent ecartes meme configure', () => {
    const server = engine();
    server.configurePoolServerUnicast('P', '2001:db8:9::1');
    const ctx = UNI('2001:db8:9::1');
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c1', 1, 1), ctx)).toBeNull();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createClientMessage('CONFIRM', 'c1', null, 1, [ia(1, '2001:db8:9::10')]), ctx)).toBeNull();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createClientMessage('REBIND', 'c1', null, 1, [ia(1, '2001:db8:9::10')]), ctx)).toBeNull();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createInformationRequest('c1', 1), ctx)).toBeNull();
  });

  it('sur le fil : le client renouvelle en unicast vers l adresse annoncee', async () => {
    const { h1, server } = await lab();
    server.configurePoolServerUnicast('POOL1', '2001:db8:1::1');
    await h1.executeCommand('dhclient -6 eth0');
    expect(h1.getDhcpv6Lease('eth0')?.serverUnicast).toBe('2001:db8:1::1');
    const destinations: string[] = [];
    h1.getPort('eth0')!.attachTap(({ frame, direction }) => {
      const ip = frame.payload as { destinationIP?: { toString(): string }; payload?: { payload?: unknown } };
      const message = ip.payload?.payload;
      if (direction === 'out' && message instanceof DHCPv6Packet && message.msgType === 'RENEW') destinations.push(String(ip.destinationIP));
    });
    expect(h1.renewDhcpv6Lease('eth0')).toBe('extended');
    expect(destinations).toEqual(['2001:db8:1::1']);
  });

  it('sans Server Unicast, le renouvellement part en multicast', async () => {
    const { h1 } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    const destinations: string[] = [];
    h1.getPort('eth0')!.attachTap(({ frame, direction }) => {
      const ip = frame.payload as { destinationIP?: { toString(): string }; payload?: { payload?: unknown } };
      const message = ip.payload?.payload;
      if (direction === 'out' && message instanceof DHCPv6Packet && message.msgType === 'RENEW') destinations.push(String(ip.destinationIP));
    });
    h1.renewDhcpv6Lease('eth0');
    expect(destinations).toEqual(['ff02::1:2']);
  });
});

describe('Information Refresh Time (§21.23, §18.2.12)', () => {
  const info = (oro: number[] | null) => {
    const request = DHCPv6Packet.createInformationRequest('c1', 5);
    request.optionRequest = oro;
    return request;
  };

  it('demandee dans l ORO : valeur du pool', () => {
    const server = engine();
    server.configurePoolInformationRefresh('P', 7200);
    const reply = buildDhcpv6ServerReply(server, info([23, 24, DHCPV6_OPTION.INFORMATION_REFRESH_TIME]), CTX)!;
    expect(reply.informationRefreshTime).toBe(7200);
  });

  it('non demandee : absente', () => {
    expect(buildDhcpv6ServerReply(engine(), info([23]), CTX)!.informationRefreshTime).toBeNull();
    expect(buildDhcpv6ServerReply(engine(), info(null), CTX)!.informationRefreshTime).toBeNull();
  });

  it('jamais sous IRT_MINIMUM', () => {
    const server = engine();
    server.configurePoolInformationRefresh('P', 30);
    expect(buildDhcpv6ServerReply(server, info([32]), CTX)!.informationRefreshTime).toBe(600);
  });

  it('valeur par defaut IRT_DEFAULT : 86400', () => {
    expect(buildDhcpv6ServerReply(engine(), info([32]), CTX)!.informationRefreshTime).toBe(86400);
  });

  it('l infini est conserve', () => {
    const server = engine();
    server.configurePoolInformationRefresh('P', DHCPV6_IRT_INFINITY);
    expect(buildDhcpv6ServerReply(server, info([32]), CTX)!.informationRefreshTime).toBe(DHCPV6_IRT_INFINITY);
  });

  it('un Reply de bail (non Information-request) n en porte pas', () => {
    const adv = buildDhcpv6ServerReply(engine(), DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    expect(adv.informationRefreshTime).toBeNull();
  });

  it('le client rafraichit a l echeance annoncee', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { h1, server } = await lab(['information refresh 0 0 20']);
    (h1 as unknown as { getScheduler: () => VirtualTimeScheduler }).getScheduler = () => scheduler;
    expect(server.getPool('POOL1')!.informationRefreshTime).toBe(1200);
    h1.requestDhcpv6Information('eth0');
    expect(h1.getDhcpv6Information('eth0')?.refreshSeconds).toBe(1200);
    server.configurePoolDns('POOL1', ['2001:db8:53::1']);
    scheduler.advance(1199 * 1000);
    expect(await h1.executeCommand('cat /etc/resolv.conf')).not.toContain('2001:db8:53::1');
    scheduler.advance(2 * 1000);
    expect(await h1.executeCommand('cat /etc/resolv.conf')).toContain('2001:db8:53::1');
  });

  it('l infini : aucun rafraichissement', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { h1, server } = await lab(['information refresh infinity']);
    (h1 as unknown as { getScheduler: () => VirtualTimeScheduler }).getScheduler = () => scheduler;
    h1.requestDhcpv6Information('eth0');
    server.configurePoolDns('POOL1', ['2001:db8:53::9']);
    scheduler.advance(400 * 86400 * 1000);
    expect(await h1.executeCommand('cat /etc/resolv.conf')).not.toContain('2001:db8:53::9');
  });

  it('Cisco : information refresh est rendu dans show running-config', async () => {
    const { r1 } = await lab(['information refresh 1 2 3']);
    expect(await r1.executeCommand('show running-config')).toContain(' information refresh 1 2 3');
  });

  it('Cisco : une valeur hors bornes est refusee', async () => {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const r1 = new CiscoRouter('R1');
    new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    await run(r1, ['enable', 'configure terminal', 'ipv6 dhcp pool P1']);
    expect(await r1.executeCommand('information refresh 0 99')).toContain('Invalid input');
  });
});

describe('Reconfigure : cle RKAP (§20.4)', () => {
  const accepting = (server: DHCPv6Server, duid = 'c1') => {
    const solicit = DHCPv6Packet.createSolicit(duid, 1, 1);
    solicit.reconfigureAccept = true;
    const adv = buildDhcpv6ServerReply(server, solicit, CTX)!;
    const request = DHCPv6Packet.createClientMessage('REQUEST', duid, server.getServerDuid(), 2, adv.ias);
    request.reconfigureAccept = true;
    return { adv, reply: buildDhcpv6ServerReply(server, request, CTX)! };
  };

  it('serveur configure et client d accord : Reconfigure Accept, cle de 16 octets dans le Reply seulement', () => {
    const server = engine();
    server.configurePoolReconfigure('P', true);
    const { adv, reply } = accepting(server);
    expect(adv.reconfigureAccept).toBe(true);
    expect(adv.authentication).toBeNull();
    expect(reply.authentication).toMatchObject({ protocol: 3, algorithm: 1, rdm: 0, type: 1 });
    expect(reply.authentication!.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('la cle est stable pour un client et differente d un client a l autre', () => {
    const server = engine();
    server.configurePoolReconfigure('P', true);
    const first = accepting(server, 'c1').reply.authentication!.value;
    expect(accepting(server, 'c1').reply.authentication!.value).toBe(first);
    expect(accepting(server, 'c2').reply.authentication!.value).not.toBe(first);
  });

  it('serveur non configure : ni option ni cle', () => {
    const { reply } = accepting(engine());
    expect(reply.reconfigureAccept).toBe(false);
    expect(reply.authentication).toBeNull();
  });

  it('client qui n accepte pas : pas de cle, pas de Reconfigure possible', () => {
    const server = engine();
    server.configurePoolReconfigure('P', true);
    const solicit = DHCPv6Packet.createSolicit('c1', 1, 1);
    const adv = buildDhcpv6ServerReply(server, solicit, CTX)!;
    const request = DHCPv6Packet.createClientMessage('REQUEST', 'c1', server.getServerDuid(), 2, adv.ias);
    expect(buildDhcpv6ServerReply(server, request, CTX)!.authentication).toBeNull();
    expect(buildReconfigure(server, 'c1', 'RENEW')).toBeNull();
  });

  it('le Reconfigure porte serveur, client, type et un HMAC qui se verifie avec la cle et pas avec une autre', () => {
    const server = engine();
    server.configurePoolReconfigure('P', true);
    const { reply } = accepting(server);
    const message = buildReconfigure(server, 'c1', 'RENEW')!;
    expect(message).toMatchObject({ msgType: 'RECONFIGURE', transactionId: 0, clientDuid: 'c1', reconfigureMessage: 'RENEW' });
    expect(message.authentication).toMatchObject({ type: 2 });
    expect(verifyReconfigure(message, reply.authentication!.value)).toBe(true);
    expect(verifyReconfigure(message, 'ab'.repeat(16))).toBe(false);
    const other = buildReconfigure(server, 'c1', 'REBIND')!;
    expect(other.authentication!.value).not.toBe(message.authentication!.value);
  });

  it('un Reconfigure recu par un serveur est ecarte (§16.11)', () => {
    const server = engine();
    server.configurePoolReconfigure('P', true);
    accepting(server);
    expect(buildDhcpv6ServerReply(server, buildReconfigure(server, 'c1', 'RENEW')!, CTX)).toBeNull();
  });
});

describe('Reconfigure sur le fil', () => {
  async function enrolled() {
    const l = await lab();
    l.server.configurePoolReconfigure('POOL1', true);
    await l.h1.executeCommand('dhclient -6 eth0');
    return l;
  }

  it('le client garde la cle recue dans le Reply', async () => {
    const { h1 } = await enrolled();
    expect(h1.getDhcpv6Lease('eth0')?.reconfigureKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('Reconfigure Renew : le client renouvelle et le serveur prolonge le bail', async () => {
    const { h1, r1, server, advance } = await enrolled();
    const before = server.getBindings()[0].leaseExpiration;
    advance(1_000_000);
    const duid = server.getBindings()[0].clientDuid;
    expect(r1.sendDhcpv6Reconfigure(duid, 'RENEW')).toBe(true);
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 1, discarded: 0 });
    expect(server.getBindings()[0].leaseExpiration).toBeGreaterThan(before);
    expect(server.pendingReconfigure(duid)).toBeNull();
  });

  it('Reconfigure Rebind : le client fait un Rebind', async () => {
    const { h1, r1, server, advance } = await enrolled();
    const before = server.getBindings()[0].leaseExpiration;
    advance(1_000_000);
    r1.sendDhcpv6Reconfigure(server.getBindings()[0].clientDuid, 'REBIND');
    expect(h1.getDhcpv6ReconfigureCounters().accepted).toBe(1);
    expect(server.getBindings()[0].leaseExpiration).toBeGreaterThan(before);
  });

  it('Reconfigure Information-request : un client sans bail recharge sa configuration', async () => {
    const { h1, r1, server } = await lab();
    server.configurePoolReconfigure('POOL1', true);
    h1.requestDhcpv6Information('eth0');
    server.configurePoolDns('POOL1', ['2001:db8:53::7']);
    const duid = `00:03:00:01:${h1.getPort('eth0')!.getMAC().toString()}`;
    expect(r1.sendDhcpv6Reconfigure(duid, 'INFORMATION-REQUEST')).toBe(true);
    expect(await h1.executeCommand('cat /etc/resolv.conf')).toContain('2001:db8:53::7');
  });

  it('cle alteree cote serveur : le client ecarte, le bail n est pas prolonge', async () => {
    const { h1, r1, server, advance } = await enrolled();
    const duid = server.getBindings()[0].clientDuid;
    (server as unknown as { reconfigureKeys: Map<string, string> }).reconfigureKeys.set(duid, 'cd'.repeat(16));
    const before = server.getBindings()[0].leaseExpiration;
    advance(1_000_000);
    r1.sendDhcpv6Reconfigure(duid, 'RENEW');
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 0, discarded: 1 });
    expect(server.getBindings()[0].leaseExpiration).toBe(before);
    expect(server.pendingReconfigure(duid)).toBe('RENEW');
  });

  it('serveur non configure pour Reconfigure : aucune emission', async () => {
    const { h1, r1, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    expect(r1.sendDhcpv6Reconfigure(server.getBindings()[0].clientDuid, 'RENEW')).toBe(false);
  });

  it('un serveur qui n a pas la cle du client ne peut pas forger de Reconfigure', async () => {
    const { h1, server } = await enrolled();
    const duid = server.getBindings()[0].clientDuid;
    const rogue = new DHCPv6Server();
    rogue.createPool('X');
    rogue.configurePoolReconfigure('X', true);
    const request = DHCPv6Packet.createSolicit(duid, 1, 1);
    request.reconfigureAccept = true;
    buildDhcpv6ServerReply(rogue, request, { poolName: 'X', relayed: false, unicast: false });
    const forged = buildReconfigure(rogue, duid, 'RENEW');
    expect(forged).toBeNull();
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 0, discarded: 0 });
  });
});

describe('Server Unicast et Information Refresh sur les serveurs d hote', () => {
  it('dhcpd -6 : option dhcp6.unicast et dhcp6.info-refresh-time', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    const c1 = new LinuxPC('linux-pc', 'C1');
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
    new Cable('b').connect(c1.getPorts()[0], sw.getPorts()[1]);
    srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].enableIPv6();
    srv.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:1::1'), 64);
    const conf = 'option dhcp6.unicast 2001:db8:1::1;\noption dhcp6.info-refresh-time 1800;\nsubnet6 2001:db8:1::/64 { range6 2001:db8:1::100 2001:db8:1::110; }\n';
    await srv.executeCommand(`printf '%s' ${JSON.stringify(conf)} > /etc/dhcp/dhcpd6.conf`);
    await srv.executeCommand('printf \'INTERFACESv6="eth0"\\n\' > /etc/default/isc-dhcp-server');
    await srv.executeCommand('systemctl start isc-dhcp-server6');
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')?.serverUnicast).toBe('2001:db8:1::1');
    c1.requestDhcpv6Information('eth0');
    expect(c1.getDhcpv6Information('eth0')?.refreshSeconds).toBe(1800);
  });

  it('Windows : options 12 et 32', async () => {
    const dhcp = new WindowsServer('DHCP1');
    const c1 = new LinuxPC('linux-pc', 'C1');
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('a').connect(dhcp.getPorts()[0], sw.getPorts()[0]);
    new Cable('b').connect(c1.getPorts()[0], sw.getPorts()[1]);
    dhcp.getPorts()[0].enableIPv6();
    dhcp.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:1::10'), 64);
    dhcp.setCurrentUser('Administrator');
    const shell = PowerShellSubShell.create(dhcp).subShell;
    const ps = async (line: string) => (await shell.processLine(line)).output.join('\n');
    await ps('Install-WindowsFeature DHCP');
    await ps('Add-DhcpServerv6Scope -Prefix 2001:db8:1:: -Name LAN6');
    await ps('Set-DhcpServerv6OptionValue -Prefix 2001:db8:1:: -OptionId 12 -Value 2001:db8:1::10');
    await ps('Set-DhcpServerv6OptionValue -Prefix 2001:db8:1:: -OptionId 32 -Value 900');
    expect(await ps('Set-DhcpServerv6OptionValue -OptionId 32 -Value soon')).toMatch(/number of seconds/i);
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')?.serverUnicast).toBe('2001:db8:1::10');
    c1.requestDhcpv6Information('eth0');
    expect(c1.getDhcpv6Information('eth0')?.refreshSeconds).toBe(900);
  });
});

describe('HOP_COUNT_LIMIT (§7.6, §19.1.1)', () => {
  async function relayLab() {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const relay = new CiscoRouter('RELAY');
    const server = new CiscoRouter('SERVER');
    new Cable('a').connect(h1.getPort('eth0')!, relay.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(relay.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
    await run(relay, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
      'ipv6 dhcp relay destination 2001:db8:99::2', 'exit',
      'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:99::1/64', 'no shutdown', 'exit', 'end',
    ]);
    await run(server, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:99::2/64', 'no shutdown', 'exit', 'end',
    ]);
    return { h1, relay, server };
  }

  const forwardsSeenBy = async (hopCount: number) => {
    const { h1, server } = await relayLab();
    h1.getPort('eth0')!.enableIPv6();
    h1.getPort('eth0')!.configureIPv6(new IPv6Address('2001:db8:1::50'), 64);
    await h1.executeCommand('ping -6 -c 1 2001:db8:1::1');
    const seen: number[] = [];
    server.getPort('GigabitEthernet0/0')!.attachTap(({ frame, direction }) => {
      const message = (frame.payload as { payload?: { payload?: unknown } }).payload?.payload;
      if (direction === 'in' && message instanceof DHCPv6Packet && message.msgType === 'RELAY-FORW') seen.push(message.hopCount);
    });
    const inner = DHCPv6Packet.createSolicit('00:03:00:01:02:00:00:00:00:99', 1, 3);
    const forward = DHCPv6Packet.createRelayForw('2001:db8:5::1', 'fe80::1', hopCount, 'x', inner);
    h1.sendUdpDatagram6(new IPv6Address('2001:db8:1::1'), 547, 547, forward, 300);
    return seen;
  };

  it('la constante vaut 8 dans la RFC fournie', () => {
    expect(DHCPV6_HOP_COUNT_LIMIT).toBe(8);
  });

  it('hop-count 7 : le relais retransmet avec 8', async () => {
    expect(await forwardsSeenBy(7)).toEqual([8]);
  });

  it('hop-count 8 : le relais ecarte', async () => {
    expect(await forwardsSeenBy(8)).toEqual([]);
  });
});
