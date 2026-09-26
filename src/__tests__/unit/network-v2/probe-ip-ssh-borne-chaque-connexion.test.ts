/*
 * Sur IOS, `ip ssh time-out` et `ip ssh authentication-retries` etaient
 * rendus par `show ip ssh` et par la configuration — et n'agissaient pas
 * comme IOS les decrit.
 *
 * Mesure de depart, sur un R1 et un commutateur SW1 portant une paire RSA,
 * `login local` et `transport input ssh`, un poste Linux en face :
 *
 *   show ip ssh      Authentication timeout: 45 secs; Authentication retries: 2
 *   une connexion qui ne s'authentifie jamais     reste ouverte, sans fin
 *   deux mots de passe faux sur UNE connexion      la connexion reste
 *                                                  ouverte : le serveur en
 *                                                  admet six, le defaut
 *                                                  d'OpenSSH
 *   une NOUVELLE connexion depuis la meme source,  refusee : la commande
 *   avec le bon mot de passe                       installait un blocage de
 *                                                  la SOURCE pendant 60 s
 *
 * La vue et la configuration disaient 45 s et 2 essais ; le fil appliquait
 * « jamais » et 6, et bloquait en prime une adresse — une regle que ni la
 * commande ni la vue ne nomment.
 *
 * L'AUTORITE EST CISCO (Security Command Reference, `ip ssh`) :
 *  - `time-out seconds` : « the time interval that the router waits for
 *    the SSH client to respond », 120 s par defaut, 120 au plus ; il
 *    s'applique a la phase de NEGOCIATION, avant la session EXEC.
 *  - `authentication-retries integer` : « the number of attempts after
 *    which the interface is reset », 3 par defaut, 5 au plus. Le
 *    referentiel CIS le lit de meme : la borne limite les essais PAR
 *    CONNEXION, l'attaquant devant en ouvrir une nouvelle ; rien ne bloque
 *    la source — c'est le role de `login block-for`, commande distincte.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire le code.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 10 des 16 cas tombent. Les 6 autres sont nommes ici :
 *
 *  - TEMOINS DU LABORATOIRE : la session s'ouvre, sur le routeur et sur le
 *    commutateur, des deux cotes.
 *  - TEMOINS DU DELAI : a 44 s d'un delai de 45 s la connexion est encore
 *    ouverte, sur les deux, des deux cotes — leurs voisins « fermee a
 *    46 s » interdisent le correctif paresseux « tout fermer ».
 *  - LE COMMUTATEUR ne bloquait pas la source : le blocage n'etait
 *    installe que par `Router`. Ses deux cas « une nouvelle connexion
 *    peut s'authentifier » passent donc a vide avant ; ils gardent
 *    l'uniformite une fois la borne par connexion en place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
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
  device: CiscoRouter | CiscoSwitch;
  host: LinuxPC;
  ip: string;
}

const SSH_SERVER = [
  `username admin privilege 15 secret ${SECRET}`,
  'ip domain-name lab.local',
  'crypto key generate rsa modulus 2048',
  'line vty 0 4', 'login local', 'transport input ssh', 'exit',
];

async function lab(kind: 'routeur' | 'commutateur', ...extra: string[]): Promise<Lab> {
  const device = kind === 'routeur'
    ? new CiscoRouter('R1', 0, 0)
    : new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(device.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);
  const management = kind === 'routeur'
    ? ['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit']
    : ['interface vlan 1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit'];
  for (const c of ['enable', 'configure terminal', ...management, ...SSH_SERVER, ...extra, 'end']) {
    await device.executeCommand(c);
  }
  await host.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await settle();
  return { device, host, ip: '10.0.0.1' };
}

const sshOpens = async ({ host, ip }: Lab): Promise<boolean> =>
  /Cisco|IOS|Version/i.test(await host.executeCommand(
    `ssh admin@${ip} "show version"`, `${SECRET}\n`));

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

async function afterIdle(target: Lab, seconds: number): Promise<RawConnection> {
  const scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  const connection = await rawConnection(target);
  scheduler.advance(seconds * 1000);
  await settle();
  return connection;
}

for (const kind of ['routeur', 'commutateur'] as const) {
  describe(`${kind} — le laboratoire`, () => {
    it('une session SSH s\'ouvre — TEMOIN', async () => {
      expect(await sshOpens(await lab(kind))).toBe(true);
    }, 30000);
  });

  describe(`${kind} — \`ip ssh time-out\` coupe une negociation qui traine`, () => {
    it('encore ouverte a 44 s d\'un delai de 45 s — TEMOIN', async () => {
      const connection = await afterIdle(await lab(kind, 'ip ssh time-out 45'), 44);

      expect(connection.closed()).toBe(false);
    }, 30000);

    it('fermee a 46 s d\'un delai de 45 s', async () => {
      const connection = await afterIdle(await lab(kind, 'ip ssh time-out 45'), 46);

      expect(connection.closed()).toBe(true);
    }, 30000);

    it('sans commande, fermee a 121 s : le defaut de 120 s', async () => {
      const connection = await afterIdle(await lab(kind), 121);

      expect(connection.closed()).toBe(true);
    }, 30000);
  });

  describe(`${kind} — \`ip ssh authentication-retries\` borne UNE connexion`, () => {
    it('le deuxieme echec d\'une borne a 2 ferme la connexion', async () => {
      const connection = await rawConnection(await lab(kind, 'ip ssh authentication-retries 2'));

      await connection.send(wrongPassword);
      await connection.send(wrongPassword);

      expect(connection.replies.at(-1)).toMatchObject({ ok: false, ended: true });
      expect(connection.closed()).toBe(true);
    }, 30000);

    it('sans commande, le troisieme echec la ferme', async () => {
      const connection = await rawConnection(await lab(kind));

      await connection.send(wrongPassword);
      await connection.send(wrongPassword);
      await connection.send(wrongPassword);

      expect(connection.replies.at(-1)).toMatchObject({ ok: false, ended: true });
    }, 30000);

    it('une NOUVELLE connexion, juste apres, peut s\'authentifier', async () => {
      const target = await lab(kind, 'ip ssh authentication-retries 2');
      const first = await rawConnection(target);
      await first.send(wrongPassword);
      await first.send(wrongPassword);

      const second = await rawConnection(target);
      await second.send(rightPassword);

      expect(second.replies.at(-1)).toMatchObject({ ok: true });
    }, 30000);

    it('`no ip ssh authentication-retries` ne bloque pas davantage la source', async () => {
      const target = await lab(kind, 'ip ssh authentication-retries 2', 'no ip ssh authentication-retries');
      const first = await rawConnection(target);
      await first.send(wrongPassword);
      await first.send(wrongPassword);
      await first.send(wrongPassword);

      const second = await rawConnection(target);
      await second.send(rightPassword);

      expect(second.replies.at(-1)).toMatchObject({ ok: true });
    }, 30000);
  });
}
