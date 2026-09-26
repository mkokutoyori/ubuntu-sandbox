/**
 * Un bail DHCP expire, au temps de l'equipement qui l'accorde.
 *
 * Mesure de depart : le serveur DHCP partage datait ses baux par
 * `Date.now()` et n'evaluait jamais leur echeance (`cleanExpiredBindings`
 * n'avait aucun appelant) : un bail vivait jusqu'a sa liberation ou son
 * effacement manuel, et une adresse abandonnee par un client debranche
 * n'etait plus jamais reattribuee. Les conflits enregistres ne
 * s'eteignaient pas davantage.
 *
 * Autorites :
 * - RFC 2131 §3.1 et §4.2 : a l'echeance du bail, l'adresse revient au
 *   serveur, qui peut l'attribuer a un autre client ;
 * - la note technique Fortinet « DHCP address leases on a FortiGate » :
 *   `execute dhcp lease-list` montre l'echeance de chaque bail, et un bail
 *   expire quitte la liste ;
 * - la reference CLI FortiOS 7.6.3, `config system dhcp server` :
 *   `lease-time` « 0 means unlimited » ; `conflicted-ip-timeout` « Time in
 *   seconds to wait after a conflicted IP address is removed from the DHCP
 *   range before it can be reused » (60 a 8640000, 1800 par defaut) ;
 * - Cisco IOS : `lease infinite`, et `show ip dhcp binding` imprime
 *   « Infinite » pour un tel bail.
 * L'echeance d'un bail illimite dans `execute dhcp lease-list` n'est
 * attestee nulle part : la colonne reste vide plutot que d'y inventer un
 * mot.
 *
 * Discrimination, mesuree sur le commit de base (8ab936d5) avec ce fichier
 * copie : 5 des 9 cas tombent. Passent des deux cotes : le TEMOIN (le
 * premier client prend l'unique adresse) ; « before the lease runs out » et
 * « before the timeout », deux absences que la base tient parce que rien
 * n'y expirait jamais, et qui gardent que l'echeance n'arrive pas trop
 * tot ; et « lease-time 0 is unlimited », qui passe sur la base pour la
 * meme raison — il a ete mesure seul : la correspondance 0 → illimite
 * retiree, le bail prend la duree par defaut d'un jour et l'adresse est
 * reattribuee deux jours plus tard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const SECOND = 1000;

async function fortiLab(server: readonly string[], range: readonly [string, string] = ['10.1.0.100', '10.1.0.100']) {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const lan = new GenericSwitch('switch-generic', 'LAN', 100, 0);
  new Cable('fgt-lan').connect(firewall.getPort('port2')!, lan.getPorts()[0]);
  await type(firewall, ['config system interface',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system dhcp server', 'edit 1', 'set interface "port2"',
    'set default-gateway 10.1.0.1', 'set netmask 255.255.255.0', ...server,
    'config ip-range', 'edit 1', `set start-ip ${range[0]}`, `set end-ip ${range[1]}`, 'next', 'end',
    'next', 'end']);
  let nextPort = 1;
  const plug = <T extends LinuxPC | WindowsPC>(host: T): { host: T; cable: Cable } => {
    const cable = new Cable(`lan-${nextPort}`);
    cable.connect(host.getPorts()[0], lan.getPorts()[nextPort]);
    nextPort += 1;
    return { host, cable };
  };
  return { firewall, plug };
}

async function lease(plug: (host: LinuxPC) => { host: LinuxPC; cable: Cable }, name: string) {
  const plugged = plug(new LinuxPC('linux-pc', name));
  await type(plugged.host, ['sudo dhclient eth0']);
  const address = /inet (\d+\.\d+\.\d+\.\d+)/.exec(await plugged.host.executeCommand('ip -4 addr show eth0'))?.[1];
  return { ...plugged, address };
}

describe('a FortiGate lease runs out on the FortiGate clock', () => {
  it('WITNESS: the first client takes the only address of the range', async () => {
    const { plug } = await fortiLab(['set lease-time 300']);
    expect((await lease(plug, 'A')).address).toBe('10.1.0.100');
  });

  it('before the lease runs out, the address of an unplugged client is not offered again', async () => {
    const { plug } = await fortiLab(['set lease-time 300']);
    const first = await lease(plug, 'A');
    first.cable.disconnect();
    clock.advance(200 * SECOND);
    expect((await lease(plug, 'B')).address).toBeUndefined();
  });

  it('once the lease has run out, the same address goes to the next client', async () => {
    const { plug } = await fortiLab(['set lease-time 300']);
    const first = await lease(plug, 'A');
    first.cable.disconnect();
    clock.advance(400 * SECOND);
    expect((await lease(plug, 'B')).address).toBe('10.1.0.100');
  });

  it('execute dhcp lease-list drops the lease that ran out', async () => {
    const { firewall, plug } = await fortiLab(['set lease-time 300']);
    const first = await lease(plug, 'A');
    const listed = await firewall.executeCommand('execute dhcp lease-list');
    expect(listed).toContain('10.1.0.100');
    first.cable.disconnect();
    clock.advance(400 * SECOND);
    expect(await firewall.executeCommand('execute dhcp lease-list')).not.toContain('10.1.0.100');
  });

  it('lease-time 0 is unlimited: two days later the address is still held', async () => {
    const { firewall, plug } = await fortiLab(['set lease-time 0']);
    const first = await lease(plug, 'A');
    first.cable.disconnect();
    clock.advance(2 * 86_400 * SECOND);
    expect((await lease(plug, 'B')).address).toBeUndefined();
    expect(await firewall.executeCommand('execute dhcp lease-list')).toContain('10.1.0.100');
  });
});

describe('a declined address stays out of the range for conflicted-ip-timeout', () => {
  async function declinedLab(server: readonly string[]) {
    const lab = await fortiLab(server, ['10.1.0.100', '10.1.0.101']);
    const squatter = lab.plug(new LinuxPC('linux-pc', 'SQUATTER'));
    await type(squatter.host, ['sudo ip addr add 10.1.0.100/24 dev eth0', 'sudo ip link set eth0 up']);
    const windows = lab.plug(new WindowsPC('windows-pc', 'WIN'));
    await windows.host.executeCommand('ipconfig /renew');
    expect((await lease(lab.plug, 'C1')).address).toBe('10.1.0.101');
    squatter.cable.disconnect();
    return lab;
  }

  it('before the timeout, the declined address is not offered', async () => {
    const { plug } = await declinedLab(['set conflicted-ip-timeout 60']);
    clock.advance(30 * SECOND);
    expect((await lease(plug, 'C2')).address).toBeUndefined();
  });

  it('after the timeout, the declined address is offered again', async () => {
    const { plug } = await declinedLab(['set conflicted-ip-timeout 60']);
    clock.advance(120 * SECOND);
    expect((await lease(plug, 'C2')).address).toBe('10.1.0.100');
  });

  it('the default timeout is 1800 seconds', async () => {
    const { plug } = await declinedLab([]);
    clock.advance(120 * SECOND);
    expect((await lease(plug, 'C2')).address).toBeUndefined();
    clock.advance(1800 * SECOND);
    expect((await lease(plug, 'C3')).address).toBe('10.1.0.100');
  });
});

describe('an infinite IOS lease is shown as Infinite', () => {
  it('show ip dhcp binding prints Infinite for a pool with lease infinite', async () => {
    const router = new CiscoRouter('R1', 0, 0);
    const client = new LinuxPC('linux-pc', 'PC');
    new Cable('r1-pc').connect(router.getPort('GigabitEthernet0/0')!, client.getPorts()[0]);
    await type(router, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 192.168.1.1 192.168.1.99',
      'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'lease infinite', 'end']);
    await type(client, ['sudo dhclient eth0']);
    const binding = (await router.executeCommand('show ip dhcp binding')).split('\n')
      .find((line) => line.startsWith('192.168.1.100'));
    expect(binding).toContain('Infinite');
  });
});
