/**
 * `net.ipv4.conf.<if>.arp_ignore` (Documentation/networking/ip-sysctl.rst, lu sur raw.githubusercontent.com/torvalds/linux
 * v6.8) fixe quand un hote repond a un ARP qui resout une adresse LOCALE : 0 pour toute adresse locale de toute interface,
 * 1 seulement si l'adresse est configuree sur l'interface qui recoit, 2 en plus si l'emetteur est dans le meme sous-reseau
 * sur cette interface, 3 ne repond pas aux adresses de portee « host » mais, le noyau cherchant sur TOUTES les interfaces (arp.c : `in_dev = NULL`), repond encore pour l'adresse d'une autre interface, 8 ne repond a rien ; « le maximum de
 * conf/{all,interface} est utilise ». Le fichier etait une CONSTANTE `0` en lecture seule : `sysctl -w` etait refuse et
 * l'hote repondait toujours (regle 6). Corrige : le reglage est inscriptible par interface, `all` et `default` compris,
 * et l'hote Linux decide de sa reponse (et de ce qu'il apprend de la demande) avec le maximum des deux.
 * `arp_announce` reste en lecture seule : un hote du simulateur n'a qu'une adresse principale par interface, ses trois
 * niveaux ne se distingueraient pas (TODO.md [sysctl]). Les valeurs reservees 4 a 7 se comportent comme 0, seule garantie
 * du texte (« reserved »).
 *
 * Banc : A (10.0.0.1/24) --switch-- B (eth0 10.0.0.2/24, eth1 192.168.1.2/24 sans cable). A ARPe 192.168.1.2 sur son lien
 * (route d'hote `dev eth0`) : adresse locale de B, mais sur une AUTRE interface que celle qui recoit.
 *
 * Discrimine par `git stash` sur src/network : 5 des 8 premiers cas tombent avant le lot arp_ignore ; le neuvieme (mode 3) tombait encore apres lui, le mode 3 ayant ete lu comme le mode 1, et ne tombe plus. TEMOINS : le defaut 0 (la voisine repond), le
 * mode 1 pour l'adresse de l'interface qui recoit, et la valeur lue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let a: LinuxPC;
let b: LinuxPC;

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  a = new LinuxPC('linux-pc', 'A');
  b = new LinuxPC('linux-pc', 'B');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  a.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), mask);
  b.getPort('eth1')!.configureIP(new IPAddress('192.168.1.2'), mask);
  new Cable('ca').connect(a.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('cb').connect(b.getPort('eth0')!, sw.getPort('eth1')!);
});

const run = async (device: LinuxPC, command: string): Promise<string> => {
  const machine = device as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
};

const reaches = async (target: string): Promise<boolean> => {
  await run(a, `ip route replace ${target}/32 dev eth0`);
  return (await run(a, `ping -c 1 -W 1 ${target}`)).includes('1 received');
};

describe('arp_ignore', () => {
  it('WITNESS — by default B answers for the address of its other interface (mode 0)', async () => {
    expect(await reaches('192.168.1.2')).toBe(true);
  });

  it('is writable per interface and read back', async () => {
    expect(await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=1')).toContain('net.ipv4.conf.eth0.arp_ignore = 1');
    expect(await run(b, 'cat /proc/sys/net/ipv4/conf/eth0/arp_ignore')).toBe('1');
  });

  it('mode 1 on the receiving interface: no answer for the address of another interface', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=1');
    expect(await reaches('192.168.1.2')).toBe(false);
  });

  it('WITNESS — mode 1 still answers for the address configured on the receiving interface', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=1');
    expect(await reaches('10.0.0.2')).toBe(true);
  });

  it('the maximum of all and the interface is used', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.all.arp_ignore=1');
    expect(await reaches('192.168.1.2')).toBe(false);
  });

  it('mode 2 answers when the sender is in the target subnet of the receiving interface', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=2');
    expect(await reaches('10.0.0.2')).toBe(true);
    expect(await reaches('192.168.1.2')).toBe(false);
  });

  it('mode 8 answers for nothing, not even the receiving interface address', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=8');
    expect(await reaches('10.0.0.2')).toBe(false);
  });

  it('mode 3 still answers for the address of another interface', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=3');
    expect(await reaches('192.168.1.2')).toBe(true);
    expect(await reaches('10.0.0.2')).toBe(true);
  });

  it('a reserved value behaves like 0', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_ignore=5');
    expect(await reaches('192.168.1.2')).toBe(true);
  });
});
