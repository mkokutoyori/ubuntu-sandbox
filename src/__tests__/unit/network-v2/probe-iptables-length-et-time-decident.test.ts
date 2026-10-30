/**
 * `-m length` et `-m time` : deux correspondances que le vrai iptables accepte et que le moteur peut DECIDER avec les faits qu'il a deja
 * (la taille du paquet IP, l'horloge de simulation), donc qu'il decide au lieu de les ranger sans effet (iptables 1.8.7 libxt_length.c,
 * libxt_time.c ; noyau xt_length : `(skb->len >= min && skb->len <= max) ^ invert`, xt_time : fenetre horaire, jours de semaine et du mois).
 *
 * Mesure de depart : `length` etait acceptee mais ne correspondait a rien (une regle `-m length ... -j DROP` ne jetait rien) et `time`
 * etait refusee. Les attendus de `-L` sont les `*_print` de la source (« length ! 100:200 », « TIME from 09:00:00 to 17:00:00 UTC »).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import type { LinuxIptablesManager, PacketInfo } from '@/network/devices/linux/LinuxIptablesManager';

interface Firewalled { executor: { iptables: LinuxIptablesManager } }

const packet = (extra: Partial<PacketInfo> = {}): PacketInfo => ({
  direction: 'in', protocol: 6, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: 40000, dstPort: 80, iface: 'eth0', ipPacketBytes: 60, ...extra,
});

async function verdict(rule: string, facts: PacketInfo): Promise<string> {
  const host = new LinuxPC('H', 0, 0);
  const answer = await host.executeCommand(`sudo iptables -A INPUT ${rule}`);
  expect(answer, rule).toBe('');
  return (host as unknown as Firewalled).executor.iptables.filterPacket(facts);
}

async function listed(rule: string): Promise<string> {
  const host = new LinuxPC('H', 0, 0);
  await host.executeCommand(`sudo iptables -A INPUT ${rule}`);
  return (await host.executeCommand('sudo iptables -L INPUT -n')).split('\n')[2].slice(60).trim();
}

describe('-m length', () => {
  it('une plage : dedans la regle correspond, dehors elle ne correspond pas', async () => {
    expect(await verdict('-m length --length 100:200 -j DROP', packet({ ipPacketBytes: 150 }))).toBe('drop');
    expect(await verdict('-m length --length 100:200 -j DROP', packet({ ipPacketBytes: 99 }))).toBe('accept');
    expect(await verdict('-m length --length 100:200 -j DROP', packet({ ipPacketBytes: 201 }))).toBe('accept');
  });

  it('une valeur seule est une egalite', async () => {
    expect(await verdict('-m length --length 60 -j DROP', packet())).toBe('drop');
    expect(await verdict('-m length --length 61 -j DROP', packet())).toBe('accept');
  });

  it('le « ! » inverse', async () => {
    expect(await verdict('-m length ! --length 100:200 -j DROP', packet({ ipPacketBytes: 150 }))).toBe('accept');
    expect(await verdict('-m length ! --length 100:200 -j DROP', packet({ ipPacketBytes: 50 }))).toBe('drop');
  });

  it('se liste comme length_print', async () => {
    expect(await listed('-m length --length 100:200 -j DROP')).toBe('length 100:200');
    expect(await listed('-m length ! --length 60 -j DROP')).toBe('length !60');
  });
});

describe('-m ttl (libipt_ttl.c, ipt_ttl.c : eq, ne, lt, gt sur le TTL du paquet)', () => {
  it('--ttl-eq, --ttl-gt et --ttl-lt', async () => {
    expect(await verdict('-m ttl --ttl-eq 64 -j DROP', packet({ ttl: 64 }))).toBe('drop');
    expect(await verdict('-m ttl --ttl-eq 64 -j DROP', packet({ ttl: 63 }))).toBe('accept');
    expect(await verdict('-m ttl --ttl-gt 10 -j DROP', packet({ ttl: 11 }))).toBe('drop');
    expect(await verdict('-m ttl --ttl-gt 10 -j DROP', packet({ ttl: 10 }))).toBe('accept');
    expect(await verdict('-m ttl --ttl-lt 10 -j DROP', packet({ ttl: 9 }))).toBe('drop');
    expect(await verdict('-m ttl --ttl-lt 10 -j DROP', packet({ ttl: 10 }))).toBe('accept');
  });

  it('« ! --ttl-eq » est « different de »', async () => {
    expect(await verdict('-m ttl ! --ttl-eq 64 -j DROP', packet({ ttl: 63 }))).toBe('drop');
    expect(await verdict('-m ttl ! --ttl-eq 64 -j DROP', packet({ ttl: 64 }))).toBe('accept');
  });

  it('sans le fait « ttl », la regle ne correspond pas (echec ferme)', async () => {
    expect(await verdict('-m ttl --ttl-eq 64 -j DROP', packet())).toBe('accept');
  });
});

describe('le TTL d\'un vrai paquet recu arrive a la regle', () => {
  async function pingWith(rule: string): Promise<string> {
    const srv = new LinuxServer('linux-server', 'SRV');
    const cli = new LinuxServer('linux-server', 'CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    srv.powerOn();
    cli.powerOn();
    new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await srv.executeCommand(`iptables -A INPUT ${rule}`);
    return cli.executeCommand('ping -c 1 -W 1 10.0.0.2');
  }

  it('TTL 64 de l\'emetteur : la regle sur 64 jette l\'echo, celle sur 63 le laisse passer', async () => {
    expect(await pingWith('-p icmp -m ttl --ttl-eq 64 -j DROP')).toContain('100% packet loss');
    expect(await pingWith('-p icmp -m ttl --ttl-eq 63 -j DROP')).toContain('0% packet loss');
  });
});

describe('-m addrtype (xt_addrtype : le type de la route de l\'adresse, exclusif)', () => {
  it('--dst-type et --src-type lisent le type fourni avec le paquet', async () => {
    expect(await verdict('-m addrtype --dst-type LOCAL -j DROP', packet({ dstAddrType: 'LOCAL' }))).toBe('drop');
    expect(await verdict('-m addrtype --dst-type LOCAL -j DROP', packet({ dstAddrType: 'UNICAST' }))).toBe('accept');
    expect(await verdict('-m addrtype --dst-type BROADCAST,MULTICAST -j DROP', packet({ dstAddrType: 'MULTICAST' }))).toBe('drop');
    expect(await verdict('-m addrtype --src-type UNICAST -j DROP', packet({ srcAddrType: 'UNICAST' }))).toBe('drop');
  });

  it('« ! » inverse, et sans le fait la regle ne correspond pas', async () => {
    expect(await verdict('-m addrtype ! --dst-type LOCAL -j DROP', packet({ dstAddrType: 'UNICAST' }))).toBe('drop');
    expect(await verdict('-m addrtype --dst-type LOCAL -j DROP', packet())).toBe('accept');
  });

  it('un vrai paquet : l\'echo vers une adresse de la machine est LOCAL, vers une autre non', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    const cli = new LinuxServer('linux-server', 'CLI');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    srv.powerOn();
    cli.powerOn();
    new Cable('a').connect(srv.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(cli.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await srv.executeCommand('iptables -A INPUT -p icmp -m addrtype --dst-type LOCAL -j DROP');
    expect(await cli.executeCommand('ping -c 1 -W 1 10.0.0.2')).toContain('100% packet loss');
    await srv.executeCommand('iptables -F');
    await srv.executeCommand('iptables -A INPUT -p icmp -m addrtype --dst-type UNICAST -j DROP');
    expect(await cli.executeCommand('ping -c 1 -W 1 10.0.0.2')).toContain('0% packet loss');
  });
});

describe('-m connlimit (xt_connlimit : connexions suivies par adresse masquee, la connexion courante comptee si elle est nouvelle)', () => {
  const syn = (port: number, src = '10.0.0.2'): PacketInfo => packet({ srcIP: src, srcPort: port, dstPort: 22, tcpFlags: 0x02, ipPacketBytes: 60 });

  async function limited(rule: string, sources: Array<[string, number]>, probe: PacketInfo): Promise<string> {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
    const manager = (host as unknown as Firewalled).executor.iptables;
    for (const [src, port] of sources) manager.filterPacket(syn(port, src), {});
    return manager.filterPacket(probe, {});
  }

  async function limitedWithDefaultDrop(rule: string, sources: Array<[string, number]>, probe: PacketInfo): Promise<string> {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
    const manager = (host as unknown as Firewalled).executor.iptables;
    for (const [src, port] of sources) manager.filterPacket(syn(port, src), {});
    await host.executeCommand('sudo iptables -P INPUT DROP');
    return manager.filterPacket(probe, {});
  }

  it('au-dela de la limite la regle correspond', async () => {
    const rule = '-p tcp --dport 22 -m connlimit --connlimit-above 2 -j DROP';
    const two: Array<[string, number]> = [['10.0.0.2', 40001], ['10.0.0.2', 40002]];
    expect(await limited(rule, two, syn(40003))).toBe('drop');
    expect(await limited(rule, two.slice(0, 1), syn(40003))).toBe('accept');
  });

  it('--connlimit-upto est « ! --connlimit-above »', async () => {
    const two: Array<[string, number]> = [['10.0.0.2', 40001], ['10.0.0.2', 40002]];
    expect(await limitedWithDefaultDrop('-p tcp -m connlimit --connlimit-upto 2 -j ACCEPT', two, syn(40003))).toBe('drop');
    expect(await limitedWithDefaultDrop('-p tcp -m connlimit --connlimit-upto 2 -j ACCEPT', two.slice(0, 1), syn(40003))).toBe('accept');
    expect(await limitedWithDefaultDrop('-p tcp -m connlimit ! --connlimit-above 5 -j ACCEPT', two, syn(40003))).toBe('accept');
  });

  it('chaque adresse a son compteur, sauf sous un masque qui les regroupe', async () => {
    const others: Array<[string, number]> = [['10.0.0.3', 40001], ['10.0.0.4', 40002]];
    expect(await limited('-p tcp -m connlimit --connlimit-above 2 -j DROP', others, syn(40003))).toBe('accept');
    expect(await limited('-p tcp -m connlimit --connlimit-above 2 --connlimit-mask 24 -j DROP', others, syn(40003))).toBe('drop');
  });

  it('se liste comme connlimit_print4', async () => {
    const host = new LinuxPC('H', 0, 0);
    await host.executeCommand('sudo iptables -A INPUT -p tcp -m connlimit --connlimit-above 10 --connlimit-mask 24 -j DROP');
    await host.executeCommand('sudo iptables -A INPUT -p tcp -m connlimit --connlimit-upto 3 --connlimit-daddr -j DROP');
    const lines = (await host.executeCommand('sudo iptables -L INPUT -n')).split('\n');
    expect(lines[2]).toContain('#conn src/24 > 10');
    expect(lines[3]).toContain('#conn dst/32 <= 3');
  });

  it('une regle sans --connlimit-above ni --connlimit-upto est refusee', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -A INPUT -p tcp -m connlimit -j DROP'))
      .toContain('You must specify "--connlimit-above" or "--connlimit-upto".');
  });
});

describe('-m time', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2024-03-04T10:30:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('une fenetre horaire en UTC', async () => {
    expect(await verdict('-m time --timestart 09:00 --timestop 17:00 -j DROP', packet())).toBe('drop');
    expect(await verdict('-m time --timestart 11:00 --timestop 17:00 -j DROP', packet())).toBe('accept');
  });

  it('une fenetre qui passe minuit', async () => {
    vi.setSystemTime(new Date('2024-03-04T23:00:00Z'));
    expect(await verdict('-m time --timestart 22:00 --timestop 06:00 -j DROP', packet())).toBe('drop');
    vi.setSystemTime(new Date('2024-03-04T12:00:00Z'));
    expect(await verdict('-m time --timestart 22:00 --timestop 06:00 -j DROP', packet())).toBe('accept');
  });

  it('les jours de la semaine (le 4 mars 2024 est un lundi)', async () => {
    expect(await verdict('-m time --weekdays Mon,Tue -j DROP', packet())).toBe('drop');
    expect(await verdict('-m time --weekdays Wed -j DROP', packet())).toBe('accept');
    expect(await verdict('-m time ! --weekdays Sat,Sun -j DROP', packet())).toBe('drop');
  });

  it('les jours du mois', async () => {
    expect(await verdict('-m time --monthdays 4 -j DROP', packet())).toBe('drop');
    expect(await verdict('-m time --monthdays 5,6 -j DROP', packet())).toBe('accept');
  });

  it('une plage de dates', async () => {
    expect(await verdict('-m time --datestart 2024-03-01T00:00:00 --datestop 2024-03-31T23:59:59 -j DROP', packet())).toBe('drop');
    expect(await verdict('-m time --datestart 2024-04-01T00:00:00 -j DROP', packet())).toBe('accept');
  });

  it('se liste comme time_print', async () => {
    expect(await listed('-m time --timestart 09:00 --timestop 17:00 -j DROP')).toBe('TIME from 09:00:00 to 17:00:00 UTC');
    expect(await listed('-m time --weekdays Mon,Tue -j DROP')).toBe('TIME on Mon,Tue UTC');
    expect(await listed('-m time --monthdays 4,22 -j DROP')).toBe('TIME on 4th,22nd UTC');
    expect(await listed('-m time --timestart 09:00 --kerneltz -j DROP')).toBe('TIME from 09:00:00 to 23:59:59');
  });

  it('une heure hors bornes est refusee dans les mots de la source', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -A INPUT -m time --timestart 25:00 -j DROP'))
      .toContain('invalid time "25:00" specified, should be hh:mm[:ss] format and within the boundaries');
  });

  it('TEMOIN : sans la regle time, rien ne change', async () => {
    expect(await verdict('-p tcp -j DROP', packet())).toBe('drop');
  });
});
