/**
 * `/sys/class/net` porte les compteurs que cinq autres vues comptent.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : deux postes cables sur un
 * commutateur, trois `ping`, puis la MEME question a chaque vue.
 *
 * ```
 * ip -s link show eth0                       RX 685 / 8     TX 752 / 9
 * ifconfig eth0                              RX 685 / 8     TX 752 / 9
 * ethtool -S eth0                            rx_packets: 8  tx_packets: 9
 * cat /proc/net/dev                          685  8 … 752  9
 * netstat -i                                 RX-OK 8        TX-OK 9
 * cat /sys/class/net/eth0/statistics/rx_packets
 *                                            No such file or directory
 * ```
 *
 * Cinq vues d'accord, et la sixieme absente. `/sys/class/net/<if>/`
 * porte pourtant deja `address`, `mtu`, `operstate`, `carrier`, `speed`
 * — mais pas `statistics/`, ni `ifindex`. Or `/sys` est la source que
 * lit un script de supervision : Prometheus, collectd, munin et
 * `node_exporter` lisent les compteurs LA, pas dans `ifconfig`. Un
 * laboratoire de metrologie n'avait donc rien a lire.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Les noms de fichiers sont RELEVES sur la machine reelle qui execute ce
 * depot (`ls /sys/class/net/eth0/statistics/`), qui en porte vingt-quatre.
 * Ce simulateur ne mesure que huit d'entre eux ; les autres valent zero,
 * ce qui est le compte JUSTE : rien ici ne produit d'erreur de trame, de
 * collision ni de depassement de file.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 7 cas sur 9 tombent contre l'etat d'avant. Les DEUX autres
 * sont les TEMOINS, et c'est leur role : les cinq vues deja d'accord,
 * qui servent de reference a tout ce qui precede et dont la sixieme ne
 * doit surtout pas s'ecarter ; et les attributs que `/sys` portait deja
 * (`operstate`, `mtu`, `address`), qui prouvent qu'en ajoutant
 * `statistics/` et `ifindex` on n'a pas deplace l'arbre existant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';

interface Poste {
  executeCommand(cmd: string): Promise<string>;
  getPort(name: string): never;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

/** Deux postes cables, ayant echange de vraies trames. */
async function laboAyantEchange(): Promise<Poste> {
  const a = createDevice('linux-pc', 0, 0) as unknown as Poste;
  const b = createDevice('linux-pc', 200, 0) as unknown as Poste;
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  new Cable('c1').connect(a.getPort('eth0'), sw.getPort('eth0')!);
  new Cable('c2').connect(b.getPort('eth0'), sw.getPort('eth1')!);
  await a.executeCommand('sudo ip addr add 10.0.0.1/24 dev eth0');
  await a.executeCommand('sudo ip link set eth0 up');
  await b.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await b.executeCommand('sudo ip link set eth0 up');
  await a.executeCommand('ping -c 3 10.0.0.2');
  return a;
}

async function lire(pc: Poste, chemin: string): Promise<string> {
  return (await pc.executeCommand(`cat ${chemin}`)).trim();
}

describe('/sys porte les compteurs que les autres vues comptent', () => {
  it('rx_packets est celui d ethtool', async () => {
    const pc = await laboAyantEchange();

    const parEthtool = /rx_packets: (\d+)/
      .exec(await pc.executeCommand('ethtool -S eth0'))?.[1] ?? '<absent>';

    expect(Number(parEthtool)).toBeGreaterThan(0);
    expect(await lire(pc, '/sys/class/net/eth0/statistics/rx_packets')).toBe(parEthtool);
  });

  it('les quatre compteurs principaux suivent /proc/net/dev', async () => {
    const pc = await laboAyantEchange();

    const ligne = (await pc.executeCommand('cat /proc/net/dev')).split('\n')
      .find((l) => l.trim().startsWith('eth0:'))?.trim().split(/\s+/) ?? [];
    const [rxBytes, rxPackets] = [ligne[1], ligne[2]];
    const [txBytes, txPackets] = [ligne[9], ligne[10]];

    expect(await lire(pc, '/sys/class/net/eth0/statistics/rx_bytes')).toBe(rxBytes);
    expect(await lire(pc, '/sys/class/net/eth0/statistics/rx_packets')).toBe(rxPackets);
    expect(await lire(pc, '/sys/class/net/eth0/statistics/tx_bytes')).toBe(txBytes);
    expect(await lire(pc, '/sys/class/net/eth0/statistics/tx_packets')).toBe(txPackets);
  });

  it('ce que la machine ne mesure pas vaut zero, pas rien', async () => {
    const pc = await laboAyantEchange();

    for (const nom of ['collisions', 'rx_fifo_errors', 'tx_carrier_errors', 'multicast']) {
      expect(await lire(pc, `/sys/class/net/eth0/statistics/${nom}`)).toBe('0');
    }
  });

  it('une interface qui n a rien vu porte des zeros', async () => {
    const pc = await laboAyantEchange();

    expect(await lire(pc, '/sys/class/net/eth1/statistics/rx_packets')).toBe('0');
  });

  it('la boucle locale en a aussi', async () => {
    const pc = await laboAyantEchange();

    expect(await lire(pc, '/sys/class/net/lo/statistics/rx_packets')).toMatch(/^\d+$/);
  });
});

describe('ifindex designe l interface comme ip link la numerote', () => {
  it('eth0 porte le numero que ip link affiche', async () => {
    const pc = await laboAyantEchange();

    const parIpLink = /^(\d+): eth0:/m
      .exec(await pc.executeCommand('ip link show eth0'))?.[1] ?? '<absent>';

    expect(await lire(pc, '/sys/class/net/eth0/ifindex')).toBe(parIpLink);
  });

  it('la boucle locale est la premiere', async () => {
    const pc = await laboAyantEchange();

    expect(await lire(pc, '/sys/class/net/lo/ifindex')).toBe('1');
  });
});

describe('TEMOINS', () => {
  it('les cinq vues deja d accord le restent', async () => {
    const pc = await laboAyantEchange();

    const parEthtool = /rx_packets: (\d+)/
      .exec(await pc.executeCommand('ethtool -S eth0'))?.[1] ?? '<a>';
    const parIfconfig = /RX packets (\d+)/
      .exec(await pc.executeCommand('ifconfig eth0'))?.[1] ?? '<b>';
    const parIpLink = /RX:.*\n\s*\d+\s+(\d+)/
      .exec(await pc.executeCommand('ip -s link show eth0'))?.[1] ?? '<c>';
    const parNetstat = (await pc.executeCommand('netstat -i')).split('\n')
      .find((l) => l.startsWith('eth0'))?.trim().split(/\s+/)[2] ?? '<d>';

    expect(parIfconfig).toBe(parEthtool);
    expect(parIpLink).toBe(parEthtool);
    expect(parNetstat).toBe(parEthtool);
  });

  it('les attributs que /sys portait deja ne bougent pas', async () => {
    const pc = await laboAyantEchange();

    expect(await lire(pc, '/sys/class/net/eth0/operstate')).toBe('up');
    expect(await lire(pc, '/sys/class/net/eth0/mtu')).toBe('1500');
    expect(await lire(pc, '/sys/class/net/eth0/address')).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  });
});
