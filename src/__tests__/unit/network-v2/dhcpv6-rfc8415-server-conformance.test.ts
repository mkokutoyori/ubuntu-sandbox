/*
 * RFC 8415 (docs/rfc/dhcp/rfc8415.txt) : conformance du serveur DHCPv6 commun
 * (DHCPv6Server + buildDhcpv6ServerReply, appele par le plan de donnees IPv6 des
 * routeurs Cisco/Huawei et du FortiGate).
 *
 * Exigences : §16 (validation : identifiants serveur/client, Solicit avec
 * Server-ID ecarte, Request/Renew/Release/Decline vers un autre serveur ecartes),
 * §18.3.1 (Rapid Commit : Solicit -> Reply, deux messages), §18.3.2 (Request :
 * NoAddrsAvail dans l'IA quand rien n'est attribuable, NotOnLink), §18.3.3
 * (Confirm : Success ou NotOnLink), §18.3.4 (Renew : durees renouvelees,
 * NoBinding sinon), §18.3.5 (Rebind), §18.3.7 (Release : Reply Success), §18.3.8
 * (Decline : adresse retiree du pool), §18.3.9 (Advertise avec IA_PD, statut
 * NoPrefixAvail), §18.4 (unicast : UseMulticast pour Request/Renew/Release/
 * Decline, ecart silencieux pour Solicit/Confirm/Rebind/Information-request),
 * §21.7 (ORO), T1/T2 identiques sur toutes les IA.
 *
 * Avant le correctif : buildDhcpv6ServerReply, l'IA_PD, Rapid Commit, les statuts
 * et l'API client (renew/rebind/confirm/release/decline) n'existaient pas : les
 * 47 cas tombent (le module est introuvable). Les temoins (« temoin : ... »,
 * Solicit/Request nominal) passent sur l'ancien moteur : les 27 cas des
 * dhcpv6-*.test.ts existants restent verts. Mutation : retirer le controle
 * du Server-ID et la regle UseMulticast fait tomber les cas §16 et §18.4.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DHCPv6Server } from '@/network/dhcpv6/DHCPv6Server';
import { DHCPv6Packet, DHCPV6_STATUS } from '@/network/dhcpv6/DHCPv6Packet';
import { buildDhcpv6ServerReply } from '@/network/dhcpv6/Dhcpv6ServerExchange';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function lab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const h2 = new LinuxPC('linux-pc', 'H2');
  const r1 = new CiscoRouter('R1');
  const sw = new CiscoRouter('R2');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(h2.getPort('eth0')!, r1.getPort('GigabitEthernet0/1')!);
  void sw;
  await run(r1, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:1::2/64', 'no shutdown', 'exit',
    'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800',
    'dns-server 2001:4860:4860::8888', 'domain-name test.lab', 'exit',
    'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 dhcp server POOL1', 'exit', 'end',
  ]);
  const server = r1._getDHCPv6ServerInternal();
  let now = 1_000_000;
  server.setClock(() => now);
  return { h1, h2, r1, server, advance: (ms: number) => { now += ms; } };
}

function engine(): DHCPv6Server {
  const server = new DHCPv6Server();
  server.enable();
  server.createPool('P');
  server.configurePoolPrefix('P', '2001:db8:9::', 64);
  server.configurePoolRanges('P', [{ startIp: '2001:db8:9::10', endIp: '2001:db8:9::11' }]);
  server.configurePoolDns('P', ['2001:db8::53']);
  server.configurePoolDomain('P', 'lab.test');
  server.configurePoolLifetime('P', 1000, 2000);
  return server;
}

const OWN = () => engine().getServerDuid();
const CTX = { poolName: 'P', relayed: false, unicast: false } as const;

function bind(server: DHCPv6Server, duid: string, iaid: number): string {
  const s = DHCPv6Packet.createSolicit(duid, iaid, 1);
  const adv = buildDhcpv6ServerReply(server, s, CTX)!;
  const address = adv.ias[0].addresses[0].address;
  const r = DHCPv6Packet.createClientMessage('REQUEST', duid, server.getServerDuid(), 1, [{ iaid, t1: 0, t2: 0, addresses: [{ address, preferredLifetime: 0, validLifetime: 0 }] }]);
  buildDhcpv6ServerReply(server, r, CTX);
  return address;
}

const ia = (iaid: number, address?: string) => ({
  iaid, t1: 0, t2: 0,
  addresses: address ? [{ address, preferredLifetime: 0, validLifetime: 0 }] : [],
});

describe('§16 validation des messages', () => {
  it('un Solicit portant un Server-ID est ecarte', () => {
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.serverDuid = OWN();
    expect(buildDhcpv6ServerReply(engine(), s, CTX)).toBeNull();
  });

  it('un Solicit sans Client-ID est ecarte', () => {
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.clientDuid = null;
    expect(buildDhcpv6ServerReply(engine(), s, CTX)).toBeNull();
  });

  it('un Request pour un autre serveur est ecarte', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('REQUEST', 'c1', '00:03:00:01:aa:aa:aa:aa:aa:aa', 1, [ia(1, '2001:db8:9::10')]);
    expect(buildDhcpv6ServerReply(server, r, CTX)).toBeNull();
  });

  it('un Renew sans Server-ID est ecarte', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('RENEW', 'c1', null, 1, [ia(1, '2001:db8:9::10')]);
    expect(buildDhcpv6ServerReply(server, r, CTX)).toBeNull();
  });

  it('un Confirm portant un Server-ID est ecarte', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('CONFIRM', 'c1', server.getServerDuid(), 1, [ia(1, '2001:db8:9::10')]);
    expect(buildDhcpv6ServerReply(server, r, CTX)).toBeNull();
  });

  it('un Information-request avec IA est ecarte', () => {
    const r = DHCPv6Packet.createInformationRequest('c1', 1);
    r.ias = [ia(1)];
    expect(buildDhcpv6ServerReply(engine(), r, CTX)).toBeNull();
  });
});

describe('§18.4 messages recus en unicast', () => {
  const unicast = { poolName: 'P', relayed: false, unicast: true } as const;

  it('Request/Renew/Release/Decline unicast : Reply UseMulticast sans autre option', () => {
    const server = engine();
    for (const type of ['REQUEST', 'RENEW', 'RELEASE', 'DECLINE'] as const) {
      const msg = DHCPv6Packet.createClientMessage(type, 'c1', server.getServerDuid(), 7, [ia(1, '2001:db8:9::10')]);
      const reply = buildDhcpv6ServerReply(server, msg, unicast)!;
      expect(reply.msgType, type).toBe('REPLY');
      expect(reply.statusCode, type).toBe(DHCPV6_STATUS.UseMulticast);
      expect(reply.ias, type).toEqual([]);
      expect(reply.dnsServers, type).toEqual([]);
    }
    expect(server.getBindings()).toEqual([]);
  });

  it('Solicit/Confirm/Rebind/Information-request unicast : ecartes en silence', () => {
    const server = engine();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c1', 1, 1), unicast)).toBeNull();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createClientMessage('CONFIRM', 'c1', null, 1, [ia(1, '2001:db8:9::10')]), unicast)).toBeNull();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createClientMessage('REBIND', 'c1', null, 1, [ia(1, '2001:db8:9::10')]), unicast)).toBeNull();
    expect(buildDhcpv6ServerReply(server, DHCPv6Packet.createInformationRequest('c1', 1), unicast)).toBeNull();
  });

  it('temoin : le meme Request en multicast est servi', () => {
    const server = engine();
    const address = bind(server, 'c1', 1);
    expect(server.getBindings().map(b => b.address)).toEqual([address]);
  });
});

describe('§18.3.2 Request / §18.3.9 Advertise : statuts dans l IA', () => {
  it('pool epuise : Advertise avec IA sans adresse et statut NoAddrsAvail', () => {
    const server = engine();
    bind(server, 'c1', 1);
    bind(server, 'c2', 1);
    const adv = buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c3', 1, 5), CTX)!;
    expect(adv.msgType).toBe('ADVERTISE');
    expect(adv.ias[0].addresses).toEqual([]);
    expect(adv.ias[0].statusCode).toBe(DHCPV6_STATUS.NoAddrsAvail);
  });

  it('Request pour une adresse hors du lien : IA en NotOnLink', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('REQUEST', 'c1', server.getServerDuid(), 1, [ia(1, '2001:db8:77::5')]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.ias[0].statusCode).toBe(DHCPV6_STATUS.NotOnLink);
    expect(reply.ias[0].addresses).toEqual([]);
  });

  it('plusieurs IA_NA dans un meme Solicit : une adresse distincte par IA', () => {
    const server = engine();
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.ias = [ia(1), ia(2)];
    const adv = buildDhcpv6ServerReply(server, s, CTX)!;
    const addresses = adv.ias.map(x => x.addresses[0].address);
    expect(new Set(addresses).size).toBe(2);
    expect(adv.ias.map(x => x.iaid)).toEqual([1, 2]);
  });

  it('T1/T2 identiques sur toutes les IA : 0,5 et 0,8 de la duree preferee', () => {
    const server = engine();
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.ias = [ia(1), ia(2)];
    const adv = buildDhcpv6ServerReply(server, s, CTX)!;
    expect(adv.ias.map(x => [x.t1, x.t2])).toEqual([[500, 800], [500, 800]]);
  });
});

describe('§21.7 Option Request', () => {
  it('sans DNS dans l ORO, ni DNS ni domaine n est renvoye', () => {
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.optionRequest = [];
    const adv = buildDhcpv6ServerReply(engine(), s, CTX)!;
    expect(adv.dnsServers).toEqual([]);
    expect(adv.domainList).toEqual([]);
  });

  it('avec 23 et 24 dans l ORO : DNS et domaine', () => {
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.optionRequest = [23, 24];
    const adv = buildDhcpv6ServerReply(engine(), s, CTX)!;
    expect(adv.dnsServers).toEqual(['2001:db8::53']);
    expect(adv.domainList).toEqual(['lab.test']);
  });

  it('temoin : sans ORO, les options configurees sont renvoyees', () => {
    const adv = buildDhcpv6ServerReply(engine(), DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    expect(adv.dnsServers).toEqual(['2001:db8::53']);
  });
});

describe('identifiant client', () => {
  it('un DUID en majuscules designe le meme client que sa forme minuscule, la reponse rend la forme recue', () => {
    const server = engine();
    const lower = bind(server, '00:03:00:01:aa:bb:cc:dd:ee:ff', 1);
    const upper = buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('00:03:00:01:AA:BB:CC:DD:EE:FF', 1, 9), CTX)!;
    expect(upper.ias[0].addresses[0].address).toBe(lower);
    expect(upper.clientDuid).toBe('00:03:00:01:AA:BB:CC:DD:EE:FF');
  });
});

describe('§18.3.4 Renew / §18.3.5 Rebind', () => {
  it('Renew : les durees repartent de l instant du Renew', () => {
    const server = engine();
    let now = 5_000;
    server.setClock(() => now);
    const address = bind(server, 'c1', 1);
    now = 900_000;
    const r = DHCPv6Packet.createClientMessage('RENEW', 'c1', server.getServerDuid(), 2, [ia(1, address)]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.ias[0].addresses[0]).toMatchObject({ address, preferredLifetime: 1000, validLifetime: 2000 });
    expect(server.getBindings()[0].leaseExpiration).toBe(900_000 + 2_000_000);
  });

  it('Renew d une IA sans binding : IA en NoBinding', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('RENEW', 'c1', server.getServerDuid(), 2, [ia(9, '2001:db8:9::10')]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.ias[0].statusCode).toBe(DHCPV6_STATUS.NoBinding);
  });

  it('Rebind d une IA connue : durees prolongees, sans Server-ID', () => {
    const server = engine();
    const address = bind(server, 'c1', 1);
    const r = DHCPv6Packet.createClientMessage('REBIND', 'c1', null, 3, [ia(1, address)]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.ias[0].addresses[0].address).toBe(address);
    expect(reply.ias[0].addresses[0].validLifetime).toBe(2000);
  });

  it('Rebind d une IA inconnue dont l adresse est encore sur le lien : aucune reponse', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('REBIND', 'c1', null, 3, [ia(1, '2001:db8:9::10')]);
    expect(buildDhcpv6ServerReply(server, r, CTX)).toBeNull();
  });

  it('Rebind d une IA inconnue dont l adresse a quitte le lien : duree 0', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('REBIND', 'c1', null, 3, [ia(1, '2001:db8:66::10')]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.ias[0].addresses[0]).toMatchObject({ address: '2001:db8:66::10', validLifetime: 0, preferredLifetime: 0 });
  });
});

describe('§18.3.3 Confirm', () => {
  it('adresses sur le lien : Success', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('CONFIRM', 'c1', null, 4, [ia(1, '2001:db8:9::10')]);
    expect(buildDhcpv6ServerReply(server, r, CTX)!.statusCode).toBe(DHCPV6_STATUS.Success);
  });

  it('adresse hors du lien : NotOnLink', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('CONFIRM', 'c1', null, 4, [ia(1, '2001:db8:66::10')]);
    expect(buildDhcpv6ServerReply(server, r, CTX)!.statusCode).toBe(DHCPV6_STATUS.NotOnLink);
  });

  it('sans adresse dans les IA : aucune reponse', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('CONFIRM', 'c1', null, 4, [ia(1)]);
    expect(buildDhcpv6ServerReply(server, r, CTX)).toBeNull();
  });

  it('serveur sans prefixe connu : aucune reponse (test impossible)', () => {
    const server = new DHCPv6Server();
    server.createPool('P');
    const r = DHCPv6Packet.createClientMessage('CONFIRM', 'c1', null, 4, [ia(1, '2001:db8:9::10')]);
    expect(buildDhcpv6ServerReply(server, r, { poolName: 'P', relayed: false, unicast: false })).toBeNull();
  });
});

describe('§18.3.7 Release / §18.3.8 Decline', () => {
  it('Release : Reply Success et adresse rendue au pool', () => {
    const server = engine();
    const address = bind(server, 'c1', 1);
    const r = DHCPv6Packet.createClientMessage('RELEASE', 'c1', server.getServerDuid(), 5, [ia(1, address)]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.msgType).toBe('REPLY');
    expect(reply.statusCode).toBe(DHCPV6_STATUS.Success);
    expect(reply.ias).toEqual([]);
    expect(server.getBindings()).toEqual([]);
  });

  it('Release d une IA sans binding : Success et IA en NoBinding', () => {
    const server = engine();
    const r = DHCPv6Packet.createClientMessage('RELEASE', 'c1', server.getServerDuid(), 5, [ia(4, '2001:db8:9::10')]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.statusCode).toBe(DHCPV6_STATUS.Success);
    expect(reply.ias[0]).toMatchObject({ iaid: 4, statusCode: DHCPV6_STATUS.NoBinding });
  });

  it('Decline : Reply Success, binding supprime, adresse marquee et jamais reattribuee', () => {
    const server = engine();
    const address = bind(server, 'c1', 1);
    const r = DHCPv6Packet.createClientMessage('DECLINE', 'c1', server.getServerDuid(), 6, [ia(1, address)]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.statusCode).toBe(DHCPV6_STATUS.Success);
    expect(server.getBindings()).toEqual([]);
    expect(server.getDeclinedAddresses()).toEqual([address]);
    const other = bind(server, 'c2', 1);
    expect(other).not.toBe(address);
  });

  it('un autre client ne peut pas liberer le binding', () => {
    const server = engine();
    const address = bind(server, 'c1', 1);
    const r = DHCPv6Packet.createClientMessage('RELEASE', 'c2', server.getServerDuid(), 5, [ia(1, address)]);
    const reply = buildDhcpv6ServerReply(server, r, CTX)!;
    expect(reply.ias[0].statusCode).toBe(DHCPV6_STATUS.NoBinding);
    expect(server.getBindings().length).toBe(1);
  });
});

describe('§18.3.1 Rapid Commit', () => {
  it('serveur configure : Solicit avec Rapid Commit recoit un Reply engage', () => {
    const server = engine();
    server.configurePoolRapidCommit('P', true);
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.rapidCommit = true;
    const reply = buildDhcpv6ServerReply(server, s, CTX)!;
    expect(reply.msgType).toBe('REPLY');
    expect(reply.rapidCommit).toBe(true);
    expect(server.getBindings().length).toBe(1);
  });

  it('serveur non configure : Rapid Commit ignore, Advertise sans engagement', () => {
    const server = engine();
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.rapidCommit = true;
    const adv = buildDhcpv6ServerReply(server, s, CTX)!;
    expect(adv.msgType).toBe('ADVERTISE');
    expect(server.getBindings()).toEqual([]);
  });

  it('temoin : client sans Rapid Commit chez un serveur configure recoit un Advertise', () => {
    const server = engine();
    server.configurePoolRapidCommit('P', true);
    const adv = buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    expect(adv.msgType).toBe('ADVERTISE');
  });

  it('preference du serveur portee par l Advertise quand elle est non nulle', () => {
    const server = engine();
    server.configurePoolPreference('P', 200);
    const adv = buildDhcpv6ServerReply(server, DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!;
    expect(adv.preference).toBe(200);
    expect(buildDhcpv6ServerReply(engine(), DHCPv6Packet.createSolicit('c1', 1, 1), CTX)!.preference).toBeNull();
  });
});

describe('IA_PD : delegation de prefixes (§18.3.2, §18.3.9, §21.21)', () => {
  const pdServer = () => {
    const server = new DHCPv6Server();
    server.enable();
    server.createPool('PD');
    server.configurePoolDelegation('PD', '2001:db8:aa00::', 40, 48);
    server.configurePoolLifetime('PD', 1000, 2000);
    return server;
  };
  const pdCtx = { poolName: 'PD', relayed: false, unicast: false } as const;
  const pd = (iaid: number) => ({ iaid, t1: 0, t2: 0, prefixes: [] });

  it('Solicit avec IA_PD : Advertise portant un /48 du bloc delegue', () => {
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.ias = [];
    s.prefixDelegations = [pd(1)];
    const adv = buildDhcpv6ServerReply(pdServer(), s, pdCtx)!;
    expect(adv.prefixDelegations[0].prefixes[0]).toMatchObject({ prefix: '2001:db8:aa00::', prefixLength: 48, validLifetime: 2000 });
  });

  it('deux clients recoivent deux prefixes distincts apres Request', () => {
    const server = pdServer();
    const take = (duid: string) => {
      const s = DHCPv6Packet.createSolicit(duid, 1, 1);
      s.ias = [];
      s.prefixDelegations = [pd(1)];
      const adv = buildDhcpv6ServerReply(server, s, pdCtx)!;
      const r = DHCPv6Packet.createClientMessage('REQUEST', duid, server.getServerDuid(), 1, [], adv.prefixDelegations);
      return buildDhcpv6ServerReply(server, r, pdCtx)!.prefixDelegations[0].prefixes[0].prefix;
    };
    const first = take('c1');
    const second = take('c2');
    expect(first).not.toBe(second);
    expect(server.getPrefixBindings().length).toBe(2);
  });

  it('delegation statique : le client designe recoit son prefixe', () => {
    const server = pdServer();
    server.configurePoolStaticDelegation('PD', { prefix: '2001:db8:bb00::', prefixLength: 48, clientDuid: 'c9', iaid: null });
    const s = DHCPv6Packet.createSolicit('c9', 1, 1);
    s.ias = [];
    s.prefixDelegations = [pd(1)];
    const adv = buildDhcpv6ServerReply(server, s, pdCtx)!;
    expect(adv.prefixDelegations[0].prefixes[0].prefix).toBe('2001:db8:bb00::');
  });

  it('bloc epuise : IA_PD sans prefixe et statut NoPrefixAvail', () => {
    const server = new DHCPv6Server();
    server.createPool('PD');
    server.configurePoolDelegation('PD', '2001:db8:aa00::', 47, 48);
    const take = (duid: string) => {
      const s = DHCPv6Packet.createSolicit(duid, 1, 1);
      s.ias = [];
      s.prefixDelegations = [pd(1)];
      const adv = buildDhcpv6ServerReply(server, s, pdCtx)!;
      const r = DHCPv6Packet.createClientMessage('REQUEST', duid, server.getServerDuid(), 1, [], adv.prefixDelegations);
      return buildDhcpv6ServerReply(server, r, pdCtx)!;
    };
    take('c1');
    take('c2');
    const third = take('c3');
    expect(third.prefixDelegations[0].statusCode).toBe(DHCPV6_STATUS.NoPrefixAvail);
    expect(third.prefixDelegations[0].prefixes).toEqual([]);
  });

  it('Renew puis Release d un prefixe delegue', () => {
    const server = pdServer();
    let now = 1000;
    server.setClock(() => now);
    const s = DHCPv6Packet.createSolicit('c1', 1, 1);
    s.ias = [];
    s.prefixDelegations = [pd(1)];
    const adv = buildDhcpv6ServerReply(server, s, pdCtx)!;
    const req = DHCPv6Packet.createClientMessage('REQUEST', 'c1', server.getServerDuid(), 1, [], adv.prefixDelegations);
    const granted = buildDhcpv6ServerReply(server, req, pdCtx)!.prefixDelegations;
    now = 500_000;
    const renew = DHCPv6Packet.createClientMessage('RENEW', 'c1', server.getServerDuid(), 2, [], granted);
    const renewed = buildDhcpv6ServerReply(server, renew, pdCtx)!;
    expect(renewed.prefixDelegations[0].prefixes[0].validLifetime).toBe(2000);
    expect(server.getPrefixBindings()[0].leaseExpiration).toBe(500_000 + 2_000_000);
    const release = DHCPv6Packet.createClientMessage('RELEASE', 'c1', server.getServerDuid(), 3, [], granted);
    expect(buildDhcpv6ServerReply(server, release, pdCtx)!.statusCode).toBe(DHCPV6_STATUS.Success);
    expect(server.getPrefixBindings()).toEqual([]);
  });
});

describe('sur le fil, routeur Cisco et clients Linux', () => {
  it('temoin : SOLICIT/ADVERTISE/REQUEST/REPLY donne une adresse et un bail cote client', async () => {
    const { h1, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    expect(server.getBindings().length).toBe(1);
    expect(h1.getDhcpv6Lease('eth0')?.address).toBe(server.getBindings()[0].address);
  });

  it('Renew sur le fil : le routeur prolonge le bail', async () => {
    const { h1, server, advance } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    const before = server.getBindings()[0].leaseExpiration;
    advance(1_000_000);
    expect(h1.renewDhcpv6Lease('eth0')).toBe('extended');
    expect(server.getBindings()[0].leaseExpiration).toBeGreaterThan(before);
  });

  it('Rebind sur le fil, sans Server-ID', async () => {
    const { h1, server, advance } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    const before = server.getBindings()[0].leaseExpiration;
    advance(1_000_000);
    expect(h1.rebindDhcpv6Lease('eth0')).toBe('extended');
    expect(server.getBindings()[0].leaseExpiration).toBeGreaterThan(before);
  });

  it('Renew apres effacement du bail cote serveur : NoBinding, le client redemande (Request, §18.2.10.1)', async () => {
    const { h1, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    server.clearAllBindings();
    expect(h1.renewDhcpv6Lease('eth0')).toBe('extended');
    expect(server.getBindings().length).toBe(1);
    expect(h1.getDhcpv6Lease('eth0')?.address).toBe(server.getBindings()[0].address);
  });

  it('Confirm sur le lien : Success ; prefixe du serveur change : NotOnLink et adresse retiree', async () => {
    const { h1, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    expect(h1.confirmDhcpv6Lease('eth0')).toBe('success');
    server.configurePoolPrefix('POOL1', '2001:db8:5::', 64);
    expect(h1.confirmDhcpv6Lease('eth0')).toBe('not-on-link');
    expect(h1.getPort('eth0')!.getIPv6Addresses().some(a => a.origin === 'dhcpv6')).toBe(false);
  });

  it('Release sur le fil : le client abandonne son adresse et le routeur libere le bail', async () => {
    const { h1, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    expect(h1.releaseDhcpv6Lease('eth0')).toBe(true);
    expect(server.getBindings()).toEqual([]);
    expect(h1.getPort('eth0')!.getIPv6Addresses().some(a => a.origin === 'dhcpv6')).toBe(false);
  });

  it('Decline sur le fil : l adresse n est pas redonnee a l autre client', async () => {
    const { h1, h2, server } = await lab();
    await h1.executeCommand('dhclient -6 eth0');
    const declined = server.getBindings()[0].address;
    expect(h1.declineDhcpv6Lease('eth0')).toBe(true);
    expect(server.getDeclinedAddresses()).toEqual([declined]);
    await h2.executeCommand('dhclient -6 eth0');
    expect(h2.getDhcpv6Lease('eth0')?.address).not.toBe(declined);
  });

  it('Rapid Commit sur le fil : pas de Request, adresse obtenue en deux messages', async () => {
    const { h1, h2, server } = await lab();
    const slow = h1.requestDhcpv6Lease('eth0', true, { rapidCommit: true });
    expect(slow).toContain('DHCPv6 REQUEST');
    server.configurePoolRapidCommit('POOL1', true);
    const fast = h2.requestDhcpv6Lease('eth0', true, { rapidCommit: true });
    expect(fast).not.toContain('DHCPv6 REQUEST');
    expect(fast).toContain('(rapid commit)');
    expect(h2.getDhcpv6Lease('eth0')?.address).toBeTruthy();
  });

  it('IA_PD sur le fil : le client recoit un prefixe delegue et le libere', async () => {
    const { h1, server } = await lab();
    server.configurePoolDelegation('POOL1', '2001:db8:aa00::', 40, 48);
    h1.requestDhcpv6Lease('eth0', false, { prefixDelegation: true });
    expect(h1.getDhcpv6Lease('eth0')?.prefix).toEqual({ prefix: '2001:db8:aa00::', prefixLength: 48 });
    expect(server.getPrefixBindings().length).toBe(1);
    expect(h1.releaseDhcpv6Lease('eth0')).toBe(true);
    expect(server.getPrefixBindings()).toEqual([]);
  });
});
