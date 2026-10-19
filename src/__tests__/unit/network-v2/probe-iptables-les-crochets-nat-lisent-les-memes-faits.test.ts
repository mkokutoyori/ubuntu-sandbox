/**
 * Les crochets NAT et le raccourci de l'ecouteur Oracle decident sur les MEMES faits que la chaine filter. Le lot precedent a appris a la
 * regle `--syn`, `--tcp-flags`, `--tcp-option`, `--icmp-type`, `-f` a decider ; mais seul `firewallFilter` remplissait ces faits dans le
 * PacketInfo. Les quatre autres constructeurs (evaluateNat, evaluatePreRouting, evaluatePreRouting6, le raccourci
 * `firewallAcceptsInboundTcp`) en batissaient une version reduite, sans taille, sans drapeaux, sans type ICMP : une regle de la table nat
 * qui en portait un ne correspondait donc a RIEN, et un `-p tcp --syn --dport 1521 -j DROP` ne jetait plus la connexion que l'ecouteur
 * Oracle attend. Les compteurs de la table nat ajoutaient en outre 64 octets a chaque paquet, quelle que soit sa taille, et
 * l'evaluation NAT de la sortie UDP ne declarait pas celle du datagramme.
 *
 * Mesure de depart (a070e21d ; un LinuxPC, les crochets appeles comme le plan de donnees les appelle) :
 *     -t nat -A PREROUTING -p tcp --syn --dport 80 -j REDIRECT --to-ports 8080  ->  un SYN n'est pas redirige (le fait manque)
 *     -t nat -A PREROUTING -p icmp --icmp-type echo-request -j DNAT ...          ->  un echo n'est pas traduit
 *     -t nat -A POSTROUTING -p tcp --syn -j MASQUERADE                            ->  un SYN n'est pas masquerade
 *     ip6tables -t nat -A PREROUTING -p tcp --syn ... -j REDIRECT                 ->  idem en IPv6
 *     iptables -A INPUT -p tcp --syn --dport 1521 -j DROP + firewallAcceptsInboundTcp  ->  la connexion passe
 *     compteur d'un paquet de 84 octets sur une regle nat                         ->  64 octets
 *     datagramme UDP de 100 octets, regle nat OUTPUT                              ->  64 octets
 *
 * Autorites : iptables 1.8.7 (la table nat evalue les memes extensions de protocole que la table filter, libxt_tcp.c et libipt_icmp.c) ;
 * noyau Linux 6.1 (xt_tcpudp, xt_icmp : une regle lit l'en-tete du paquet quelle que soit la table qui l'evalue).
 *
 * Discrimination : contre l'arbre sans le lot (sources remises a leur etat, sonde conservee), 12 des 15 cas tombent et 3 passent des deux
 * cotes : le TEMOIN (une regle sans critere de drapeau decide pareil pour un SYN et pour un ACK), la politique d'une chaine filter, qui
 * comptait deja les paquets qu'elle decide (non-regression : seule la chaine nat se trompait), et le SYN du raccourci de l'ecouteur qu'une
 * regle `-f` ne voit pas (le raccourci ne declarait aucun fragment : coincidence).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { echo4, hooksOf, tcp4, tcp6 } from '../../support/natHooks';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const SYN = { syn: true };
const ACK = { ack: true };

describe('the NAT hooks read the TCP flags of the packet', () => {
  it('PREROUTING : --syn redirects the SYN and lets the ACK alone', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p tcp --syn --dport 80 -j REDIRECT --to-ports 8080');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'REDIRECT', address: '8080' });
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(ACK))).toBeNull();
  });

  it('PREROUTING : ! --syn is the opposite', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p tcp ! --syn --dport 80 -j REDIRECT --to-ports 8080');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toBeNull();
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(ACK))).toEqual({ action: 'REDIRECT', address: '8080' });
  });

  it('PREROUTING : --tcp-flags SYN,ACK SYN,ACK takes the SYN-ACK only', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p tcp --tcp-flags SYN,ACK SYN,ACK -j DNAT --to-destination 10.0.0.77');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4({ syn: true, ack: true }))).toEqual({ action: 'DNAT', address: '10.0.0.77' });
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toBeNull();
  });

  it('POSTROUTING : --syn masquerades the SYN and not the data that follows', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A POSTROUTING -p tcp --syn -j MASQUERADE');
    expect(hooksOf(host).evaluateNat(tcp4(SYN), 'eth0', 'eth1')).toEqual({ action: 'MASQUERADE' });
    expect(hooksOf(host).evaluateNat(tcp4(ACK), 'eth0', 'eth1')).toBeNull();
  });

  it('IPv6 PREROUTING : --syn redirects the SYN and lets the ACK alone', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo ip6tables -t nat -A PREROUTING -p tcp --syn --dport 80 -j REDIRECT --to-ports 8080');
    expect(hooksOf(host).evaluatePreRouting6('eth0', tcp6(SYN))).toEqual({ action: 'REDIRECT', address: '8080' });
    expect(hooksOf(host).evaluatePreRouting6('eth0', tcp6(ACK))).toBeNull();
  });

  it('TEMOIN : a rule with no flag criterion decides the same way for both', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8080');
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(SYN))).toEqual({ action: 'REDIRECT', address: '8080' });
    expect(hooksOf(host).evaluatePreRouting('eth0', tcp4(ACK))).toEqual({ action: 'REDIRECT', address: '8080' });
  });
});

describe('the NAT hooks read the ICMP type of the packet', () => {
  it('PREROUTING : --icmp-type echo-request translates the request and not the reply', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p icmp --icmp-type echo-request -j DNAT --to-destination 10.9.9.9');
    expect(hooksOf(host).evaluatePreRouting('eth0', echo4('echo-request'))).toEqual({ action: 'DNAT', address: '10.9.9.9' });
    expect(hooksOf(host).evaluatePreRouting('eth0', echo4('echo-reply'))).toBeNull();
  });
});

describe('the NAT counters add the size of the packet, and the policy counts the packets that reach it', () => {
  it('a packet of 84 bytes adds 84 to the rule that takes it and nothing to the policy', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p icmp --icmp-type echo-request -j DNAT --to-destination 10.9.9.9');
    hooksOf(host).evaluatePreRouting('eth0', echo4('echo-request'));
    const listing = await host.executeCommand('sudo iptables -t nat -L PREROUTING -v -x -n');
    expect(listing).toMatch(/^Chain PREROUTING \(policy ACCEPT 0 packets, 0 bytes\)$/m);
    expect(listing).toMatch(/^\s*1\s+84\s+DNAT\s+icmp/m);
  });

  it('a packet that no rule takes is counted by the policy, with its size, and by no rule', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -t nat -A PREROUTING -p icmp --icmp-type echo-request -j DNAT --to-destination 10.9.9.9');
    hooksOf(host).evaluatePreRouting('eth0', echo4('echo-reply'));
    const listing = await host.executeCommand('sudo iptables -t nat -L PREROUTING -v -x -n');
    expect(listing).toMatch(/^Chain PREROUTING \(policy ACCEPT 1 packets, 84 bytes\)$/m);
    expect(listing).toMatch(/^\s*0\s+0\s+DNAT\s+icmp/m);
  });

  it('the policy of a filter chain counts the packets it decides, not the ones a rule decides', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
    const manager = (host as unknown as { executor: { iptables: { filterPacket(p: object): string } } }).executor.iptables;
    const packet = (dstPort: number) => ({ direction: 'in', protocol: 6, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: 40000, dstPort, iface: 'eth0', ipPacketBytes: 60 });
    manager.filterPacket(packet(22));
    manager.filterPacket(packet(80));
    expect(await host.executeCommand('sudo iptables -L INPUT -v -x -n')).toMatch(/^Chain INPUT \(policy ACCEPT 1 packets, 60 bytes\)$/m);
  });

  it('a packet whose size nobody declared adds no byte to the policy', async () => {
    const host = new LinuxPC('H', 0, 0);
    const manager = (host as unknown as { executor: { iptables: { filterPacket(p: object): string } } }).executor.iptables;
    manager.filterPacket({ direction: 'in', protocol: 6, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: 40000, dstPort: 80, iface: 'eth0' });
    expect(await host.executeCommand('sudo iptables -L INPUT -v -x -n')).toMatch(/^Chain INPUT \(policy ACCEPT 1 packets, 0 bytes\)$/m);
  });

  it('a UDP datagram that the host sends is counted by the nat OUTPUT chain with its IP length', async () => {
    const host = new LinuxPC('H', 0, 0);
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await host.executeCommand('sudo iptables -t nat -A OUTPUT -p udp --dport 5353 -j DNAT --to-destination 10.0.0.2');
    host.sendUdpDatagram(new IPAddress('10.0.0.3'), 5353, 4000, 'x'.repeat(100), 100);
    expect(await host.executeCommand('sudo iptables -t nat -L OUTPUT -v -x -n')).toMatch(/^\s*1\s+128\s+DNAT\s+udp/m);
  });
});

describe('the Oracle listener shortcut asks the INPUT chain about a SYN, not about a packet without flags', () => {
  it('-p tcp --syn --dport 1521 -j DROP refuses the connection, ! --syn does not', async () => {
    const host = new LinuxPC('H', 0, 0);
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await host.executeCommand('sudo iptables -A INPUT -p tcp ! --syn --dport 1521 -j DROP');
    expect(hooksOf(host).firewallAcceptsInboundTcp('10.0.0.9', '10.0.0.1', 1521)).toBe('accept');
    await host.executeCommand('sudo iptables -F INPUT');
    await host.executeCommand('sudo iptables -A INPUT -p tcp --syn --dport 1521 -j DROP');
    expect(hooksOf(host).firewallAcceptsInboundTcp('10.0.0.9', '10.0.0.1', 1521)).toBe('drop');
  });

  it('the SYN it stands for is the first fragment of nothing : a -f rule does not see it', async () => {
    const host = new LinuxPC('H', 0, 0);
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await host.executeCommand('sudo iptables -A INPUT -f -j DROP');
    expect(hooksOf(host).firewallAcceptsInboundTcp('10.0.0.9', '10.0.0.1', 1521)).toBe('accept');
  });

  it('the SYN it stands for is bare : 40 bytes of IP, no option', async () => {
    const host = new LinuxPC('H', 0, 0);
    host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await host.executeCommand('sudo iptables -A INPUT -p tcp --dport 1521 -j ACCEPT');
    hooksOf(host).firewallAcceptsInboundTcp('10.0.0.9', '10.0.0.1', 1521);
    expect(await host.executeCommand('sudo iptables -L INPUT -v -x -n')).toMatch(/^\s*1\s+40\s+ACCEPT\s+tcp/m);
  });
});
