/**
 * Les segments TCP qu'une machine emet vers un autre hote traversent la chaine OUTPUT comme n'importe quel paquet : `tcp_transmit_skb`
 * appelle `ip_queue_xmit`, qui passe par `ip_local_out` et le crochet NF_INET_LOCAL_OUT avant tout voisin. Un SYN que OUTPUT jette est
 * retransmis jusqu'au delai de la connexion ; un SYN que OUTPUT rejette rend `ECONNREFUSED` ; une politique `-P OUTPUT DROP` ne laisse
 * sortir que ce qu'une regle accepte, et la reponse d'un serveur (SYN-ACK, donnees, FIN) est un paquet du sens retour d'un flux que la
 * correspondance `ESTABLISHED` reconnait. La pile TCP, elle, envoyait ses segments distants directement a la couche IP : OUTPUT ne les
 * voyait jamais (seuls les segments bouclables sur `lo` passaient par OUTPUT puis INPUT), si bien que la regle durcissement la plus courante
 * -- `-P OUTPUT DROP` suivi de quelques `ACCEPT` -- ne bloquait rien du TCP.
 *
 * Mesure de depart (f9f2c045 ; deux LinuxPC sur un lien, B ecoute sur ssh) :
 *     A : iptables -A OUTPUT -p tcp --dport 22 -j DROP   ->  `nc -zv -w 2 10.0.0.2 22` : « succeeded! » ; le compteur de la regle reste a 0
 *     A : iptables -A OUTPUT -p tcp --dport 22 -j REJECT ->  idem
 *     A : iptables -P OUTPUT DROP                        ->  idem : la connexion s'etablit, le compteur de la politique ne bouge pas
 *     B : iptables -P OUTPUT DROP                        ->  idem : le SYN-ACK de B sort malgre la politique
 *
 * Autorites : noyau Linux 6.1 -- net/ipv4/tcp_output.c (tcp_transmit_skb), net/ipv4/ip_output.c (ip_queue_xmit, __ip_local_out :
 * NF_HOOK(NFPROTO_IPV4, NF_INET_LOCAL_OUT)), net/ipv4/tcp_ipv4.c (tcp_v4_connect), net/ipv4/netfilter/nf_reject_ipv4.c ; iptables 1.8.7.
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde conservee), 9 des 11 cas tombent et 2 passent des deux
 * cotes : le TEMOIN (sans regle applicable la connexion s'etablit et OUTPUT ne compte rien) et la politique DROP assortie d'un ACCEPT
 * du port 22 (le laboratoire laisse bien passer ce qu'une regle accepte : avant le lot parce que rien n'etait filtre, apres parce que la
 * regle accepte). Le cas `tcp-reset` tombe aussi contre le lot prive du chemin du RST (rejectOutgoing ecrivant l'erreur ICMP pour tout
 * type) : le RST compte zero a l'entree de lo, l'erreur ICMP un.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { linuxPair } from '../../support/linuxPair';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const sudo = (host: LinuxPC, command: string): Promise<string> => host.executeCommand(`sudo ${command}`);

const OPEN = 'Connection to 10.0.0.2 22 port [tcp/ssh] succeeded!';
const TIMED_OUT = 'nc: connect to 10.0.0.2 port 22 (tcp) failed: Connection timed out';
const REFUSED = 'nc: connect to 10.0.0.2 port 22 (tcp) failed: Connection refused';

async function lab() {
  const { a, b } = linuxPair();
  await sudo(b, 'systemctl start ssh');
  return { a, b };
}

const connect = (host: LinuxPC): Promise<string> => pingOnSimulatedClock(host, 'nc -zv -w 2 10.0.0.2 22');

const countOf = async (
  host: LinuxPC, tool: 'iptables' | 'ip6tables', target: string, chain = 'OUTPUT', protocol = '\\S+',
): Promise<number> => {
  const listing = await sudo(host, `${tool} -L ${chain} -v -n`);
  const row = listing.split('\n').find((line) => new RegExp(`^\\s*\\d+\\s+\\d+\\s+${target}\\s+${protocol}\\s`).test(line)) ?? '';
  return Number(row.trim().split(/\s+/)[0]);
};

describe('the OUTPUT chain of the client sees the segments it sends', () => {
  it('TEMOIN : with no rule the connection opens and no OUTPUT rule counts anything', async () => {
    const { a } = await lab();
    await sudo(a, 'iptables -A OUTPUT -p tcp --dport 80 -j DROP');
    expect(await connect(a)).toContain(OPEN);
    expect(await countOf(a, 'iptables', 'DROP')).toBe(0);
  });

  it('a DROP of port 22 keeps the SYN from leaving : the connection times out, the SYN and its retransmission are counted', async () => {
    const { a } = await lab();
    await sudo(a, 'iptables -A OUTPUT -p tcp --dport 22 -j DROP');
    expect(await connect(a)).toContain(TIMED_OUT);
    expect(await countOf(a, 'iptables', 'DROP')).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['icmp-port-unreachable', 'iptables -A OUTPUT -p tcp --dport 22 -j REJECT', 0, 1],
    ['tcp-reset', 'iptables -A OUTPUT -p tcp --dport 22 -j REJECT --reject-with tcp-reset', 1, 0],
  ])('a REJECT with %s refuses the connection at once, on one SYN, and the answer comes back by lo', async (_how, rule, resets, errors) => {
    const { a } = await lab();
    await sudo(a, 'iptables -A INPUT -i lo -p tcp --tcp-flags RST RST -j ACCEPT');
    await sudo(a, 'iptables -A INPUT -i lo -p icmp -j ACCEPT');
    await sudo(a, rule);
    expect(await connect(a)).toContain(REFUSED);
    expect(await countOf(a, 'iptables', 'REJECT')).toBe(1);
    expect(await countOf(a, 'iptables', 'ACCEPT', 'INPUT', 'tcp')).toBe(resets);
    expect(await countOf(a, 'iptables', 'ACCEPT', 'INPUT', 'icmp')).toBe(errors);
  });

  it('-o names the interface the segment leaves by : eth0 matches, lo does not', async () => {
    const { a } = await lab();
    await sudo(a, 'iptables -A OUTPUT -o lo -p tcp --dport 22 -j DROP');
    expect(await connect(a)).toContain(OPEN);
    await sudo(a, 'iptables -F OUTPUT');
    await sudo(a, 'iptables -A OUTPUT -o eth0 -p tcp --dport 22 -j DROP');
    expect(await connect(a)).toContain(TIMED_OUT);
  });

  it('every segment of an open connection that leaves is counted : the SYN, the ACK and the close', async () => {
    const { a } = await lab();
    await sudo(a, 'iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT');
    expect(await connect(a)).toContain(OPEN);
    expect(await countOf(a, 'iptables', 'ACCEPT')).toBeGreaterThanOrEqual(3);
  });
});

describe('a policy DROP in OUTPUT lets out what a rule accepts, and the state of the flow decides the rest', () => {
  it('the policy alone refuses the SYN, and the state ESTABLISHED does not rescue a NEW flow', async () => {
    const { a } = await lab();
    await sudo(a, 'iptables -P OUTPUT DROP');
    await sudo(a, 'iptables -A OUTPUT -m state --state ESTABLISHED -j ACCEPT');
    expect(await connect(a)).toContain(TIMED_OUT);
    expect(await countOf(a, 'iptables', 'ACCEPT')).toBe(0);
  });

  it('accepting NEW and ESTABLISHED to port 22 opens the connection again', async () => {
    const { a } = await lab();
    await sudo(a, 'iptables -P OUTPUT DROP');
    await sudo(a, 'iptables -A OUTPUT -p tcp --dport 22 -m state --state NEW,ESTABLISHED -j ACCEPT');
    expect(await connect(a)).toContain(OPEN);
  });
});

describe('the server answers through its own OUTPUT chain', () => {
  it('a policy DROP on the server keeps the SYN-ACK from leaving : the client times out', async () => {
    const { a, b } = await lab();
    await sudo(b, 'iptables -P OUTPUT DROP');
    expect(await connect(a)).toContain(TIMED_OUT);
  });

  it('ESTABLISHED lets the answers out, because the SYN made them the reply direction of a flow', async () => {
    const { a, b } = await lab();
    await sudo(b, 'iptables -P OUTPUT DROP');
    await sudo(b, 'iptables -A OUTPUT -m state --state ESTABLISHED -j ACCEPT');
    expect(await connect(a)).toContain(OPEN);
    expect(await countOf(b, 'iptables', 'ACCEPT')).toBeGreaterThanOrEqual(2);
  });
});

describe('IPv6 segments traverse ip6tables OUTPUT the same way', () => {
  const connect6 = (host: LinuxPC): Promise<string> => pingOnSimulatedClock(host, 'nc -6 -zv -w 2 2001:db8::2 22');

  it('a DROP of port 22 times out, counted by ip6tables', async () => {
    const { a } = await lab();
    await sudo(a, 'ip6tables -A OUTPUT -p tcp --dport 22 -j DROP');
    expect(await connect6(a)).toContain('failed: Connection timed out');
    expect(await countOf(a, 'ip6tables', 'DROP')).toBeGreaterThanOrEqual(2);
  });
});
