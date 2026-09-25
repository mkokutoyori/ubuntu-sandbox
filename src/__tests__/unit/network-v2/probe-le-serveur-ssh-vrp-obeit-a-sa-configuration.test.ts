/*
 * Sur VRP, le serveur SSH n'obeissait qu'a moitie a sa configuration, et
 * sa vue ne disait pas ce qu'il faisait.
 *
 * Mesure de depart, sur un AR1 et un commutateur HW2 portant une paire
 * RSA, une vty en `protocol inbound all` et un compte local :
 *
 *   sans `stelnet server enable`   ssh admin@…   la session S'OUVRE
 *   AR1  display ssh server status              SSH server: Disabled
 *   HW2  display ssh server status              STELNET server : Enable
 *                                                (constante, quelle que soit
 *                                                la configuration)
 *   AR1  display stelnet server                 STelnet server: Disabled
 *   ssh server timeout 30         accepte, absent de la configuration et
 *                                 de la vue, aucune connexion n'est coupee
 *   ssh server authentication-retries 4
 *                                 AR1 : rendu, mais la vue annonce 3 ;
 *                                 HW2 : ni rendu, ni lu
 *
 * Deux magasins disaient « le serveur SSH est-il en service ? » : un
 * drapeau de l'equipement, vrai par defaut, que lisait l'ecoute, et celui
 * du gestionnaire, faux par defaut, que lisaient la vue et la
 * configuration. Le boitier ACCEPTAIT une session que sa propre vue
 * disait impossible — la regle 3.
 *
 * L'AUTORITE EST HUAWEI, les references de commandes AR et S :
 *  - `stelnet server enable` : « By default, the STelnet service is
 *    disabled on the SSH server » ; « to connect a client to the SSH
 *    server through STelnet, you must enable the STelnet service ».
 *  - `ssh server timeout` : « sets the timeout interval for SSH connection
 *    authentication », 60 s par defaut ; « if you have not logged in
 *    successfully at the timeout interval (…), the current connection is
 *    terminated » ; effet a la connexion suivante.
 *  - `ssh server authentication-retries` : « sets the maximum number of
 *    authentication retries for an SSH connection », 3 par defaut — une
 *    limite PAR CONNEXION, pas un blocage de la source.
 *  - `display ssh server status` porte les champs « SSH version », « SSH
 *    connection timeout », « SSH server key generating interval », « SSH
 *    authentication retries », « SFTP server », « Stelnet server ». Aucune
 *    transcription capturee n'est joignable d'ici pour la mise en
 *    colonnes : les assertions lisent le CHAMP et sa valeur, pas la
 *    largeur.
 *  - `display stelnet server` n'apparait dans aucune reference : la
 *    commande de verification est `display ssh server status`.
 *
 * Les bornes de `timeout` et `authentication-retries` ne sont pas
 * joignables d'ici ; seul un entier strictement positif est admis.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le code.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 18 des 22 cas tombent. Les 4 autres sont nommes ici :
 *
 *  - TEMOINS DU LABORATOIRE : avec `stelnet server enable`, la session
 *    s'ouvre sur le routeur et sur le commutateur, des deux cotes — un
 *    refus ulterieur tient donc a la configuration, pas au laboratoire.
 *  - TEMOIN DU DELAI : a 29 s d'un delai de 30 s, la connexion est encore
 *    ouverte, des deux cotes — son voisin « fermee a 31 s » interdit le
 *    correctif paresseux « tout fermer ».
 *  - `undo` sur le commutateur rend les valeurs par defaut, des deux
 *    cotes : avant a vide, la vue etant une constante et rien n'etant
 *    rendu ; son voisin « la vue lit ce qui est ecrit » separe les etats.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => { __setDefaultScheduler(null); });

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
}

const BASE = [
  'aaa', `local-user admin password cipher ${SECRET}`,
  'local-user admin privilege level 15', 'local-user admin service-type ssh', 'quit',
  'rsa local-key-pair create',
  'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit',
];

async function routerLab(...extra: string[]): Promise<Lab> {
  const device = new HuaweiRouter('AR1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(device.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);
  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0', 'ip address 10.0.0.1 24', 'undo shutdown', 'quit',
    ...BASE, ...extra, 'return',
  ]) await device.executeCommand(c);
  await host.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await settle();
  return { device, host, ip: '10.0.0.1' };
}

async function switchLab(...extra: string[]): Promise<Lab> {
  const device = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const host = new LinuxPC('linux-pc', 'P4');
  host.getPort('eth0')!.configureIP(new IPAddress('10.0.3.10'), new SubnetMask('255.255.255.0'));
  new Cable('c4').connect(host.getPort('eth0')!, device.getPorts()[0]);
  for (const c of [
    'system-view',
    'interface Vlanif1', 'ip address 10.0.3.2 255.255.255.0', 'undo shutdown', 'quit',
    ...BASE, ...extra, 'return',
  ]) await device.executeCommand(c);
  await settle();
  return { device, host, ip: '10.0.3.2' };
}

const sshOpens = async ({ host, ip }: Lab): Promise<boolean> =>
  /VRP|Huawei|Version/i.test(await host.executeCommand(
    `ssh admin@${ip} "display version"`, `${SECRET}\n`));

function field(view: string, label: string): string | undefined {
  const line = view.split('\n').find((l) => l.trim().startsWith(label));
  return line?.slice(line.indexOf(':') + 1).trim();
}

interface RawConnection {
  replies: Array<Record<string, unknown>>;
  closed: () => boolean;
  send: (message: Record<string, unknown>) => Promise<void>;
}

async function rawConnection({ host, ip }: Lab): Promise<RawConnection> {
  const socket = await (host as unknown as {
    tcpConnect(ip: string, port: number): Promise<{
      write(data: string): void;
      onData(h: (d: string) => void): () => void;
      onClose?(h: (reason: string) => void): () => void;
    } | null>;
  }).tcpConnect(ip, 22);
  expect(socket).toBeTruthy();
  const replies: Array<Record<string, unknown>> = [];
  let closed = false;
  socket!.onData((d) => { if (d.startsWith('{')) replies.push(JSON.parse(d) as Record<string, unknown>); });
  socket!.onClose?.(() => { closed = true; });
  const send = async (message: Record<string, unknown>): Promise<void> => {
    socket!.write(JSON.stringify(message));
    await settle();
  };
  await send({ op: 'hello', clientVersion: 'SSH-2.0-probe' });
  return { replies, closed: () => closed, send };
}

const wrongPassword = { op: 'auth', method: 'password', user: 'admin', password: 'nope' };
const rightPassword = { op: 'auth', method: 'password', user: 'admin', password: SECRET };

describe('le serveur STelnet est hors service tant qu\'on ne l\'active pas', () => {
  it('routeur neuf : la session est refusee', async () => {
    expect(await sshOpens(await routerLab())).toBe(false);
  }, 30000);

  it('commutateur neuf : la session est refusee', async () => {
    expect(await sshOpens(await switchLab())).toBe(false);
  }, 30000);

  it('routeur, `stelnet server enable` : la session s\'ouvre — TEMOIN', async () => {
    expect(await sshOpens(await routerLab('stelnet server enable'))).toBe(true);
  }, 30000);

  it('commutateur, `stelnet server enable` : la session s\'ouvre — TEMOIN', async () => {
    expect(await sshOpens(await switchLab('stelnet server enable'))).toBe(true);
  }, 30000);
});

describe('`display ssh server status` dit ce que le boitier fait', () => {
  for (const [platform, make] of [['routeur', routerLab], ['commutateur', switchLab]] as const) {
    it(`${platform} neuf : les valeurs par defaut`, async () => {
      const view = await (await make()).device.executeCommand('display ssh server status');

      expect(field(view, 'SSH version')).toBe('2.0');
      expect(field(view, 'SSH connection timeout')).toBe('60 seconds');
      expect(field(view, 'SSH authentication retries')).toBe('3 times');
      expect(field(view, 'Stelnet server')).toBe('Disable');
    }, 30000);

    it(`${platform} : la vue lit ce que les commandes ont ecrit`, async () => {
      const view = await (await make(
        'stelnet server enable', 'ssh server timeout 30', 'ssh server authentication-retries 4',
      )).device.executeCommand('display ssh server status');

      expect(field(view, 'SSH connection timeout')).toBe('30 seconds');
      expect(field(view, 'SSH authentication retries')).toBe('4 times');
      expect(field(view, 'Stelnet server')).toBe('Enable');
    }, 30000);

    it(`${platform} : la configuration courante garde ce qui a ete tape`, async () => {
      const config = await (await make(
        'ssh server timeout 30', 'ssh server authentication-retries 4',
      )).device.executeCommand('display current-configuration');

      expect(config).toMatch(/^ssh server timeout 30$/m);
      expect(config).toMatch(/^ssh server authentication-retries 4$/m);
    }, 30000);
  }

  it('routeur : `undo` rend les valeurs par defaut', async () => {
    const { device } = await routerLab(
      'ssh server timeout 30', 'ssh server authentication-retries 4',
      'undo ssh server timeout', 'undo ssh server authentication-retries');

    const view = await device.executeCommand('display ssh server status');
    expect(field(view, 'SSH connection timeout')).toBe('60 seconds');
    expect(field(view, 'SSH authentication retries')).toBe('3 times');
    expect(await device.executeCommand('display current-configuration'))
      .not.toMatch(/ssh server (timeout|authentication-retries)/);
  }, 30000);

  it('commutateur : `undo` rend les valeurs par defaut — passe des deux cotes', async () => {
    const { device } = await switchLab(
      'ssh server timeout 30', 'ssh server authentication-retries 4',
      'undo ssh server timeout', 'undo ssh server authentication-retries');

    const view = await device.executeCommand('display ssh server status');
    expect(field(view, 'SSH connection timeout')).toBe('60 seconds');
    expect(field(view, 'SSH authentication retries')).toBe('3 times');
    expect(await device.executeCommand('display current-configuration'))
      .not.toMatch(/ssh server (timeout|authentication-retries)/);
  }, 30000);

  it('ce qui n\'est pas un entier positif est refuse', async () => {
    const device = new HuaweiRouter('AR1');
    await device.executeCommand('system-view');

    expect(await device.executeCommand('ssh server timeout 0')).toMatch(/^Error:/);
    expect(await device.executeCommand('ssh server authentication-retries x')).toMatch(/^Error:/);
  }, 30000);

  it('`display stelnet server` n\'est pas une commande VRP', async () => {
    const device = new HuaweiRouter('AR1');

    expect(await device.executeCommand('display stelnet server')).toMatch(/^Error:/);
  }, 30000);
});

describe('`ssh server timeout` coupe une connexion qui ne s\'authentifie pas', () => {
  it('routeur : encore ouverte a 29 s d\'un delai de 30 s — TEMOIN', async () => {
    const lab = await routerLab('stelnet server enable', 'ssh server timeout 30');
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const connection = await rawConnection(lab);

    scheduler.advance(29_000);
    await settle();

    expect(connection.closed()).toBe(false);
  }, 30000);

  it('routeur : fermee a 31 s d\'un delai de 30 s', async () => {
    const lab = await routerLab('stelnet server enable', 'ssh server timeout 30');
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const connection = await rawConnection(lab);

    scheduler.advance(31_000);
    await settle();

    expect(connection.closed()).toBe(true);
  }, 30000);

  it('routeur : sans commande, le delai par defaut de 60 s s\'applique', async () => {
    const lab = await routerLab('stelnet server enable');
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const connection = await rawConnection(lab);

    scheduler.advance(61_000);
    await settle();

    expect(connection.closed()).toBe(true);
  }, 30000);

  it('commutateur : fermee a 31 s d\'un delai de 30 s', async () => {
    const lab = await switchLab('stelnet server enable', 'ssh server timeout 30');
    const scheduler = new VirtualTimeScheduler();
    __setDefaultScheduler(scheduler);
    const connection = await rawConnection(lab);

    scheduler.advance(31_000);
    await settle();

    expect(connection.closed()).toBe(true);
  }, 30000);
});

describe('`ssh server authentication-retries` borne les essais d\'UNE connexion', () => {
  it('routeur : le deuxieme echec d\'une limite a 2 ferme la connexion', async () => {
    const connection = await rawConnection(
      await routerLab('stelnet server enable', 'ssh server authentication-retries 2'));

    await connection.send(wrongPassword);
    await connection.send(wrongPassword);

    expect(connection.replies.at(-1)).toMatchObject({ ok: false, ended: true });
    expect(connection.closed()).toBe(true);
  }, 30000);

  it('routeur : sans commande, le troisieme echec la ferme', async () => {
    const connection = await rawConnection(await routerLab('stelnet server enable'));

    await connection.send(wrongPassword);
    await connection.send(wrongPassword);
    await connection.send(wrongPassword);

    expect(connection.replies.at(-1)).toMatchObject({ ok: false, ended: true });
  }, 30000);

  it('routeur : une NOUVELLE connexion, juste apres, peut s\'authentifier', async () => {
    const lab = await routerLab('stelnet server enable', 'ssh server authentication-retries 2');
    const first = await rawConnection(lab);
    await first.send(wrongPassword);
    await first.send(wrongPassword);

    const second = await rawConnection(lab);
    await second.send(rightPassword);

    expect(second.replies.at(-1)).toMatchObject({ ok: true });
  }, 30000);

  it('commutateur : le deuxieme echec d\'une limite a 2 ferme la connexion', async () => {
    const connection = await rawConnection(
      await switchLab('stelnet server enable', 'ssh server authentication-retries 2'));

    await connection.send(wrongPassword);
    await connection.send(wrongPassword);

    expect(connection.replies.at(-1)).toMatchObject({ ok: false, ended: true });
  }, 30000);
});
