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
