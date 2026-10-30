/**
 * Sonde — `netplan apply` lit tous les fichiers du répertoire, les fusionne comme netplan 0.104 (Ubuntu 22.04) et refuse
 * ce que la grammaire de netplan refuse.
 *
 * Mesure d'origine (lab NTP, section 0.9, fichier `/etc/netplan/50-lab.yaml`) : le simulateur ne lisait que
 * `/etc/netplan/01-netcfg.yaml`. Un second fichier, des `routes:` (`- to: default via: ...`) ou des `nameservers:` étaient
 * silencieusement ignorés, `netplan apply` rendait un succès muet qui ne changeait rien, et une faute de frappe dans une
 * clé n'était relevée par personne.
 *
 * Source de référence : le code C de netplan 0.104 (`parse.c`, `util.c`, `names.c`), téléchargé et lu — fichiers de
 * `{lib,etc,run}/netplan/*.yaml` triés par nom de base, séquences ajoutées d'un fichier à l'autre, scalaires écrasés,
 * `gateway4` : le premier gagne, adresses dédoublonnées et exigeant `/préfixe`, messages `<fichier>:<ligne>:<colonne>: Error
 * in network definition: <raison>` suivis de la ligne fautive et d'un `^`.
 *
 * Discrimination `git stash` : 8 cas tombent avant le correctif — « applies the addresses of a second file », « installs the
 * default route », « writes the nameservers », « appends the sequences », « applies the static data of an interface that
 * also asks for DHCP », « matches an interface by name pattern », « names the unknown key » et « refuses an address without
 * a prefix length ».
 *
 * Passent des deux côtés, et pourquoi :
 *  - « TEMOIN: the default file alone still configures the host » — prouve que le lab (câble, hôte) est sain.
 *  - « a single file declaring gateway4 still gives the default route » — NON-RÉGRESSION : l'ancienne forme reste honorée.
 *  - « overrides a scalar of an earlier file with the later one » et « applies nothing when one file of the directory is
 *    wrong » — ce sont des ABSENCES : avant, le second fichier n'étant pas lu, elles tiennent trivialement. Elles gardent le
 *    nouveau lecteur, et « applies the addresses of a second file » prouve dans le même état que le second fichier est lu,
 *    donc qu'elles ne sont pas vides après le correctif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab {
  readonly pc: LinuxPC;
  write(path: string, content: string): void;
  run(command: string): Promise<string>;
}

function lab(): Lab {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const switchCore = new CiscoSwitch('switch-cisco', 'SW1', 8);
  pc.powerOn();
  switchCore.powerOn();
  new Cable('c1').connect(pc.getPorts()[0], switchCore.getPorts()[0]);
  const vfs = (pc as unknown as {
    executor: { vfs: { createFileAt(path: string, content: string, mode: number, uid: number, gid: number): unknown } };
  }).executor.vfs;
  return {
    pc,
    write: (path, content) => { vfs.createFileAt(path, content, 0o644, 0, 0); },
    run: (command) => pc.executeCommand(command),
  };
}

const STATIC_01 = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: false\n      addresses: [192.168.9.5/24]\n';

const LAB_50 = [
  'network:', '  version: 2', '  ethernets:', '    eth0:', '      dhcp4: false',
  '      addresses:', '        - 10.10.0.11/24',
  '      routes:', '        - to: default', '          via: 10.10.0.1',
  '      nameservers:', '        addresses: [10.10.0.53, 10.10.0.54]', '        search: [lab.local]', '',
].join('\n');

describe('Probe — netplan reads every file of the directory', () => {
  it('TEMOIN: the default file alone still configures the host', async () => {
    const { write, run } = lab();
    write('/etc/netplan/01-netcfg.yaml', STATIC_01);
    await run('sudo netplan apply');
    expect(await run('ip -br addr show eth0')).toContain('192.168.9.5/24');
  }, 60_000);

  it('a single file declaring gateway4 still gives the default route', async () => {
    const { write, run } = lab();
    write('/etc/netplan/01-netcfg.yaml', `${STATIC_01}      gateway4: 192.168.9.1\n`);
    await run('sudo netplan apply');
    expect(await run('ip route')).toContain('default via 192.168.9.1 dev eth0');
  }, 60_000);

  it('applies the addresses of a second file', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', LAB_50);
    await run('sudo netplan apply');
    expect(await run('ip -br addr show eth0')).toContain('10.10.0.11/24');
  }, 60_000);

  it('installs the default route declared with routes:', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', LAB_50);
    await run('sudo netplan apply');
    expect(await run('ip route')).toContain('default via 10.10.0.1 dev eth0');
  }, 60_000);

  it('writes the nameservers and the search domain to resolv.conf', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', LAB_50);
    await run('sudo netplan apply');
    const resolver = await run('cat /etc/resolv.conf');
    expect(resolver).toContain('nameserver 10.10.0.53');
    expect(resolver).toContain('nameserver 10.10.0.54');
    expect(resolver).toContain('search lab.local');
  }, 60_000);

  it('overrides a scalar of an earlier file with the later one (dhcp4)', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', LAB_50);
    await run('sudo netplan apply');
    expect(await run('sudo journalctl -u systemd-networkd')).not.toContain('eth0: DHCPv4 client started');
  }, 60_000);

  it('appends the sequences of two files instead of replacing them', async () => {
    const { write, run } = lab();
    write('/etc/netplan/01-netcfg.yaml', STATIC_01);
    write('/etc/netplan/50-lab.yaml', LAB_50);
    await run('sudo netplan apply');
    const addresses = await run('ip -br addr show eth0');
    expect(addresses).toContain('192.168.9.5/24');
    expect(addresses).toContain('10.10.0.11/24');
  }, 60_000);

  it('applies the static data of an interface that also asks for DHCP', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', LAB_50.replace('dhcp4: false', 'dhcp4: true'));
    await run('sudo netplan apply');
    expect(await run('ip -br addr show eth0')).toContain('10.10.0.11/24');
  }, 60_000);

  it('matches an interface by name pattern, the first definition by name governing the link', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', [
      'network:', '  version: 2', '  ethernets:', '    alpha:', '      match:', '        name: eth*',
      '      dhcp4: false', '      addresses: [10.77.0.5/24]', '',
    ].join('\n'));
    await run('sudo netplan apply');
    expect(await run('ip -br addr show eth0')).toContain('10.77.0.5/24');
  }, 60_000);
});

describe('Probe — netplan refuses what its grammar refuses', () => {
  it('names the unknown key with its file, line and column, and exits with 1', async () => {
    const { write, run } = lab();
    write('/etc/netplan/60-bad.yaml', 'network:\n  version: 2\n  ethernets:\n    eth0:\n      adresses: [1.1.1.1/24]\n');
    const answer = await run('sudo netplan apply; echo "rc=$?"');
    expect(answer).toContain("/etc/netplan/60-bad.yaml:5:7: Error in network definition: unknown key 'adresses'");
    expect(answer).toContain('      adresses: [1.1.1.1/24]\n      ^');
    expect(answer).toContain('rc=1');
  }, 60_000);

  it('refuses an address without a prefix length', async () => {
    const { write, run } = lab();
    write('/etc/netplan/60-bad.yaml', 'network:\n  version: 2\n  ethernets:\n    eth0:\n      addresses: [1.1.1.1]\n');
    expect(await run('sudo netplan apply'))
      .toContain("Error in network definition: address '1.1.1.1' is missing /prefixlength");
  }, 60_000);

  it('applies nothing when one file of the directory is wrong', async () => {
    const { write, run } = lab();
    write('/etc/netplan/50-lab.yaml', LAB_50);
    write('/etc/netplan/60-bad.yaml', 'network:\n  version: 2\n  ethernets:\n    eth0:\n      adresses: [1.1.1.1/24]\n');
    await run('sudo netplan apply');
    expect(await run('ip -br addr show eth0')).not.toContain('10.10.0.11/24');
  }, 60_000);
});
