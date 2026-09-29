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
 * Depuis que `ssh-keygen` fabrique de vraies cles RSA, une cle collee en
 * DER se compare aussi : son code est l'hexadecimal d'un RSAPublicKey
 * PKCS#1 (RFC 8017 A.1.1), SEQUENCE { n, e }. Les exemples Huawei le
 * montrent : « 3082010A 02820101 … », une SEQUENCE dont le premier
 * element est directement l'entier n, ce qu'un SubjectPublicKeyInfo
 * n'est pas. Le premier etat de cette sonde attendait qu'une cle DER
 * n'ouvre rien, faute de vraies cles ; ce cas est remplace par ses deux
 * suites, la bonne cle en DER ouvre, celle d'un autre hote non. La forme
 * PEM de VRP n'a pas pu etre lue (support.huawei.com refuse par le
 * proxy) : elle est gardee et rendue, et n'ouvre rien (regle 6).
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire les vues.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 10 des 20 cas tombent ; puis, pour la cle DER, contre d934022ee : ses
 * deux cas « la cle du client en DER ouvre la session » tombent. Passent
 * des deux cotes, sur chaque plateforme, le TEMOIN (le mot de passe ouvre
 * la session par defaut) et les cinq refus — une autre cle, en OpenSSH
 * puis en DER, une cle non attribuee, `authentication-type password`, et
 * le mot de passe sous `authentication-type rsa` — qu'aucune cle
 * n'ouvrant rien avant, ils ne pouvaient pas tomber ; ils prouvent que la
 * porte ouverte ne l'est que pour la bonne cle.
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
import { base64ToBytes } from '@/crypto/encoding';

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
  `rsa peer-public-key ${name} encoding-type ${encoding}`, 'public-key-code begin', ...code.split('\n'), 'public-key-code end',
  'peer-public-key end',
];

function derKeyCode(publicLine: string): string {
  const blob = base64ToBytes(publicLine.split(/\s+/)[1]);
  let at = 0;
  const field = (): Uint8Array => {
    const length = (blob[at] << 24) | (blob[at + 1] << 16) | (blob[at + 2] << 8) | blob[at + 3];
    const out = blob.slice(at + 4, at + 4 + length);
    at += 4 + length;
    return out;
  };
  field();
  const e = field();
  const n = field();
  const derLength = (length: number): number[] => {
    if (length < 0x80) return [length];
    const bytes: number[] = [];
    for (let v = length; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return [0x80 | bytes.length, ...bytes];
  };
  const integer = (magnitude: Uint8Array): number[] => {
    let body = [...magnitude];
    while (body.length > 1 && body[0] === 0 && (body[1] & 0x80) === 0) body = body.slice(1);
    if (body[0] & 0x80) body = [0, ...body];
    return [0x02, ...derLength(body.length), ...body];
  };
  const content = [...integer(n), ...integer(e)];
  const der = [0x30, ...derLength(content.length), ...content];
  const hex = der.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const groups = hex.match(/.{1,8}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 6) lines.push(groups.slice(i, i + 6).join(' '));
  return lines.join('\n');
}

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

    it('the client key pasted as a DER key code opens the session', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('d', derKeyCode(lab.publicKey), 'der'),
        'ssh user admin authentication-type rsa', 'ssh user admin assign rsa-key d']);

      expect(await lab.device.executeCommand('display current-configuration')).toMatch(/^rsa peer-public-key d$/m);
      expect(await keyLogin(lab)).toBe(true);
    }, 30000);

    it('another host\'s key as a DER key code does not', async () => {
      const lab = await make();
      await type(lab.device, [...peerKey('d', derKeyCode(lab.otherPublicKey), 'der'),
        'ssh user admin authentication-type rsa', 'ssh user admin assign rsa-key d']);

      expect(await keyLogin(lab)).toBe(false);
    }, 30000);
  });
}
