/**
 * `config system dhcp server` : le schema existait, `onCommit` etait VIDE.
 *
 * La table etait declaree, stockee, rendue par `show` — et lue par
 * personne. C'est exactement la famille de defaut que ce module passe son
 * temps a refermer : une valeur affichee que rien ne soutient. Le socle
 * DHCP du depot est complet (`DHCPServer`, `DhcpServerExchange`,
 * `DHCPClient`) et sert deja le routeur, le commutateur et Windows
 * Server ; le travail est de le brancher, pas de le reecrire.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **Un vrai client obtient un vrai bail.** Le client est un
 *      `LinuxPC` du depot qui envoie un vrai DISCOVER — aucun raccourci
 *      d'objet a objet.
 *   2. **Ce que le bail transporte est ce que la CLI a declare** :
 *      passerelle, masque, DNS, domaine.
 *   3. **`execute dhcp lease-list`** montre le bail reellement attribue.
 *   4. **`set status disable` eteint vraiment le service** — un serveur
 *      declare puis desactive ne doit rien servir.
 *   5. **Une interface en `mode dhcp` est un vrai CLIENT** : elle obtient
 *      son adresse d'un serveur voisin.
 *
 * Discrimination (`git stash push -- src/network/`) : 6 des 8 cas tombent
 * avant correctif. Les deux autres sont nommes ici plutot que laisses a
 * decouvrir — le rendu de `show` (le schema existait deja, seul son
 * `onCommit` etait vide) et le temoin NEGATIF « sans plage declaree ».
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);

  new Cable('lan').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up']);

  return { fw, sh, poste };
}

function serveurDhcp(sh: FortiShell): string {
  return run(sh,
    'config system dhcp server',
    'edit 1',
    'set interface "port1"',
    'set default-gateway 192.168.1.1',
    'set netmask 255.255.255.0',
    'set dns-server1 192.168.1.53',
    'set domain "lab.local"',
    'set lease-time 3600',
    'config ip-range', 'edit 1',
    'set start-ip 192.168.1.100', 'set end-ip 192.168.1.150', 'next', 'end',
    'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('config system dhcp server', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    serveurDhcp(sh);

    const rendu = sh.execute('show system dhcp server');
    expect(rendu).toMatch(/set interface "port1"/);
    expect(rendu).toMatch(/set start-ip 192\.168\.1\.100/);
    expect(rendu).toMatch(/set end-ip 192\.168\.1\.150/);
  });

  it('un vrai client obtient un vrai bail dans la plage declaree', async () => {
    const { sh, poste } = await laboratoire();
    serveurDhcp(sh);

    await runOn(poste, ['dhclient eth0']);

    const adresses = await poste.executeCommand('ip -4 addr show eth0');
    expect(adresses).toMatch(/192\.168\.1\.(1[0-4][0-9]|150|100)/);
  });

  it('le bail transporte la passerelle et le DNS declares', async () => {
    const { sh, poste } = await laboratoire();
    serveurDhcp(sh);

    await runOn(poste, ['dhclient eth0']);

    expect(await poste.executeCommand('ip route')).toMatch(/default via 192\.168\.1\.1/);
    expect(await poste.executeCommand('cat /etc/resolv.conf'))
      .toMatch(/nameserver 192\.168\.1\.53/);
  });

  it('`execute dhcp lease-list` montre le bail reellement attribue', async () => {
    const { sh, poste } = await laboratoire();
    serveurDhcp(sh);
    await runOn(poste, ['dhclient eth0']);

    const vue = sh.execute('execute dhcp lease-list');
    expect(vue).toMatch(/192\.168\.1\.1[0-5][0-9]/);
    expect(vue).toMatch(new RegExp(poste.getPort('eth0')!.getMAC().toString(), 'i'));
  });

  it('`set status disable` eteint vraiment le service', async () => {
    const { sh, poste } = await laboratoire();
    serveurDhcp(sh);
    await runOn(poste, ['dhclient eth0']);
    expect(await poste.executeCommand('ip -4 addr show eth0'))
      .toMatch(/192\.168\.1\.1[0-5][0-9]/);

    run(sh, 'config system dhcp server', 'edit 1', 'set status disable', 'next', 'end');
    await runOn(poste, ['dhclient -r eth0', 'dhclient eth0']);

    expect(await poste.executeCommand('ip -4 addr show eth0'))
      .not.toMatch(/192\.168\.1\.1[0-5][0-9]/);
  });

  it('sans plage declaree, rien n`est attribue', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system dhcp server', 'edit 1',
      'set interface "port1"', 'set default-gateway 192.168.1.1',
      'set netmask 255.255.255.0', 'next', 'end');

    await runOn(poste, ['dhclient eth0']);

    expect(await poste.executeCommand('ip -4 addr show eth0')).not.toMatch(/192\.168\.1\.1[0-9][0-9]/);
  });

  it('deux clients du meme segment recoivent deux adresses differentes', async () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const sh = new FortiShell(fw);
    const commutateur = new GenericSwitch('switch-generic', 'SW', 8, -150, 0);
    const poste = new LinuxPC('linux-pc', 'PC', -300, 0);
    const second = new LinuxPC('linux-pc', 'PC2', -300, 120);

    new Cable('u').connect(fw.getPort('port1')!, commutateur.getPort('eth0')!);
    new Cable('a').connect(poste.getPort('eth0')!, commutateur.getPort('eth1')!);
    new Cable('b').connect(second.getPort('eth0')!, commutateur.getPort('eth2')!);

    run(sh, 'config system interface', 'edit "port1"', 'set mode static',
      'set ip 192.168.1.1 255.255.255.0', 'next', 'end');
    await runOn(poste, ['ip link set eth0 up']);
    await runOn(second, ['ip link set eth0 up']);
    serveurDhcp(sh);

    await runOn(poste, ['dhclient eth0']);
    await runOn(second, ['dhclient eth0']);

    const un = await poste.executeCommand('ip -4 addr show eth0');
    const deux = await second.executeCommand('ip -4 addr show eth0');
    const adresse = (t: string) => /192\.168\.1\.(\d+)/.exec(t)?.[0];
    expect(adresse(un)).toBeDefined();
    expect(adresse(deux)).toBeDefined();
    expect(adresse(un)).not.toBe(adresse(deux));
  });
});

describe('config system interface — mode dhcp', () => {
  it('une interface en `mode dhcp` obtient une adresse d`un vrai serveur', async () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

    const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const sh = new FortiShell(fw);
    const amont = new CiscoRouter('R1', 200, 0);
    new Cable('wan').connect(fw.getPort('port2')!, amont.getPort('GigabitEthernet0/0')!);

    await runOn(amont, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 203.0.113.1 255.255.255.0',
      'no shutdown', 'exit',
      'ip dhcp excluded-address 203.0.113.1 203.0.113.99',
      'ip dhcp pool WAN', 'network 203.0.113.0 255.255.255.0',
      'default-router 203.0.113.1', 'end',
    ]);

    run(sh, 'config system interface', 'edit "port2"', 'set mode dhcp', 'next', 'end');

    expect(fw.getInterfaceTable().get('port2')?.ip).toMatch(/^203\.0\.113\./);
  });
});
