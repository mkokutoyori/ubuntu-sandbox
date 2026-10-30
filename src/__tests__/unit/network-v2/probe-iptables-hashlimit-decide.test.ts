/**
 * `-m hashlimit` : un seau de jetons par cle (iptables 1.8.7 libxt_hashlimit.c ; noyau xt_hashlimit.c). Le debit `N/unite` donne un
 * cout `avg = 1 000 000 * unite / N` (microsecondes par paquet), `--hashlimit-burst` la capacite (5 par defaut), la cle vient de
 * `--hashlimit-mode` (srcip, srcport, dstip, dstport ; vide = une seule cle) apres masquage, et la table est partagee par NOM. `upto`
 * correspond tant qu'il reste du credit, `above` quand il n'en reste plus. Une table pleine (`--hashlimit-htable-max`) jette le paquet.
 * Les debits en octets (`b/s`) sont refuses en le disant ; `--hashlimit-rate-match` / `--hashlimit-rate-interval` ne sont pas evalues,
 * donc la regle ne correspond pas (echec ferme).
 *
 * Mesure de depart : accepte et liste en texte brut, mais ne correspondait jamais.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { LinuxIptablesManager, PacketInfo } from '@/network/devices/linux/LinuxIptablesManager';

interface Firewalled { executor: { iptables: LinuxIptablesManager } }

const packet = (extra: Partial<PacketInfo> = {}): PacketInfo => ({
  direction: 'in', protocol: 6, srcIP: '10.0.0.2', dstIP: '10.0.0.1', srcPort: 40000, dstPort: 80, iface: 'eth0', ipPacketBytes: 60, ...extra,
});


async function ready(rule: string, policy = 'ACCEPT') {
  const host = new LinuxPC('H', 0, 0);
  expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
  await host.executeCommand(`sudo iptables -P INPUT ${policy}`);
  const manager = (host as unknown as Firewalled).executor.iptables;
  return { host, send: (extra: Partial<PacketInfo> = {}): string => manager.filterPacket(packet(extra)) };
}

async function listed(rule: string): Promise<string> {
  const host = new LinuxPC('H', 0, 0);
  expect(await host.executeCommand(`sudo iptables -A INPUT ${rule}`)).toBe('');
  return (await host.executeCommand('sudo iptables -L INPUT -n')).split('\n')[2].slice(60).trim();
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2024-03-04T10:30:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('above : correspond quand le credit est epuise', () => {
  const RULE = '-m hashlimit --hashlimit-above 2/sec --hashlimit-burst 3 --hashlimit-mode srcip --hashlimit-name a -j DROP';

  it('les trois premiers paquets passent, le quatrieme est jete', async () => {
    const { send } = await ready(RULE);
    expect([send(), send(), send(), send()]).toEqual(['accept', 'accept', 'accept', 'drop']);
  });

  it('une seconde rend deux jetons', async () => {
    const { send } = await ready(RULE);
    for (let i = 0; i < 4; i++) send();
    vi.setSystemTime(new Date('2024-03-04T10:30:01Z'));
    expect([send(), send(), send()]).toEqual(['accept', 'accept', 'drop']);
  });

  it('chaque adresse source a son seau', async () => {
    const { send } = await ready(RULE);
    for (let i = 0; i < 4; i++) send();
    expect(send({ srcIP: '10.0.0.9' })).toBe('accept');
  });

  it('sans mode, une seule cle pour tout le monde', async () => {
    const { send } = await ready('-m hashlimit --hashlimit-above 1/sec --hashlimit-burst 2 --hashlimit-name b -j DROP');
    expect([send(), send({ srcIP: '10.0.0.8' }), send({ srcIP: '10.0.0.9' })]).toEqual(['accept', 'accept', 'drop']);
  });

  it('un masque regroupe les adresses (srcmask 24)', async () => {
    const { send } = await ready('-m hashlimit --hashlimit-above 1/sec --hashlimit-burst 2 --hashlimit-mode srcip --hashlimit-srcmask 24 --hashlimit-name c -j DROP');
    expect([send({ srcIP: '10.0.0.3' }), send({ srcIP: '10.0.0.4' }), send({ srcIP: '10.0.0.5' })]).toEqual(['accept', 'accept', 'drop']);
  });
});

describe('upto : correspond tant qu\'il reste du credit', () => {
  it('ACCEPT sous le debit, politique DROP au-dessus', async () => {
    const { send } = await ready('-m hashlimit --hashlimit-upto 1/sec --hashlimit-burst 2 --hashlimit-mode srcip --hashlimit-name d -j ACCEPT', 'DROP');
    expect([send(), send(), send()]).toEqual(['accept', 'accept', 'drop']);
  });

  it('« ! --hashlimit-upto » est « above »', async () => {
    const { send } = await ready('-m hashlimit ! --hashlimit-upto 1/sec --hashlimit-burst 1 --hashlimit-name e -j DROP');
    expect([send(), send()]).toEqual(['accept', 'drop']);
  });
});

describe('table', () => {
  it('une table pleine jette le paquet d une cle nouvelle', async () => {
    const { send } = await ready('-m hashlimit --hashlimit-upto 100/sec --hashlimit-mode srcip --hashlimit-htable-max 2 --hashlimit-name f -j ACCEPT', 'ACCEPT');
    expect([send({ srcIP: '10.0.1.1' }), send({ srcIP: '10.0.1.2' }), send({ srcIP: '10.0.1.3' })]).toEqual(['accept', 'accept', 'drop']);
  });

  it('une cle inactive plus longtemps que htable-expire est oubliee (seau plein de nouveau)', async () => {
    const { send } = await ready('-m hashlimit --hashlimit-above 1/hour --hashlimit-burst 1 --hashlimit-mode srcip --hashlimit-htable-expire 1000 --hashlimit-name g -j DROP');
    expect([send(), send()]).toEqual(['accept', 'drop']);
    vi.setSystemTime(new Date('2024-03-04T10:30:05Z'));
    expect(send()).toBe('accept');
  });
});

describe('-L et refus', () => {
  it('se liste comme hashlimit_mt_print', async () => {
    expect(await listed('-m hashlimit --hashlimit-upto 10/sec --hashlimit-mode srcip --hashlimit-name x -j ACCEPT')).toBe('limit: up to 10/sec burst 5 mode srcip');
    expect(await listed('-m hashlimit --hashlimit-above 5/min --hashlimit-burst 8 --hashlimit-mode dstip,dstport --hashlimit-name x -j DROP')).toBe('limit: above 5/min burst 8 mode dstip-dstport');
    expect(await listed('-m hashlimit --hashlimit-upto 2/hour --hashlimit-name x -j ACCEPT')).toBe('limit: up to 2/hour burst 5');
    expect(await listed('-m hashlimit --hashlimit-upto 10/sec --hashlimit-htable-size 100 --hashlimit-htable-expire 5000 --hashlimit-srcmask 24 --hashlimit-mode srcip --hashlimit-name x -j ACCEPT'))
      .toBe('limit: up to 10/sec burst 5 mode srcip htable-size 100 htable-expire 5000 srcmask 24');
  });

  it('refus dans les mots de la source', async () => {
    const host = new LinuxPC('H', 0, 0);
    expect(await host.executeCommand('sudo iptables -A INPUT -m hashlimit --hashlimit-name x -j DROP')).toContain('You have to specify --hashlimit');
    expect(await host.executeCommand('sudo iptables -A INPUT -m hashlimit --hashlimit-upto 0/sec --hashlimit-name x -j DROP'))
      .toContain('hashlimit: Bad value for "--hashlimit-upto" option: "0/sec"');
    expect(await host.executeCommand('sudo iptables -A INPUT -m hashlimit --hashlimit-upto 1/sec --hashlimit-mode foo --hashlimit-name x -j DROP'))
      .toContain('hashlimit: Bad value for "--hashlimit-mode" option: "foo"');
    expect(await host.executeCommand('sudo iptables -A INPUT -m hashlimit --hashlimit-upto 100kb/s --hashlimit-name x -j DROP'))
      .toContain('byte rates (b/s) are not supported by this simulator');
  });
});
