/**
 * `net.ipv4.conf.<if>.arp_notify` (Documentation/networking/ip-sysctl.rst et net/ipv4/devinet.c, noyau v6.8) : quand le
 * reglage vaut 1 (maximum de `all` et de l'interface), le noyau emet, a la mise en service de l'interface (NETDEV_UP) et
 * au changement d'adresse materielle (NETDEV_CHANGEADDR), une requete ARP gratuite (sip = tip = l'adresse) pour CHAQUE
 * adresse IPv4 de l'interface, adresses secondaires comprises. Le fichier etait une CONSTANTE `0` en lecture seule :
 * `sysctl -w` etait refuse et rien n'etait annonce (regle 6). Corrige : le reglage vit dans Ipv4DeviceConf, comme
 * arp_ignore, et `arp_accept` y a ete deplace (il etait lu dans un fichier du VFS : deux ecritures du meme fait).
 *
 * Banc : A (10.0.0.1/24, arp_accept = 1 pour apprendre d'une annonce) --switch-- B (eth0 10.0.0.2/24 + secondaire
 * 10.0.0.3/24). On lit la table de voisins de A : seule une annonce y laisse une entree, A n'ayant rien demande.
 *
 * Discrimine par `git stash` sur src/network : 5 des 6 cas tombent avant. TEMOIN : sans arp_notify, ni mise en service
 * ni changement de MAC ne laisse d'entree chez A (et la relecture de la valeur par defaut).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let a: LinuxPC;
let b: LinuxPC;

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  a = new LinuxPC('linux-pc', 'A');
  b = new LinuxPC('linux-pc', 'B');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  a.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), mask);
  b.getPort('eth0')!.addSecondaryIP(new IPAddress('10.0.0.3'), mask);
  new Cable('ca').connect(a.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('cb').connect(b.getPort('eth0')!, sw.getPort('eth1')!);
  await run(a, 'sysctl -w net.ipv4.conf.all.arp_accept=1');
});

const run = async (device: LinuxPC, command: string): Promise<string> => {
  const machine = device as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
};

const neighbours = (): Promise<string> => run(a, 'ip neigh show');

describe('arp_notify', () => {
  it('WITNESS — the default is 0 and an interface coming up announces nothing', async () => {
    expect(await run(b, 'cat /proc/sys/net/ipv4/conf/eth0/arp_notify')).toBe('0');
    await run(b, 'ip link set eth0 down');
    await run(b, 'ip link set eth0 up');
    expect(await neighbours()).not.toContain('10.0.0.2');
  });

  it('is writable, per interface and in all', async () => {
    expect(await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_notify=1')).toContain('net.ipv4.conf.eth0.arp_notify = 1');
    expect(await run(b, 'cat /proc/sys/net/ipv4/conf/eth0/arp_notify')).toBe('1');
  });

  it('an interface coming up announces its primary address', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_notify=1');
    await run(b, 'ip link set eth0 down');
    await run(b, 'ip link set eth0 up');
    expect(await neighbours()).toContain('10.0.0.2');
  });

  it('every address of the interface is announced, secondaries included', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_notify=1');
    await run(b, 'ip link set eth0 down');
    await run(b, 'ip link set eth0 up');
    expect(await neighbours()).toContain('10.0.0.3');
  });

  it('the maximum of all and the interface is used', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.all.arp_notify=1');
    await run(b, 'ip link set eth0 down');
    await run(b, 'ip link set eth0 up');
    expect(await neighbours()).toContain('10.0.0.2');
  });

  it('a new hardware address is announced', async () => {
    await run(b, 'sysctl -w net.ipv4.conf.eth0.arp_notify=1');
    await run(b, 'ip link set eth0 address 02:00:00:00:00:99');
    expect(await neighbours()).toContain('02:00:00:00:00:99');
  });
});
