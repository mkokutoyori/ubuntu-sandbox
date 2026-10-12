/**
 * `diagnose sniffer packet` évalue la même grammaire de filtre que tcpdump (BPF : `ether host`, `not`, `net`, `src`/`dst`, `portrange`, `tcp[tcpflags]`…)
 * parce qu'elle EST celle de libpcap, et le dépôt n'en porte qu'une (TcpdumpFilter). Les niveaux de détail suivent le tableau du tutoriel FortiGate :
 * 1 et 4 n'impriment que l'en-tête, 2 et 5 ajoutent les données IP en hexadécimal, 3 et 6 ajoutent l'en-tête Ethernet ; le quatrième argument `a` donne
 * l'heure absolue.
 *
 * MESURÉ avant correctif : un mini-analyseur ne connaissait que host/src/dst/port/tcp/udp/icmp/arp ; `not arp`, `ether host`, `net`, `vlan`, `or` entre
 * critères distincts étaient refusés (« unsupported sniffer filter expression »), les niveaux 2, 3, 5, 6 n'imprimaient aucun octet et `a` était ignoré.
 * Avant correctif (git stash de src/network) 7 cas sur 9 tombent ; deux cas passent dans les deux états : le témoin (`icmp` et `host` simples) et le refus d'une expression incorrecte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.clear(); });

const run = (d: unknown, c: string) => (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function lab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
  await run(pc, 'ip link set eth0 up');
  for (const c of ['config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']) await run(fgt, c);
  await run(pc, 'ping -c 2 192.168.10.1');
  return { fgt, pc, mac: fgt.getPort('port2')!.getMAC().toString() };
}

const sniff = (fgt: unknown, filter: string, level = 4, count = 0, tail = '') =>
  run(fgt, `diagnose sniffer packet port2 '${filter}' ${level} ${count} ${tail}`.trim());

describe('renifleur FortiGate : grammaire BPF et niveaux de détail', () => {
  it('témoin : icmp et host simples', async () => {
    const { fgt } = await lab();
    expect(await sniff(fgt, 'icmp')).toContain('icmp: echo request');
    expect(await sniff(fgt, 'host 192.168.10.10')).toContain('192.168.10.10 -> 192.168.10.1');
  });

  it('not arp écarte les trames ARP', async () => {
    const { fgt } = await lab();
    const out = await sniff(fgt, 'not arp');
    expect(out).toContain('icmp');
    expect(out).not.toContain('arp who-has');
  });

  it('ether host sélectionne par adresse MAC', async () => {
    const { fgt, mac } = await lab();
    expect(await sniff(fgt, `ether host ${mac}`)).toContain('192.168.10.10 -> 192.168.10.1');
    expect(await sniff(fgt, 'ether host 00:11:22:33:44:55')).toContain('0 packets received by filter');
  });

  it('net et src/dst combinés par or', async () => {
    const { fgt } = await lab();
    expect(await sniff(fgt, 'net 192.168.10.0/24 and not arp')).toContain('icmp');
    expect(await sniff(fgt, 'src host 192.168.10.1 or dst port 53')).toContain('192.168.10.1 -> 192.168.10.10');
    expect(await sniff(fgt, 'net 10.0.0.0/8')).toContain('0 packets received by filter');
  });

  it("une expression incorrecte est refusée avec le message de l'analyseur", async () => {
    const { fgt } = await lab();
    const out = await sniff(fgt, 'host and');
    expect(out).toContain('Command fail');
  });

  it('niveau 4 : en-tête seul, sans octets', async () => {
    const { fgt } = await lab();
    expect(await sniff(fgt, 'icmp', 4)).not.toMatch(/^0x0000/m);
  });

  it('niveau 5 : en-tête + données IP en hexadécimal (début 45 = IPv4)', async () => {
    const { fgt } = await lab();
    const out = await sniff(fgt, 'icmp', 5, 1);
    expect(out).toMatch(/^0x0000 {3}45/m);
  });

  it("niveau 6 : en-tête Ethernet comprise, les 6 premiers octets sont l'adresse MAC de destination", async () => {
    const { fgt, mac } = await lab();
    const out = await sniff(fgt, 'icmp and dst host 192.168.10.1', 6, 1);
    const first = /^0x0000 {3}(\S+) (\S+) (\S+)/m.exec(out)!;
    expect(`${first[1]}${first[2]}${first[3]}`).toBe(mac.replace(/:/g, '').toLowerCase().slice(0, 12));
  });

  it("le quatrième argument « a » donne l'heure absolue", async () => {
    const { fgt } = await lab();
    expect(await sniff(fgt, 'icmp', 4, 1, 'a')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6} port2 -- /m);
  });
});
