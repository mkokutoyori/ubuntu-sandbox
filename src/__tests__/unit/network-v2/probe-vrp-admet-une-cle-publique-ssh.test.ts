/*
 * Un routeur ou un commutateur VRP ne savait pas admettre un client SSH
 * par sa cle publique.
 *
 * Mesure de depart, sur un AR1 et un commutateur HW2 en STelnet :
 *   rsa peer-public-key k encoding-type openssh    refuse (commande inconnue)
 *   ssh user admin assign rsa-key k                refuse (« assign » inconnu)
 *   ssh -o PreferredAuthentications=publickey …    Permission denied : le
 *     contexte SSH des routeurs repond `false` a toute cle, un bouche-trou
 *     que son propre commentaire annonce
 *
 * L'AUTORITE EST HUAWEI : `rsa peer-public-key key-name [ encoding-type
 * { der | openssh | pem } ]` entre dans la vue « RSA public key » ;
 * `public-key-code begin` dans la vue « RSA key code », ou l'on colle la
 * cle du pair ; `public-key-code end` et `peer-public-key end` en
 * sortent. `ssh user … assign rsa-key key-name` attache la cle au compte,
 * `authentication-type rsa` ou `all` l'autorise, `password` l'exclut. Le
 * script public huawei-copy-ssh-public-key.sh (gist TerryGeng) tape
 * exactement cette suite. Les pages de support.huawei.com sont refusees
 * par le proxy de sortie ; les messages d'entree de vue sont ceux des
 * exemples de configuration Huawei.
 *
 * Les cles SSH du simulateur ne sont pas de vraies cles RSA
 * (`deriveKeyMaterial`) : une cle collee en OpenSSH se compare a ce que
 * le client presente, une cle DER n'a rien a quoi se comparer et ferme
 * la porte (regle 6, les criteres de securite echouent FERMES).
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire les vues.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 10 des 20 cas tombent. Passent des deux cotes, sur chaque plateforme,
 * le TEMOIN (le mot de passe ouvre la session par defaut) et les quatre
 * refus — une autre cle, une cle non attribuee, `authentication-type
 * password`, et le mot de passe sous `authentication-type rsa` — qu'aucune
 * cle n'ouvrant rien avant, ils ne pouvaient pas tomber ; ils prouvent
 * que la porte ouverte ne l'est que pour la bonne cle.
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

type Device = HuaweiRouter | HuaweiSwitch;

interface Lab {
  device: Device;
  host: LinuxPC;
  other: LinuxPC;
  ip: string;
  publicKey: string;
  otherPublicKey: string;
}

const SERVER = [
  'aaa', `local-user admin password cipher ${SECRET}`, 'local-user admin privilege level 15',
  'local-user admin service-type ssh', 'quit',
  'rsa local-key-pair create', 'stelnet server enable',
  'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
];

async function withKeys(device: Device, host: LinuxPC, other: LinuxPC, ip: string): Promise<Lab> {
  await settle();
  const keyOf = async (pc: LinuxPC) => {
    await pc.executeCommand("ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa");
    return (await pc.executeCommand('cat ~/.ssh/id_rsa.pub')).trim();
  };
  return { device, host, other, ip, publicKey: await keyOf(host), otherPublicKey: await keyOf(other) };
}

async function routerLab(): Promise<Lab> {
  const device = new HuaweiRouter('AR1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const other = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(device.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);
  new Cable('c3').connect(other.getPort('eth0')!, sw.getPorts()[2]);
  for (const c of [
    'system-view', 'interface GigabitEthernet 0/0/0', 'ip address 10.0.0.1 24', 'undo shutdown', 'quit',
    ...SERVER, 'return',
  ]) await device.executeCommand(c);
  await host.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await other.executeCommand('ifconfig eth0 10.0.0.3 netmask 255.255.255.0');
  return withKeys(device, host, other, '10.0.0.1');
}

async function switchLab(): Promise<Lab> {
  const device = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const host = new LinuxPC('linux-pc', 'P4');
  const other = new LinuxPC('linux-pc', 'P5');
  host.getPort('eth0')!.configureIP(new IPAddress('10.0.3.10'), new SubnetMask('255.255.255.0'));
  other.getPort('eth0')!.configureIP(new IPAddress('10.0.3.11'), new SubnetMask('255.255.255.0'));
  new Cable('c4').connect(host.getPort('eth0')!, device.getPorts()[0]);
  new Cable('c5').connect(other.getPort('eth0')!, device.getPorts()[1]);
  for (const c of [
    'system-view', 'sysname HW2', 'interface Vlanif1', 'ip address 10.0.3.2 255.255.255.0', 'undo shutdown', 'quit',
    ...SERVER, 'return',
  ]) await device.executeCommand(c);
  return withKeys(device, host, other, '10.0.3.2');
}

async function type(device: Device, lines: readonly string[]): Promise<string[]> {
  const answers: string[] = [];
  for (const line of ['system-view', ...lines, 'return']) answers.push(await device.executeCommand(line));
  return answers.slice(1, -1);
}

const peerKey = (name: string, code: string, encoding = 'openssh'): string[] => [
  `rsa peer-public-key ${name} encoding-type ${encoding}`, 'public-key-code begin', code, 'public-key-code end',
  'peer-public-key end',
];

const keyLogin = async ({ host, ip }: Lab, from: LinuxPC = host): Promise<boolean> =>
  /VRP|Huawei/i.test(await from.executeCommand(
    `ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no admin@${ip} "display version"`));

const passwordLogin = async ({ host, ip }: Lab): Promise<boolean> =>
  /VRP|Huawei/i.test(await host.executeCommand(
    `ssh -o PreferredAuthentications=password admin@${ip} "display version"`, `${SECRET}\n`));

for (const [platform, make] of [['router', routerLab], ['switch', switchLab]] as const) {
  describe(`VRP ${platform} — an SSH user admitted by its public key`, () => {
    it('the key views announce themselves as VRP does', async () => {
      const lab = await make();
      const answers = await type(lab.device, peerKey('k', lab.publicKey));

      expect(answers[0]).toBe('Enter "RSA public key" view, return system view with "peer-public-key end".');
      expect(answers[1]).toBe('Enter "RSA key code" view, return last view with "public-key-code end".');
    }, 30000);

    it('a password opens the session by default — WITNESS', async () => {
      expect(await passwordLogin(await make())).toBe(true);
    }, 30000);

    it('the assigned OpenSSH key opens the session', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey),
        'ssh user admin authentication-type rsa', 'ssh user admin assign rsa-key k']);

      expect(await keyLogin(lab)).toBe(true);
    }, 30000);

    it('another host\'s key does not', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey),
        'ssh user admin authentication-type rsa', 'ssh user admin assign rsa-key k']);

      expect(await keyLogin(lab, lab.other)).toBe(false);
    }, 30000);

    it('a key that is not assigned to the user does not either', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey), 'ssh user admin authentication-type rsa']);

      expect(await keyLogin(lab)).toBe(false);
    }, 30000);

    it('`authentication-type password` keeps the key out', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey),
        'ssh user admin authentication-type password', 'ssh user admin assign rsa-key k']);

      expect(await keyLogin(lab)).toBe(false);
    }, 30000);

    it('`authentication-type rsa` keeps the password out', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey),
        'ssh user admin authentication-type rsa', 'ssh user admin assign rsa-key k']);

      expect(await passwordLogin(lab)).toBe(false);
    }, 30000);

    it('`authentication-type all` lets both in', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey),
        'ssh user admin authentication-type all', 'ssh user admin assign rsa-key k']);

      expect(await keyLogin(lab)).toBe(true);
      expect(await passwordLogin(lab)).toBe(true);
    }, 30000);

    it('the configuration carries the key and its assignment', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('k', lab.publicKey), 'ssh user admin assign rsa-key k']);
      const config = await lab.device.executeCommand('display current-configuration');

      expect(config).toMatch(/^rsa peer-public-key k encoding-type openssh\n\s+public-key-code begin\n\s+ssh-rsa \S+.*\n\s+public-key-code end\n\s+peer-public-key end$/m);
      expect(config).toMatch(/^ssh user admin assign rsa-key k$/m);
    }, 30000);

    it('a DER key is kept, and vouches for no simulated key', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('d', '30818902818100C4A8 0203 010001', 'der'),
        'ssh user admin authentication-type rsa', 'ssh user admin assign rsa-key d']);

      expect(await lab.device.executeCommand('display current-configuration')).toMatch(/^rsa peer-public-key d$/m);
      expect(await keyLogin(lab)).toBe(false);
    }, 30000);
  });
}
