/*
 * Sur VRP, `local-user … service-type` etait range, rendu — et ne decidait
 * de rien sur le fil.
 *
 * Mesure de depart, sur un AR1 et un commutateur HW2 en `authentication-mode
 * aaa`, `protocol inbound all`, STelnet et Telnet en service :
 *
 *   local-user admin service-type telnet    ssh admin@…      la session S'OUVRE
 *   local-user admin service-type ssh       telnet …         la session S'OUVRE
 *   local-user admin (aucun service-type)   ssh et telnet    les deux S'OUVRENT
 *
 * `NetworkOsAccount.allowsService` porte la regle et n'a AUCUN appelant ;
 * `CrossVendorSshHost` en porte une seconde copie, lue par le seul chemin
 * de contournement. Le serveur SSH et le serveur Telnet du fil n'en lisent
 * aucune.
 *
 * L'AUTORITE EST HUAWEI (`local-user service-type`) : la commande « sets
 * the access type for a local user » ; « by default, a local user cannot
 * use any access type ». Un compte sans `ssh` n'entre pas en STelnet, un
 * compte sans `telnet` n'entre pas en Telnet, un compte sans rien n'entre
 * nulle part. IOS n'a pas de type d'acces : un compte Cisco reste admis
 * partout, et c'est le TEMOIN de non-regression.
 *
 * LES VUES MENTAIENT DANS LE MEME SENS. Le commutateur rangeait
 * `local-user` dans une carte propre a son shell, que ni les serveurs ni
 * la configuration courante ne lisent : le compte disparaissait de
 * `display current-configuration`. Le routeur rendait `service-type ssh`
 * pour tout compte qui n'en portait aucun, et `display local-user` y
 * annoncait « (no local users configured) » quel que soit le magasin.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire les serveurs.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 9 des 16 cas tombent. Les 7 autres passent des deux cotes et sont les
 * TEMOINS : sur chaque plateforme, `service-type ssh` ouvre SSH,
 * `service-type telnet` ouvre Telnet, `service-type ssh telnet` ouvre les
 * deux — la restriction ne devient pas un refus general — et un compte
 * IOS entre partout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Lab {
  host: LinuxPC;
  ip: string;
  prompt: RegExp;
  version: string;
}

function accountLines(serviceType: string | null): string[] {
  return [
    'aaa', `local-user admin password cipher ${SECRET}`, 'local-user admin privilege level 15',
    ...(serviceType ? [`local-user admin service-type ${serviceType}`] : []),
    'quit',
  ];
}

const SERVERS = [
  'rsa local-key-pair create', 'stelnet server enable', 'telnet server enable',
  'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit',
];

async function routerLab(serviceType: string | null): Promise<Lab> {
  const device = new HuaweiRouter('AR1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(device.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);
  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0', 'ip address 10.0.0.1 24', 'undo shutdown', 'quit',
    ...accountLines(serviceType), ...SERVERS, 'return',
  ]) await device.executeCommand(c);
  await host.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await settle();
  return { host, ip: '10.0.0.1', prompt: /<AR1>/, version: 'display version' };
}

async function switchLab(serviceType: string | null): Promise<Lab> {
  const device = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const host = new LinuxPC('linux-pc', 'P4');
  host.getPort('eth0')!.configureIP(new IPAddress('10.0.3.10'), new SubnetMask('255.255.255.0'));
  new Cable('c4').connect(host.getPort('eth0')!, device.getPorts()[0]);
  for (const c of [
    'system-view', 'sysname HW2',
    'interface Vlanif1', 'ip address 10.0.3.2 255.255.255.0', 'undo shutdown', 'quit',
    ...accountLines(serviceType), ...SERVERS, 'return',
  ]) await device.executeCommand(c);
  await settle();
  return { host, ip: '10.0.3.2', prompt: /<HW2>/, version: 'display version' };
}

async function ciscoLab(): Promise<Lab> {
  const device = new CiscoRouter('R1', 0, 0);
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(device.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);
  for (const c of [
    'enable', 'configure terminal', 'hostname R1',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    `username admin privilege 15 secret ${SECRET}`, 'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'line vty 0 4', 'login local', 'transport input all', 'exit', 'end',
  ]) await device.executeCommand(c);
  await host.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await settle();
  return { host, ip: '10.0.0.1', prompt: /R1[>#]/, version: 'show version' };
}

const sshOpens = async ({ host, ip, version }: Lab): Promise<boolean> =>
  /VRP|Huawei|Cisco IOS/i.test(await host.executeCommand(
    `ssh admin@${ip} "${version}"`, `${SECRET}\n`));

const telnetOpens = async ({ host, ip, prompt }: Lab): Promise<boolean> =>
  prompt.test(await host.executeCommand(`telnet ${ip}`, `admin\n${SECRET}\nquit\n`));

for (const [platform, make] of [['routeur', routerLab], ['commutateur', switchLab]] as const) {
  describe(`${platform} VRP — le type d'acces decide`, () => {
    it('`service-type ssh` : la session SSH s\'ouvre — TEMOIN', async () => {
      expect(await sshOpens(await make('ssh'))).toBe(true);
    }, 30000);

    it('`service-type telnet` : la session Telnet s\'ouvre — TEMOIN', async () => {
      expect(await telnetOpens(await make('telnet'))).toBe(true);
    }, 30000);

    it('`service-type telnet` seul : SSH est refuse', async () => {
      expect(await sshOpens(await make('telnet'))).toBe(false);
    }, 30000);

    it('`service-type ssh` seul : Telnet est refuse', async () => {
      expect(await telnetOpens(await make('ssh'))).toBe(false);
    }, 30000);

    it('aucun `service-type` : ni SSH ni Telnet', async () => {
      const lab = await make(null);

      expect(await sshOpens(lab)).toBe(false);
      expect(await telnetOpens(lab)).toBe(false);
    }, 30000);

    it('`service-type ssh telnet` : les deux s\'ouvrent', async () => {
      const lab = await make('ssh telnet');

      expect(await sshOpens(lab)).toBe(true);
      expect(await telnetOpens(lab)).toBe(true);
    }, 30000);
  });
}

async function typedOn(device: HuaweiRouter | HuaweiSwitch, ...commands: string[]): Promise<void> {
  for (const c of ['system-view', ...commands, 'return']) await device.executeCommand(c);
}

describe('les vues disent le type d\'acces que le fil applique', () => {
  it('routeur : `display local-user` nomme le compte et ses types', async () => {
    const device = new HuaweiRouter('AR1');
    await typedOn(device, ...accountLines('ssh telnet'));

    expect(await device.executeCommand('display local-user')).toMatch(/^\s+admin\s+A\s+ssh,telnet\s+15$/m);
  }, 30000);

  it('commutateur : la configuration courante garde le compte et ses types', async () => {
    const device = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
    await typedOn(device, ...accountLines('ssh'));

    const config = await device.executeCommand('display current-configuration');
    expect(config).toMatch(/^ local-user admin privilege level 15$/m);
    expect(config).toMatch(/^ local-user admin service-type ssh$/m);
  }, 30000);

  it('routeur : un compte sans type n\'est pas rendu avec un type invente', async () => {
    const device = new HuaweiRouter('AR1');
    await typedOn(device, ...accountLines(null));

    expect(await device.executeCommand('display current-configuration'))
      .not.toMatch(/^ local-user admin service-type/m);
  }, 30000);
});

describe('IOS n\'a pas de type d\'acces', () => {
  it('un compte Cisco entre en SSH et en Telnet — TEMOIN de non-regression', async () => {
    const lab = await ciscoLab();

    expect(await sshOpens(lab)).toBe(true);
    expect(await telnetOpens(lab)).toBe(true);
  }, 30000);
});
