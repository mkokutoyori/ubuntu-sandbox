/**
 * Un VIP de REPARTITION choisit un serveur, et il le choisit VIVANT.
 *
 * §6.4 du carnet et l'entree `[vip]` de `TODO.md` nomment le point : le
 * type `server-load-balance` est REFUSE depuis la phase 15b, faute de
 * grappe de serveurs reels et de moniteurs de sante. La mesure a trouve
 * que les briques existent — le DNAT choisit deja son adresse par un
 * point d'accroche unique qui INSCRIT son choix dans la session, et le
 * pare-feu sait deja sonder.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. `config firewall ldb-monitor` existe, avec ses defauts reels :
 *      `type ping`, `interval 10`, `timeout 2`, `retry 3`, `port 0`
 *      (0 = le port du serveur reel).
 *   2. Un VIP `server-load-balance` porte `server-type`, `ldb-method`,
 *      `extport` et une grappe `config realservers`.
 *   3. Un vrai client atteint un vrai serveur A TRAVERS le VIP. Sans ce
 *      cas, tout le reste n'est que de la configuration.
 *   4. `round-robin` fait tourner : deux connexions successives ne
 *      tombent pas sur le meme serveur.
 *   5. `first-alive` ne tourne PAS : il colle au premier vivant.
 *   6. Une session DEJA ouverte reste sur SON serveur — c'est ce qui
 *      distingue une repartition d'un tirage a chaque paquet.
 *   7. Un serveur qui ne repond plus SORT de la grappe, et le trafic
 *      part vers l'autre.
 *   8. Une grappe dont aucun membre n'est vivant ne traduit rien.
 *   9. `set status disable` sur un serveur reel le retire aussi, sans
 *      moniteur — c'est la sortie de service voulue par l'operateur.
 *  10. `least-rtt` et `http-host` sont REFUSES en nommant la brique
 *      manquante : il n'y a pas d'horloge de fil pour comparer des
 *      temps d'aller-retour, et le serveur est choisi a la traduction,
 *      donc avant qu'une charge utile HTTP existe.
 *
 * L'OBSERVABLE est le choix du PARE-FEU, pas ce que voit le client : le
 * client compose le VIP et voit le VIP, puisque le retour est
 * de-traduit. C'est correct, et cela ne dit rien du serveur choisi. La
 * premiere version de cette sonde s'y est trompee sur trois cas.
 *
 * Discrimination (`git stash push -- src/network/`) : 9 des 10 cas
 * tombent avant correctif. Le dixieme — « `least-rtt` et `http-host`
 * sont refuses » — passait parce que le TYPE entier etait refuse, donc
 * la methode ne pouvait pas etre posee : vrai pour la mauvaise raison.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const CLIENT = '203.0.113.10';
const VIP = '203.0.113.100';
const SERVEUR_A = '192.168.1.10';
const SERVEUR_B = '192.168.1.11';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 150);
  const client = new LinuxPC('linux-pc', 'PC', 200, 0);
  const a = new LinuxServer('linux-server', 'A', -200, 0);
  const b = new LinuxServer('linux-server', 'B', -200, 120);
  for (const d of [commutateur, client, a, b]) d.powerOn();

  new Cable('c1').connect(fw.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('c2').connect(a.getPorts()[0], commutateur.getPort('eth1')!);
  new Cable('c3').connect(b.getPorts()[0], commutateur.getPort('eth2')!);
  new Cable('c4').connect(fw.getPort('port2')!, client.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(a, ['ip link set eth0 up', `ip addr add ${SERVEUR_A}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(b, ['ip link set eth0 up', `ip addr add ${SERVEUR_B}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(client, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  return { fw, sh, client, a, b };
}

function grappe(sh: FortiShell, methode: string, ...extra: string[]): string {
  return run(sh,
    'config firewall vip', 'edit "SLB"',
    'set type server-load-balance',
    `set extip ${VIP}`,
    'set extintf "port2"',
    'set server-type tcp',
    `set ldb-method ${methode}`,
    'set extport 80',
    ...extra,
    'config realservers',
    'edit 1', `set ip ${SERVEUR_A}`, 'set port 80', 'next',
    'edit 2', `set ip ${SERVEUR_B}`, 'set port 80', 'next',
    'end', 'next', 'end');
}

function politique(sh: FortiShell): string {
  return run(sh,
    'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "SLB"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

function ecoute(serveur: LinuxServer, marque: string): void {
  serveur.getTcpStack().listen(80, {
    onAccept: (socket: { write(data: string): void }) => { socket.write(marque); },
  });
}

/**
 * Le client compose le VIP et voit le VIP : le retour est de-traduit,
 * ce qui est correct et ne dit RIEN du serveur choisi. Le choix est une
 * decision du PARE-FEU, et c'est la qu'on le lit — dans la session que
 * la connexion vient d'ouvrir.
 */
async function joint(fw: FortiGate, client: LinuxPC): Promise<string | undefined> {
  const avant = fw.getSessionTable().view().all().length;
  await client.tcpConnect(VIP, 80);

  const sessions = fw.getSessionTable().view().all();
  if (sessions.length === avant) return undefined;
  return sessions[sessions.length - 1]?.translation?.translatedDest;
}

/**
 * `retry 3` veut dire TROIS echecs consecutifs. Une seule passe ne
 * declare rien mort, et c'est le comportement voulu — un moniteur qui
 * condamnerait un serveur au premier paquet perdu serait inutilisable.
 */
async function sonder(fw: FortiGate, passes = 3): Promise<void> {
  for (let i = 0; i < passes; i++) await fw.runLdbMonitors();
}

beforeEach(() => { Logger.reset(); });

describe('la grappe et ses moniteurs se declarent', () => {
  it('`config firewall ldb-monitor` existe avec ses defauts reels', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall ldb-monitor', 'edit "HC"', 'next', 'end');

    const rendu = run(sh, 'show full-configuration firewall ldb-monitor "HC"');
    expect(rendu).toContain('set type ping');
    expect(rendu).toContain('set interval 10');
    expect(rendu).toContain('set timeout 2');
    expect(rendu).toContain('set retry 3');
    expect(rendu).toContain('set port 0');
  });

  it('un VIP de repartition porte sa grappe et se relit', async () => {
    const { sh } = await laboratoire();

    grappe(sh, 'round-robin');

    const rendu = run(sh, 'show firewall vip "SLB"');
    expect(rendu).toContain('set type server-load-balance');
    expect(rendu).toContain('set ldb-method round-robin');
    expect(rendu).toContain('config realservers');
    expect(rendu).toContain(`set ip ${SERVEUR_A}`);
    expect(rendu).toContain(`set ip ${SERVEUR_B}`);
  });

  it('`least-rtt` et `http-host` sont REFUSES en nommant leur brique',
    async () => {
      const { sh } = await laboratoire();
      run(sh, 'config firewall vip', 'edit "SLB"',
        'set type server-load-balance');

      const rtt = run(sh, 'set ldb-method least-rtt');
      const host = run(sh, 'set ldb-method http-host');
      run(sh, 'next', 'end');

      expect(rtt).not.toBe('');
      expect(host).not.toBe('');
    });
});

describe('un vrai client traverse la grappe', () => {
  it('il atteint un vrai serveur A TRAVERS le VIP', async () => {
    const { fw, sh, client, a, b } = await laboratoire();
    ecoute(a, 'A'); ecoute(b, 'B');
    grappe(sh, 'first-alive');
    politique(sh);

    const atteint = await joint(fw, client);

    expect([SERVEUR_A, SERVEUR_B]).toContain(atteint);
  });

  it('`round-robin` fait TOURNER', async () => {
    const { fw, sh, client, a, b } = await laboratoire();
    ecoute(a, 'A'); ecoute(b, 'B');
    grappe(sh, 'round-robin');
    politique(sh);

    const premier = await joint(fw, client);
    const second = await joint(fw, client);

    expect(premier).not.toBe(second);
  });

  it('`first-alive` ne tourne PAS', async () => {
    const { fw, sh, client, a, b } = await laboratoire();
    ecoute(a, 'A'); ecoute(b, 'B');
    grappe(sh, 'first-alive');
    politique(sh);

    const premier = await joint(fw, client);
    const second = await joint(fw, client);

    expect(premier).toBe(second);
  });

  it('une session DEJA ouverte reste sur SON serveur', async () => {
    const { fw, sh, client, a, b } = await laboratoire();
    ecoute(a, 'A'); ecoute(b, 'B');
    grappe(sh, 'round-robin');
    politique(sh);

    const socket = await client.tcpConnect(VIP, 80);
    expect(socket).not.toBeNull();
    const choisi = fw.getSessionTable().view().all()[0]?.translation?.translatedDest;
    expect([SERVEUR_A, SERVEUR_B]).toContain(choisi);

    socket?.write('encore');
    socket?.write('et encore');

    const destinations = fw.getSessionTable().view().all()
      .map(session => session.translation?.translatedDest)
      .filter((value): value is string => value !== undefined);
    expect(destinations).toEqual([choisi]);
  });
});

describe('la grappe ne garde que les VIVANTS', () => {
  it('un serveur mis hors service par l operateur sort de la grappe',
    async () => {
      const { fw, sh, client, a, b } = await laboratoire();
      ecoute(a, 'A'); ecoute(b, 'B');
      grappe(sh, 'round-robin');
      politique(sh);

      run(sh, 'config firewall vip', 'edit "SLB"', 'config realservers',
        'edit 1', 'set status disable', 'next', 'end', 'next', 'end');

      expect(await joint(fw, client)).toBe(SERVEUR_B);
      expect(await joint(fw, client)).toBe(SERVEUR_B);
    });

  it('un serveur qui ne repond plus sort de la grappe', async () => {
    const { fw, sh, client, a, b } = await laboratoire();
    ecoute(a, 'A'); ecoute(b, 'B');
    run(sh, 'config firewall ldb-monitor', 'edit "HC"',
      'set type ping', 'next', 'end');
    grappe(sh, 'round-robin', 'set monitor "HC"');
    politique(sh);

    await sonder(fw);
    expect(await joint(fw, client)).not.toBeUndefined();

    a.powerOff();
    await sonder(fw);

    expect(await joint(fw, client)).toBe(SERVEUR_B);
    expect(await joint(fw, client)).toBe(SERVEUR_B);
  });

  it('une grappe sans aucun vivant ne traduit rien', async () => {
    const { fw, sh, client, a, b } = await laboratoire();
    ecoute(a, 'A'); ecoute(b, 'B');
    run(sh, 'config firewall ldb-monitor', 'edit "HC"',
      'set type ping', 'next', 'end');
    grappe(sh, 'round-robin', 'set monitor "HC"');
    politique(sh);

    a.powerOff(); b.powerOff();
    await sonder(fw);
    expect(fw.getRealServerPool('SLB')?.alive()).toHaveLength(0);

    void client.tcpConnect(VIP, 80);

    const traduites = fw.getSessionTable().view().all()
      .filter(session => session.translation !== undefined);
    expect(traduites).toHaveLength(0);
  });
});
