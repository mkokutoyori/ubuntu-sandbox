/*
 * Sur VRP, `ssh user …` etait accepte sans un mot, jamais rendu, et ne
 * restreignait rien.
 *
 * Mesure de depart, sur un AR1 et un commutateur HW2 portant une paire RSA,
 * STelnet en service, une vty en `authentication-mode aaa` et un compte
 * local `service-type ssh` :
 *
 *   ssh user admin authentication-type rsa     ssh admin@… (mot de passe)
 *                                              la session S'OUVRE
 *   ssh user admin service-type sftp           la session STelnet S'OUVRE
 *   undo ssh authentication-type default password
 *                                              la session S'OUVRE
 *   display current-configuration              aucune ligne `ssh user`
 *   undo ssh user admin                        Error: Unrecognized command
 *
 * L'AUTORITE EST HUAWEI :
 *  - `ssh user authentication-type` : le mode d'authentification de
 *    l'utilisateur SSH — `password`, une cle seule (`rsa`, `dsa`, `ecc`),
 *    les deux a la fois (`password-rsa`, …), ou l'un ou l'autre (`all`).
 *  - `ssh user service-type { sftp | stelnet | all }` : les services
 *    auxquels l'utilisateur SSH a droit.
 *  - `ssh authentication-type default password` : depuis V200R011C10,
 *    le mode par defaut des utilisateurs SSH qui n'en declarent pas ;
 *    sans lui, « a new SSH user cannot log in to the SSH server unless
 *    being configured with an authentication mode ».
 *
 * CE QUE LE SIMULATEUR NE SAIT PAS FAIRE : il ne verifie pas de cle
 * publique d'utilisateur SSH sur un boitier VRP (`assign rsa-key` n'est pas
 * branche). Un mode qui EXIGE une cle — seule ou avec le mot de passe —
 * echoue donc ferme : la session est refusee, jamais ouverte sur le seul
 * mot de passe. Un `service-type` que l'utilisateur SSH ne declare pas
 * n'est pas source pour le refus : il reste permissif.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le code.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 14 des 20 cas tombent. Les 6 autres, trois par plateforme :
 *
 *  - TEMOINS : `password` + `stelnet`, et `all`, ouvrent la session des
 *    deux cotes — la restriction ne devient pas un refus general.
 *  - « un utilisateur declare `password` entre toujours » passe A VIDE
 *    avant, rien n'etant restreint ; son voisin « un utilisateur non
 *    declare est refuse » separe les deux etats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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
  device: HuaweiRouter | HuaweiSwitch;
  host: LinuxPC;
  ip: string;
  answers: string[];
}

const BASE = [
  'aaa', `local-user admin password cipher ${SECRET}`,
  'local-user admin privilege level 15', 'local-user admin service-type ssh', 'quit',
  'rsa local-key-pair create', 'stelnet server enable',
  'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
];

async function configure(device: HuaweiRouter | HuaweiSwitch, extra: string[]): Promise<string[]> {
  const answers: string[] = [];
  for (const c of ['system-view', ...BASE]) await device.executeCommand(c);
  for (const c of extra) answers.push(await device.executeCommand(c));
  await device.executeCommand('return');
  return answers;
}

async function routerLab(...extra: string[]): Promise<Lab> {
  const device = new HuaweiRouter('AR1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(device.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);
  for (const c of ['system-view', 'interface GigabitEthernet 0/0/0', 'ip address 10.0.0.1 24',
    'undo shutdown', 'return']) await device.executeCommand(c);
  const answers = await configure(device, extra);
  await host.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await settle();
  return { device, host, ip: '10.0.0.1', answers };
}

async function switchLab(...extra: string[]): Promise<Lab> {
  const device = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const host = new LinuxPC('linux-pc', 'P4');
  host.getPort('eth0')!.configureIP(new IPAddress('10.0.3.10'), new SubnetMask('255.255.255.0'));
  new Cable('c4').connect(host.getPort('eth0')!, device.getPorts()[0]);
  for (const c of ['system-view', 'interface Vlanif1', 'ip address 10.0.3.2 255.255.255.0',
    'undo shutdown', 'return']) await device.executeCommand(c);
  const answers = await configure(device, extra);
  await settle();
  return { device, host, ip: '10.0.3.2', answers };
}

const sshOpens = async ({ host, ip }: Lab): Promise<boolean> =>
  /VRP|Huawei/i.test(await host.executeCommand(`ssh admin@${ip} "display version"`, `${SECRET}\n`));

for (const [platform, make] of [['routeur', routerLab], ['commutateur', switchLab]] as const) {
  describe(`${platform} — \`ssh user\` decide`, () => {
    it('`password` et `stelnet` : la session s\'ouvre — TEMOIN', async () => {
      expect(await sshOpens(await make(
        'ssh user admin authentication-type password', 'ssh user admin service-type stelnet',
      ))).toBe(true);
    }, 30000);

    it('`authentication-type rsa` : le mot de passe seul est refuse', async () => {
      expect(await sshOpens(await make('ssh user admin authentication-type rsa'))).toBe(false);
    }, 30000);

    it('`authentication-type password-rsa` : sans cle verifiable, refuse', async () => {
      expect(await sshOpens(await make('ssh user admin authentication-type password-rsa'))).toBe(false);
    }, 30000);

    it('`authentication-type all` : le mot de passe suffit — TEMOIN', async () => {
      expect(await sshOpens(await make('ssh user admin authentication-type all'))).toBe(true);
    }, 30000);

    it('`service-type sftp` : la session STelnet est refusee', async () => {
      expect(await sshOpens(await make(
        'ssh user admin authentication-type password', 'ssh user admin service-type sftp',
      ))).toBe(false);
    }, 30000);

    it('`undo ssh authentication-type default password` : un utilisateur non declare est refuse', async () => {
      expect(await sshOpens(await make('undo ssh authentication-type default password'))).toBe(false);
    }, 30000);

    it('… et un utilisateur declare `password` entre toujours', async () => {
      expect(await sshOpens(await make(
        'undo ssh authentication-type default password', 'ssh user admin authentication-type password',
      ))).toBe(true);
    }, 30000);

    it('`undo ssh user admin` est accepte et leve la restriction', async () => {
      const lab = await make('ssh user admin authentication-type rsa', 'undo ssh user admin');

      expect(lab.answers[1]).toBe('');
      expect(await sshOpens(lab)).toBe(true);
    }, 30000);

    it('la configuration courante porte l\'utilisateur SSH', async () => {
      const { device } = await make(
        'ssh user admin authentication-type password', 'ssh user admin service-type stelnet');

      const config = await device.executeCommand('display current-configuration');
      expect(config).toMatch(/^ssh user admin authentication-type password$/m);
      expect(config).toMatch(/^ssh user admin service-type stelnet$/m);
    }, 30000);

    it('une valeur inconnue est refusee', async () => {
      const { answers } = await make(
        'ssh user admin authentication-type zorglub', 'ssh user admin service-type zorglub');

      expect(answers[0]).toMatch(/^Error:/);
      expect(answers[1]).toMatch(/^Error:/);
    }, 30000);
  });
}
