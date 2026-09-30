/*
 * RFC 8415 : realisme du Reconfigure et du codec.
 *
 * §8 et §21 : format sur le fil des messages (type sur 1 octet, transaction-id sur
 * 3, options code/longueur sur 2+2, messages de relais avec hop-count, link-address et
 * peer-address de 16 octets, option Relay Message imbriquee) : `Dhcpv6Codec` encode et
 * decode ; la longueur UDP est celle du message encode.
 * §20.4.2 : le HMAC-MD5 du Reconfigure est calcule sur le message encode, champ
 * d'authentification mis a zero, avec la cle du client : recalcule ici a part avec le
 * HMAC de `src/crypto` sur les octets du codec.
 * §18.3.11 : le serveur retransmet a REC_TIMEOUT (2 s) en doublant, au plus REC_MAX_RC
 * (8) fois, et cesse des que le message attendu arrive ; a defaut d'adresse directe il
 * emet un Relay-reply vers le relais, qui le remet au client (§19.4).
 *
 * Avant le correctif : pas de codec, HMAC calcule sur une chaine de champs, huit envois
 * immediats sans attente, aucun Reconfigure derriere un relais : les 17 cas tombent (modules absents). Mutation verifiee : sans doublement du delai, le cas des envois a 0, 2, 6, 14... tombe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { hmac } from '@/crypto/mac';
import { MD5 } from '@/crypto/hash';
import { DHCPv6Packet } from '@/network/dhcpv6/DHCPv6Packet';
import { encodeDhcpv6, decodeDhcpv6, dhcpv6WireLength } from '@/network/dhcpv6/Dhcpv6Codec';
import { buildReconfigure, verifyReconfigure } from '@/network/dhcpv6/Dhcpv6Reconfigure';
import { DHCPv6Server } from '@/network/dhcpv6/DHCPv6Server';
import { buildDhcpv6ServerReply } from '@/network/dhcpv6/Dhcpv6ServerExchange';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };
const DUID = '00:03:00:01:02:00:00:00:00:05';

describe('codec : octets du RFC 8415', () => {
  it('Solicit : type 1, transaction-id sur 3 octets, options Client-ID, ORO, IA_NA', () => {
    const solicit = DHCPv6Packet.createSolicit(DUID, 1, 0xabcdef);
    solicit.optionRequest = [23, 24];
    const bytes = encodeDhcpv6(solicit);
    expect([...bytes.subarray(0, 4)]).toEqual([1, 0xab, 0xcd, 0xef]);
    expect([...bytes.subarray(4, 8)]).toEqual([0, 1, 0, 10]);
    expect([...bytes.subarray(8, 18)]).toEqual([0, 3, 0, 1, 2, 0, 0, 0, 0, 5]);
    expect([...bytes.subarray(18, 26)]).toEqual([0, 6, 0, 4, 0, 23, 0, 24]);
    expect([...bytes.subarray(26, 30)]).toEqual([0, 3, 0, 12]);
    expect([...bytes.subarray(30, 34)]).toEqual([0, 0, 0, 1]);
  });

  it('un Reply complet fait l aller-retour', () => {
    const reply = new DHCPv6Packet();
    reply.msgType = 'REPLY';
    reply.transactionId = 0x123456;
    reply.clientDuid = DUID;
    reply.serverDuid = '00:03:00:01:02:00:00:00:00:01';
    reply.ias = [
      { iaid: 7, t1: 100, t2: 200, addresses: [{ address: '2001:db8:1::10', preferredLifetime: 300, validLifetime: 400 }] },
      { iaid: 8, t1: 0, t2: 0, addresses: [], statusCode: 2, statusMessage: 'No addresses available for this IA.' },
    ];
    reply.prefixDelegations = [{ iaid: 9, t1: 1, t2: 2, prefixes: [{ prefix: '2001:db8:aa00::', prefixLength: 48, preferredLifetime: 5, validLifetime: 6 }] }];
    reply.dnsServers = ['2001:db8:53::1', '2001:db8:53::2'];
    reply.domainList = ['corp.example', 'lab.test'];
    reply.rapidCommit = true;
    reply.reconfigureAccept = true;
    reply.serverUnicast = '2001:db8:1::1';
    reply.preference = 200;
    reply.informationRefreshTime = 3600;
    reply.statusCode = 0;
    reply.statusMessage = 'Success.';
    reply.authentication = { protocol: 3, algorithm: 1, rdm: 0, type: 1, value: '0123456789abcdef0123456789abcdef' };
    const decoded = decodeDhcpv6(encodeDhcpv6(reply));
    expect(decoded).toEqual(reply);
  });

  it('un Relay-forward imbrique fait l aller-retour et porte hop-count et adresses sur 16 octets', () => {
    const inner = DHCPv6Packet.createSolicit(DUID, 1, 5);
    const first = DHCPv6Packet.createRelayForw('2001:db8:1::1', 'fe80::200:ff:fe00:5', 0, 'Gi0/0', inner);
    const second = DHCPv6Packet.createRelayForw('2001:db8:98::1', '2001:db8:1::1', 1, 'Gi0/1', first);
    const bytes = encodeDhcpv6(second);
    expect(bytes[0]).toBe(12);
    expect(bytes[1]).toBe(1);
    expect(bytes.length).toBeGreaterThan(34);
    expect(decodeDhcpv6(bytes)).toEqual(second);
  });

  it('un DUID non hexadecimal est encode en octets de texte sans echec', () => {
    const solicit = DHCPv6Packet.createSolicit('client-un', 1, 1);
    expect(() => encodeDhcpv6(solicit)).not.toThrow();
  });

  it('option tronquee : le decodage refuse', () => {
    const bytes = encodeDhcpv6(DHCPv6Packet.createSolicit(DUID, 1, 1));
    expect(() => decodeDhcpv6(bytes.subarray(0, bytes.length - 3))).toThrow();
  });

  it('la longueur UDP annoncee est celle du message encode', () => {
    const solicit = DHCPv6Packet.createSolicit(DUID, 1, 1);
    expect(dhcpv6WireLength(solicit)).toBe(encodeDhcpv6(solicit).length);
  });
});

describe('HMAC-MD5 du Reconfigure sur les octets encodes (§20.4.2)', () => {
  function enrolledEngine() {
    const server = new DHCPv6Server();
    server.createPool('P');
    server.configurePoolPrefix('P', '2001:db8:9::', 64);
    server.configurePoolReconfigure('P', true);
    const solicit = DHCPv6Packet.createSolicit(DUID, 1, 1);
    solicit.reconfigureAccept = true;
    const ctx = { poolName: 'P', relayed: false, unicast: false } as const;
    const adv = buildDhcpv6ServerReply(server, solicit, ctx)!;
    const request = DHCPv6Packet.createClientMessage('REQUEST', DUID, server.getServerDuid(), 2, adv.ias);
    request.reconfigureAccept = true;
    const reply = buildDhcpv6ServerReply(server, request, ctx)!;
    return { server, key: reply.authentication!.value };
  }

  it('le digest est HMAC-MD5(cle, message encode avec le champ a zero)', () => {
    const { server, key } = enrolledEngine();
    const message = buildReconfigure(server, DUID, 'RENEW')!;
    const zeroed = Object.assign(new DHCPv6Packet(), message, {
      authentication: { ...message.authentication!, value: '0'.repeat(32) },
    });
    const expected = [...hmac(MD5, Uint8Array.from(key.match(/../g)!.map(p => parseInt(p, 16))), encodeDhcpv6(zeroed))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    expect(message.authentication!.value).toBe(expected);
    expect(verifyReconfigure(message, key)).toBe(true);
  });

  it('un octet change dans le message invalide le digest', () => {
    const { server, key } = enrolledEngine();
    const message = buildReconfigure(server, DUID, 'RENEW')!;
    message.reconfigureMessage = 'REBIND';
    expect(verifyReconfigure(message, key)).toBe(false);
  });

  it('le Reconfigure encode porte type 10, Client-ID, Server-ID, Reconfigure Message et Authentication', () => {
    const { server } = enrolledEngine();
    const bytes = encodeDhcpv6(buildReconfigure(server, DUID, 'INFORMATION-REQUEST')!);
    expect(bytes[0]).toBe(10);
    expect([...bytes.subarray(1, 4)]).toEqual([0, 0, 0]);
    const decoded = decodeDhcpv6(bytes);
    expect(decoded.reconfigureMessage).toBe('INFORMATION-REQUEST');
    expect(decoded.authentication).toMatchObject({ protocol: 3, algorithm: 1, rdm: 0, type: 2 });
    expect(decoded.authentication!.value).toMatch(/^[0-9a-f]{32}$/);
  });
});

async function lab(scheduler?: VirtualTimeScheduler) {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  if (scheduler) r1.setScheduler(scheduler);
  await run(r1, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800', 'exit',
    'interface GigabitEthernet0/0', 'ipv6 dhcp server POOL1', 'exit', 'end',
  ]);
  const server = r1._getDHCPv6ServerInternal();
  server.configurePoolReconfigure('POOL1', true);
  let now = 1_000_000;
  server.setClock(() => now);
  await h1.executeCommand('dhclient -6 eth0');
  return { h1, r1, server, advance: (ms: number) => { now += ms; } };
}

const tamper = (server: DHCPv6Server, duid: string, key = 'cd'.repeat(16)) =>
  (server as unknown as { reconfigureKeys: Map<string, string> }).reconfigureKeys.set(duid, key);

describe('retransmission REC_TIMEOUT / REC_MAX_RC (§18.3.11)', () => {
  it('sans reponse : envois a 0, 2, 6, 14, 30, 62, 126, 254 s puis abandon', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { h1, r1, server } = await lab(scheduler);
    const duid = server.getBindings()[0].clientDuid;
    const goodKey = (server as unknown as { reconfigureKeys: Map<string, string> }).reconfigureKeys.get(duid)!;
    tamper(server, duid);
    r1.sendDhcpv6Reconfigure(duid, 'RENEW');
    const discarded = () => h1.getDhcpv6ReconfigureCounters().discarded;
    expect(discarded()).toBe(1);
    scheduler.advance(1999);
    expect(discarded()).toBe(1);
    scheduler.advance(1);
    expect(discarded()).toBe(2);
    scheduler.advance(4000);
    expect(discarded()).toBe(3);
    scheduler.advance(8000);
    expect(discarded()).toBe(4);
    scheduler.advance(16000);
    expect(discarded()).toBe(5);
    scheduler.advance(32000);
    expect(discarded()).toBe(6);
    scheduler.advance(64000);
    expect(discarded()).toBe(7);
    scheduler.advance(128000);
    expect(discarded()).toBe(8);
    expect(server.pendingReconfigure(duid)).toBe('RENEW');
    scheduler.advance(256000);
    expect(discarded()).toBe(8);
    expect(server.pendingReconfigure(duid)).toBeNull();
    void goodKey;
  });

  it('la reponse attendue arrete les retransmissions', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { h1, r1, server } = await lab(scheduler);
    const duid = server.getBindings()[0].clientDuid;
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end']);
    r1.sendDhcpv6Reconfigure(duid, 'RENEW');
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 0, discarded: 0 });
    expect(server.pendingReconfigure(duid)).toBe('RENEW');
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end']);
    scheduler.advance(2000);
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 1, discarded: 0 });
    expect(server.pendingReconfigure(duid)).toBeNull();
    scheduler.advance(600000);
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 1, discarded: 0 });
  });

  it('un nouveau Reconfigure annule la serie precedente', async () => {
    const scheduler = new VirtualTimeScheduler();
    const { h1, r1, server } = await lab(scheduler);
    const duid = server.getBindings()[0].clientDuid;
    tamper(server, duid);
    r1.sendDhcpv6Reconfigure(duid, 'RENEW');
    r1.sendDhcpv6Reconfigure(duid, 'REBIND');
    scheduler.advance(2000);
    expect(h1.getDhcpv6ReconfigureCounters().discarded).toBe(3);
  });
});

describe('Reconfigure derriere un relais (§18.3.11, §19.4)', () => {
  async function relayLab(chain: boolean) {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const relay1 = new CiscoRouter('RELAY1');
    const relay2 = new CiscoRouter('RELAY2');
    const server = new CiscoRouter('SERVER');
    new Cable('a').connect(h1.getPort('eth0')!, relay1.getPort('GigabitEthernet0/0')!);
    if (chain) {
      new Cable('b').connect(relay1.getPort('GigabitEthernet0/1')!, relay2.getPort('GigabitEthernet0/0')!);
      new Cable('c').connect(relay2.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
    } else {
      new Cable('b').connect(relay1.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);
    }
    await run(relay1, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
      `ipv6 dhcp relay destination ${chain ? '2001:db8:98::2' : '2001:db8:99::2'}`, 'exit',
      'interface GigabitEthernet0/1', `ipv6 address ${chain ? '2001:db8:98::1' : '2001:db8:99::1'}/64`, 'no shutdown', 'exit',
      ...(chain ? ['ipv6 route 2001:db8:99::/64 2001:db8:98::2'] : []), 'end',
    ]);
    if (chain) {
      await run(relay2, [
        'enable', 'configure terminal', 'ipv6 unicast-routing',
        'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:98::2/64', 'no shutdown',
        'ipv6 dhcp relay destination 2001:db8:99::2', 'exit',
        'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:99::1/64', 'no shutdown', 'exit',
        'ipv6 route 2001:db8:1::/64 2001:db8:98::1', 'end',
      ]);
    }
    await run(server, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:99::2/64', 'no shutdown', 'exit',
      'ipv6 route 2001:db8:1::/64 2001:db8:99::1', 'ipv6 route 2001:db8:98::/64 2001:db8:99::1',
      'ipv6 dhcp pool POOL1', 'address prefix 2001:db8:1::/64 lifetime 3600 1800', 'exit', 'end',
    ]);
    const engine = server._getDHCPv6ServerInternal();
    engine.configurePoolReconfigure('POOL1', true);
    let now = 1_000_000;
    engine.setClock(() => now);
    await h1.executeCommand('dhclient -6 eth0');
    return { h1, server, engine, advance: (ms: number) => { now += ms; } };
  }

  it('un relais : le serveur emet un Relay-reply, le client renouvelle', async () => {
    const { h1, server, engine, advance } = await relayLab(false);
    const before = engine.getBindings()[0].leaseExpiration;
    advance(1_000_000);
    expect(server.sendDhcpv6Reconfigure(engine.getBindings()[0].clientDuid, 'RENEW')).toBe(true);
    expect(h1.getDhcpv6ReconfigureCounters()).toEqual({ accepted: 1, discarded: 0 });
    expect(engine.getBindings()[0].leaseExpiration).toBeGreaterThan(before);
  });

  it('le Reconfigure arrive au relais dans un Relay-reply, jamais directement au client', async () => {
    const { server, engine } = await relayLab(false);
    const seen: string[] = [];
    server.getPort('GigabitEthernet0/0')!.attachTap(({ frame, direction }) => {
      const ip = frame.payload as { destinationIP?: { toString(): string }; payload?: { payload?: unknown } };
      const message = ip.payload?.payload;
      if (direction === 'out' && message instanceof DHCPv6Packet && message.relayedMessage?.msgType === 'RECONFIGURE') {
        seen.push(`${message.msgType} -> ${ip.destinationIP}`);
      }
    });
    server.sendDhcpv6Reconfigure(engine.getBindings()[0].clientDuid, 'RENEW');
    expect(seen).toEqual(['RELAY-REPL -> 2001:db8:99::1']);
  });

  it('deux relais en cascade : Relay-reply imbrique remis relais par relais', async () => {
    const { h1, server, engine } = await relayLab(true);
    expect(server.sendDhcpv6Reconfigure(engine.getBindings()[0].clientDuid, 'REBIND')).toBe(true);
    expect(h1.getDhcpv6ReconfigureCounters().accepted).toBe(1);
  });
});

describe('Reconfigure depuis un serveur d hote', () => {
  function link() {
    const sw = new GenericSwitch('switch-generic', 'SW');
    const c1 = new LinuxPC('linux-pc', 'C1');
    return { sw, c1 };
  }

  it('Windows Server : la cle est donnee et le Reconfigure declenche un Renew', async () => {
    const dhcp = new WindowsServer('DHCP1');
    const { sw, c1 } = link();
    new Cable('a').connect(dhcp.getPorts()[0], sw.getPorts()[0]);
    new Cable('b').connect(c1.getPorts()[0], sw.getPorts()[1]);
    dhcp.getPorts()[0].enableIPv6();
    dhcp.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:1::10'), 64);
    dhcp.setCurrentUser('Administrator');
    const shell = PowerShellSubShell.create(dhcp).subShell;
    await shell.processLine('Install-WindowsFeature DHCP');
    await shell.processLine('Add-DhcpServerv6Scope -Prefix 2001:db8:1:: -Name LAN6');
    const v6 = dhcp.getDhcpServerRole()!.v6;
    v6.engine().configurePoolReconfigure('2001:db8:1::/64', true);
    await c1.executeCommand('dhclient -6 eth0');
    expect(v6.reconfigure(v6.getLeases()[0].clientDuid, 'RENEW')).toBe(true);
    expect(c1.getDhcpv6ReconfigureCounters().accepted).toBe(1);
  });

  it('dhcpd -6 : le meme chemin', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    const { sw, c1 } = link();
    new Cable('a').connect(srv.getPorts()[0], sw.getPorts()[0]);
    new Cable('b').connect(c1.getPorts()[0], sw.getPorts()[1]);
    srv.getPorts()[0].configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    srv.getPorts()[0].enableIPv6();
    srv.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:1::1'), 64);
    await srv.executeCommand(`printf '%s' ${JSON.stringify('subnet6 2001:db8:1::/64 { range6 2001:db8:1::100 2001:db8:1::110; }\n')} > /etc/dhcp/dhcpd6.conf`);
    await srv.executeCommand('printf \'INTERFACESv6="eth0"\\n\' > /etc/default/isc-dhcp-server');
    await srv.executeCommand('systemctl start isc-dhcp-server6');
    srv.dhcpd6.getEngine().configurePoolReconfigure('2001:db8:1::/64', true);
    await c1.executeCommand('dhclient -6 eth0');
    expect(srv.dhcpd6.reconfigure(srv.dhcpd6.getEngine().getBindings()[0].clientDuid, 'RENEW')).toBe(true);
    expect(c1.getDhcpv6ReconfigureCounters().accepted).toBe(1);
  });
});
