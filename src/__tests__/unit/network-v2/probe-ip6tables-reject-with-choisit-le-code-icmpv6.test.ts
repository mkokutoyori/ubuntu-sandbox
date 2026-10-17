/**
 * `ip6tables -j REJECT --reject-with <type>` choisit le code de l'erreur ICMPv6 qui repart, comme `iptables` choisit celui de l'ICMP, et
 * un type inconnu ou mal place est refuse a la saisie au lieu d'etre garde sans effet.
 *
 * Mesure de depart (88153d20, deux LinuxPC sur un lien, le serveur filtre) :
 *     ip6tables -A INPUT -p icmpv6 -j REJECT                              ->  ping -6 recoit « Administratively prohibited »
 *     ip6tables -A INPUT -p icmpv6 -j REJECT --reject-with icmp6-no-route ->  idem : le type est range et jamais lu
 *     ip6tables -A INPUT -p udp --dport 5300 -j REJECT --reject-with icmp6-adm-prohibited -> « Port unreachable », jamais le code 1
 *     ip6tables -A INPUT -p tcp -j REJECT                                 ->  un RST, alors que le defaut de REJECT est l'ICMPv6
 *                                                                              « port unreachable » (tcp-reset doit etre demande)
 *     ip6tables ... --reject-with icmp-port-unreachable                   ->  accepte (c'est un nom d'iptables, pas d'ip6tables)
 *     ip6tables ... --reject-with n'importe-quoi                          ->  accepte
 *     iptables  ... --reject-with port-unreach                            ->  liste tel que tape, alors qu'iptables -S dit icmp-port-unreachable
 *     iptables  -p icmp -j REJECT --reject-with host-prohib               ->  ping ne lit pas « Destination Host Prohibited » : l'alias (et le
 *                                                                              prefixe `net-unreach`, la casse `ICMP-HOST-UNREACHABLE`) n'est pas lu
 * Un critere range et jamais evalue : `--reject-with` etait lu pour l'IPv4 (sept types) et ignore pour l'IPv6.
 *
 * Autorites : le source de l'extension REJECT d'iptables 1.8.7 (extensions/libip6t_REJECT.c et libipt_REJECT.c, lus sur sources.debian.org) pour les TABLES
 * (nom, alias, ordre), pour la recherche (`strncasecmp(nom, argument, strlen(argument))` : insensible a la casse et par PREFIXE, le premier de
 * la table l'emporte) et pour les messages (`unknown reject type "%s"`) ; le noyau (net/ipv6/netfilter/ip6t_REJECT.c `reject_tg6`) pour le code
 * de chaque type : no-route 0, adm-prohibited 1, addr-unreach 3, port-unreach 4, policy-fail 5, reject-route 6 ; `checkentry` refuse tcp-reset
 * sur une regle qui n'est pas `-p tcp` (EINVAL). ip6tables-extensions(8) : « icmp6-port-unreachable is the default ».
 *
 * Non fait ici, dit comme tel : la chaine OUTPUT et FORWARD d'IPv6 ne repondent pas a un REJECT (le paquet local est simplement refuse),
 * l'IPv4 non plus pour OUTPUT.
 *
 * Discrimination : 31 des 40 cas tombent contre 88153d20 (IcmpErrors, EndHost et LinuxIptablesManager remis a leur etat, la sonde conservee).
 * Passent des deux cotes neuf cas, et pourquoi : les TROIS cas « adm-prohibited » (nom long, alias, majuscules) -- l'ancien code posait en
 * dur le code 1 sur l'entree ICMPv6, qui est ce que ce type demande : coincidence, non-regression ; « un RST avec --reject-with tcp-reset »
 * -- l'ancien code repondait un RST a tout rejet TCP, ce qui est ce que ce type demande ; les DEUX regles `-p tcp` / `-p 6` avec
 * tcp-reset, acceptees avant comme apres (non-regression de la forme legitime du refus d'une regle hors TCP) ; et les TROIS cas IPv4 qui
 * ecrivent le nom complet ou rien (`-j REJECT` nu, `icmp-host-prohibited`, `icmp-net-prohibited`) -- l'ancienne table IPv4 les lisait deja :
 * TEMOINS que le banc voit un REJECT IPv4 et que le recodage ne le deplace pas.
 * Mutation (trente mutants du diff, sonde seule) : vingt-quatre tombent ; les six survivants sont des mutants equivalents de LITTERAL
 * (`rejectCode(5, ...)` a l'appel IPv4, `family: 4 | 7` et `family: 5 | 6` de rejectCode comme de rejectTypeOf, `rejectTypeOf(7, ...)` a
 * l'appel du RST) : la recherche ne teste que `family === 6`, un autre entier y est l'IPv4, et le type de la famille n'existe pas a
 * l'execution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, IPv6Address, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import type { ICMPv6Packet, IPv6Packet } from '@/network/core/types';
import type { TcpSegment } from '@/network/tcp/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP6TABLES_REJECT_TYPES, IPTABLES_REJECT_TYPES, rejectTypeOf } from '@/network/core/IcmpErrors';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function lab() {
  const server = new LinuxPC('S', 0, 0);
  const client = new LinuxPC('C', 0, 0);
  new Cable('c').connect(server.getPort('eth0')!, client.getPort('eth0')!);
  server.configureIPv6Interface('eth0', new IPv6Address('fd00::1'), 64);
  client.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  server.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  client.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const errors: Array<{ code: number; from: string }> = [];
  const resets: number[] = [];
  client.attachCapture(({ frame }) => {
    const packet = frame.payload as IPv6Packet | undefined;
    if (packet?.type !== 'ipv6') return;
    if (packet.nextHeader === 58) {
      const icmp = packet.payload as ICMPv6Packet;
      if (icmp.icmpType === 'destination-unreachable') errors.push({ code: icmp.code, from: String(packet.sourceIP) });
    } else if (packet.nextHeader === 6 && (packet.payload as TcpSegment).flags?.rst) {
      resets.push(1);
    }
  });
  return { server, client, errors, resets };
}

describe('a REJECT on ICMPv6 answers with the code the type selects', () => {
  it.each([
    ['', 'Port unreachable'],
    [' --reject-with icmp6-port-unreachable', 'Port unreachable'],
    [' --reject-with icmp6-adm-prohibited', 'Administratively prohibited'],
    [' --reject-with icmp6-no-route', 'No route'],
    [' --reject-with icmp6-addr-unreachable', 'Address unreachable'],
    [' --reject-with icmp6-policy-fail', 'Unknown code 5'],
    [' --reject-with icmp6-reject-route', 'Unknown code 6'],
    [' --reject-with adm-prohibited', 'Administratively prohibited'],
    [' --reject-with no-route', 'No route'],
    [' --reject-with addr-unreach', 'Address unreachable'],
    [' --reject-with port-unreach', 'Port unreachable'],
    [' --reject-with policy-fail', 'Unknown code 5'],
    [' --reject-with reject-route', 'Unknown code 6'],
    [' --reject-with ICMP6-ADM', 'Administratively prohibited'],
    [' --reject-with icmp6-no', 'No route'],
  ])('ping -6 against `-j REJECT%s` reads « Destination unreachable: %s »', async (option, sentence) => {
    const { server, client } = lab();
    expect(await server.executeCommand(`sudo ip6tables -A INPUT -p icmpv6 -j REJECT${option}`)).toBe('');
    const out = await pingOnSimulatedClock(client, 'ping -6 -c 1 -W 1 fd00::1');
    expect(out).toContain(`From fd00::1 icmp_seq=1 Destination unreachable: ${sentence}`);
    expect(out).toContain('+1 errors');
  });
});

describe('a REJECT on UDP and TCP follows the same table', () => {
  it('a UDP datagram draws the code of the type, the port-unreachable one by default', async () => {
    const { server, client, errors } = lab();
    await server.executeCommand('sudo ip6tables -A INPUT -p udp --dport 5300 -j REJECT');
    client.sendUdpDatagram6(new IPv6Address('fd00::1'), 5300, 40000, 'x', 10);
    await server.executeCommand('sudo ip6tables -F');
    await server.executeCommand('sudo ip6tables -A INPUT -p udp --dport 5300 -j REJECT --reject-with icmp6-addr-unreachable');
    client.sendUdpDatagram6(new IPv6Address('fd00::1'), 5300, 40000, 'x', 10);
    expect(errors.map((e) => e.code)).toEqual([4, 3]);
  });

  it('a TCP connection is refused by an ICMPv6 error by default, with no RST', async () => {
    const { server, client, errors, resets } = lab();
    await server.executeCommand('sudo ip6tables -A INPUT -p tcp --dport 22 -j REJECT');
    await client.executeCommand('nc -z -w 1 fd00::1 22');
    expect(errors.map((e) => e.code)).toContain(4);
    expect(resets).toHaveLength(0);
  });

  it('a TCP connection gets a RST with --reject-with tcp-reset, and no ICMPv6 error', async () => {
    const { server, client, errors, resets } = lab();
    await server.executeCommand('sudo ip6tables -A INPUT -p tcp --dport 22 -j REJECT --reject-with tcp-reset');
    await client.executeCommand('nc -z -w 1 fd00::1 22');
    expect(resets.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it('a TCP connection draws the ICMPv6 code of another type, not a RST', async () => {
    const { server, client, errors, resets } = lab();
    await server.executeCommand('sudo ip6tables -A INPUT -p tcp --dport 22 -j REJECT --reject-with icmp6-adm-prohibited');
    await client.executeCommand('nc -z -w 1 fd00::1 22');
    expect(errors.map((e) => e.code)).toContain(1);
    expect(resets).toHaveLength(0);
  });
});

describe('a type that the program does not know is refused when it is typed', () => {
  it.each([
    ['ip6tables -A INPUT -j REJECT --reject-with icmp-port-unreachable', 'ip6tables v1.8.7 (nf_tables): unknown reject type "icmp-port-unreachable"'],
    ['ip6tables -A INPUT -j REJECT --reject-with whatever', 'ip6tables v1.8.7 (nf_tables): unknown reject type "whatever"'],
    ['iptables -A INPUT -j REJECT --reject-with icmp6-port-unreachable', 'iptables v1.8.7 (nf_tables): unknown reject type "icmp6-port-unreachable"'],
    ['iptables -A INPUT -j REJECT --reject-with echo-reply', 'iptables v1.8.7 (nf_tables): unknown reject type "echo-reply"'],
    ['ip6tables -A INPUT -j REJECT --reject-with', 'ip6tables v1.8.7 (nf_tables): option "--reject-with" requires an argument'],
  ])('%s', async (command, sentence) => {
    const { server } = lab();
    expect(await server.executeCommand(`sudo ${command}`)).toBe(sentence);
    expect(await server.executeCommand('sudo ip6tables -S INPUT')).not.toContain('REJECT');
    expect(await server.executeCommand('sudo iptables -S INPUT')).not.toContain('REJECT');
  });

  it('TEMOIN : the IPv4 names are still taken by iptables, aliases and prefixes included, and listed in full', async () => {
    const { server } = lab();
    await server.executeCommand('sudo iptables -A INPUT -p icmp -j REJECT --reject-with host-prohib');
    await server.executeCommand('sudo iptables -A INPUT -p udp -j REJECT --reject-with icmp-net');
    const rules = await server.executeCommand('sudo iptables -S INPUT');
    expect(rules).toContain('-j REJECT --reject-with icmp-host-prohibited');
    expect(rules).toContain('-j REJECT --reject-with icmp-net-unreachable');
  });
});

describe('the same lookup answers iptables for the ICMP of IPv4', () => {
  it.each([
    ['', 'Destination Port Unreachable'],
    [' --reject-with icmp-host-prohibited', 'Destination Host Prohibited'],
    [' --reject-with host-prohib', 'Destination Host Prohibited'],
    [' --reject-with icmp-net-prohibited', 'Destination Net Prohibited'],
    [' --reject-with net-unreach', 'Destination Net Unreachable'],
    [' --reject-with ICMP-HOST-UNREACHABLE', 'Destination Host Unreachable'],
  ])('ping against `iptables -j REJECT%s` reads « %s »', async (option, sentence) => {
    const { server, client } = lab();
    expect(await server.executeCommand(`sudo iptables -A INPUT -p icmp -j REJECT${option}`)).toBe('');
    const out = await pingOnSimulatedClock(client, 'ping -c 1 -W 1 10.0.0.1');
    expect(out).toContain(`From 10.0.0.1 icmp_seq=1 ${sentence}`);
  });
});

describe('tcp-reset is for TCP rules only', () => {
  it.each([
    ['ip6tables -A INPUT -p tcp -j REJECT --reject-with tcp-reset', ''],
    ['ip6tables -A INPUT -p 6 -j REJECT --reject-with tcp-reset', ''],
    ['ip6tables -A INPUT -p udp -j REJECT --reject-with tcp-reset', 'ip6tables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain INPUT'],
    ['ip6tables -A INPUT -j REJECT --reject-with tcp-reset', 'ip6tables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain INPUT'],
    ['ip6tables -A INPUT ! -p tcp -j REJECT --reject-with tcp-reset', 'ip6tables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain INPUT'],
    ['ip6tables -I INPUT -p udp -j REJECT --reject-with tcp-reset', 'ip6tables v1.8.7 (nf_tables):  RULE_INSERT failed (Invalid argument): rule in chain INPUT'],
    ['iptables -A INPUT -p icmp -j REJECT --reject-with tcp-reset', 'iptables v1.8.7 (nf_tables):  RULE_APPEND failed (Invalid argument): rule in chain INPUT'],
  ])('%s', async (command, sentence) => {
    const { server } = lab();
    expect(await server.executeCommand(`sudo ${command}`)).toBe(sentence);
  });
});

describe('the tables are the ones of xtables', () => {
  it('iptables knows eight types, ip6tables seven, in the order of the source', () => {
    expect(IPTABLES_REJECT_TYPES.map((type) => type.name)).toEqual([
      'icmp-net-unreachable', 'icmp-host-unreachable', 'icmp-proto-unreachable', 'icmp-port-unreachable',
      'icmp-net-prohibited', 'icmp-host-prohibited', 'tcp-reset', 'icmp-admin-prohibited',
    ]);
    expect(IP6TABLES_REJECT_TYPES.map((type) => type.name)).toEqual([
      'icmp6-no-route', 'icmp6-adm-prohibited', 'icmp6-addr-unreachable', 'icmp6-port-unreachable',
      'tcp-reset', 'icmp6-policy-fail', 'icmp6-reject-route',
    ]);
  });

  it('the first entry of the table whose name or alias begins with the argument wins, case aside', () => {
    expect(rejectTypeOf(4, 'icmp')?.name).toBe('icmp-net-unreachable');
    expect(rejectTypeOf(4, 'TCP')?.name).toBe('tcp-reset');
    expect(rejectTypeOf(4, 'tcp-RST')?.name).toBe('tcp-reset');
    expect(rejectTypeOf(4, 'admin')?.name).toBe('icmp-admin-prohibited');
    expect(rejectTypeOf(6, 'icmp6')?.name).toBe('icmp6-no-route');
    expect(rejectTypeOf(6, 'policy')?.name).toBe('icmp6-policy-fail');
    expect(rejectTypeOf(6, 'icmp-port')).toBeNull();
    expect(rejectTypeOf(4, 'echo-reply')).toBeNull();
  });
});
