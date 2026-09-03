/**
 * Une session IPv6 se compte, se voit et se vide A PART.
 *
 * `FirewallIpv6.transitPermitted` installe ses sessions de transit dans
 * la MEME `SessionTable` que le plan de donnees IPv4 — ce qui est un bon
 * choix, le suivi de connexion ne depend pas de la famille — mais la
 * CLI en tirait une consequence fausse : `diagnose sys session list`
 * rendait la session v6 au milieu des v4, `total session` et
 * `session_count` la comptaient, et `diagnose sys session6 list`
 * n'existait pas. Sur une vraie machine les deux tables se lisent par
 * deux commandes distinctes, et c'est ce qui permet de repondre a
 * « combien de sessions v6 ce boitier porte-t-il ? ».
 *
 * Mesure de depart, sur un laboratoire a double pile qui relaie les
 * DEUX familles : apres un `ping` puis un `ping6`, `diagnose sys session
 * list` rendait `total session 2` et decrivait la session v6 avec
 * `gwy=10.2.2.1/10.1.1.1` — des passerelles IPv4 pour un flux IPv6 —
 * et `(0.0.0.0:0)` la ou une vraie machine ecrit `(:::0)`.
 *
 * **Le classement de famille descend au niveau SESSION** plutot que de
 * vivre dans le rendu FortiOS : `session/SessionFamily.ts` porte la
 * regle, `SessionTable` la lit pour compter ses creations et ses
 * fermetures par famille, et le rendu la lit pour trier. Une seule
 * ecriture, sinon le compteur et la liste finiraient par ne pas dire la
 * meme chose du meme paquet. La regle elle-meme REUTILISE `tryIpToUint32`,
 * l'unique analyseur IPv4 du depot, plutot que d'ecrire un second test
 * d'appartenance.
 *
 * Ce qui change dans le rendu v6 est ce que la transcription attestee
 * distingue, et RIEN d'autre : l'en-tete devient `session6 info:` et le
 * champ de traduction absent devient `(:::0)`. Les passerelles sont
 * desormais resolues sur la table de routage IPv6 et retombent sur
 * l'adresse globale du port, non sur son adresse v4.
 *
 * **Les deux filtres sont distincts**, comme sur la vraie machine :
 * poser `diagnose sys session6 filter src ...` ne doit pas restreindre
 * `diagnose sys session list`, sans quoi une commande en gouvernerait
 * une autre. `execute set system session filter` continue de viser le
 * filtre v4, seul qu'il ait jamais vise.
 *
 * Discrimine par `git stash push -- src/network/` : 8 des 10 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le laboratoire relaie les deux familles » est le TEMOIN, et
 *     c'est son objet de passer des deux cotes : sans lui, une vue vide
 *     et un laboratoire qui ne route rien seraient indiscernables ;
 *   - « le filtre v4 reste celui d'`execute set system session filter` »
 *     passe parce que ce chemin visait deja le filtre v4 et continue —
 *     le cas garde que la separation des deux filtres ne l'a pas
 *     detourne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const V4_GAUCHE = '10.1.1.10';
const V4_DROITE = '10.2.2.10';
const V6_GAUCHE = '2001:db8:1::10';
const V6_DROITE = '2001:db8:2::10';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const gauche = new LinuxPC('linux-pc', 'PCA', 200, 0);
  const droite = new LinuxPC('linux-pc', 'PCB', 400, 0);
  gauche.powerOn();
  droite.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, gauche.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, droite.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping',
    'config ipv6', 'set ip6-address 2001:db8:1::1/64',
    'set ip6-allowaccess ping', 'end', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0',
    'set allowaccess ping',
    'config ipv6', 'set ip6-address 2001:db8:2::1/64',
    'set ip6-allowaccess ping', 'end', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set srcaddr6 "all6"', 'set dstaddr6 "all6"',
    'set service "ALL"', 'set action accept', 'set schedule "always"',
    'next', 'end');

  await runOn(gauche, 'ip link set eth0 up', `ip addr add ${V4_GAUCHE}/24 dev eth0`,
    'ip route add default via 10.1.1.1',
    `ip addr add ${V6_GAUCHE}/64 dev eth0`,
    'ip route add default via 2001:db8:1::1');
  await runOn(droite, 'ip link set eth0 up', `ip addr add ${V4_DROITE}/24 dev eth0`,
    'ip route add default via 10.2.2.1',
    `ip addr add ${V6_DROITE}/64 dev eth0`,
    'ip route add default via 2001:db8:2::1');

  return { fw, sh, gauche, droite };
}

describe('diagnose sys session6', () => {
  it('le laboratoire relaie les deux familles', async () => {
    const { gauche } = await laboratoire();

    expect(await runOn(gauche, `ping -c 1 ${V4_DROITE}`)).toContain('0% packet loss');
    expect(await runOn(gauche, `ping6 -c 1 ${V6_DROITE}`)).toContain('0% packet loss');
  });

  it('la liste v4 ne montre que des sessions v4', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping -c 1 ${V4_DROITE}`, `ping6 -c 1 ${V6_DROITE}`);

    const vue = sh.execute('diagnose sys session list');
    expect(vue).toContain(V4_GAUCHE);
    expect(vue).not.toContain(V6_GAUCHE);
    expect(vue).toContain('total session 1');
  });

  it('la liste v6 ne montre que des sessions v6, sous son propre en-tete', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping -c 1 ${V4_DROITE}`, `ping6 -c 1 ${V6_DROITE}`);

    const vue = sh.execute('diagnose sys session6 list');
    expect(vue).toContain('session6 info:');
    expect(vue).not.toContain('\nsession info:');
    expect(vue).toContain(V6_GAUCHE);
    expect(vue).not.toContain(V4_GAUCHE);
    expect(vue).toContain('total session 1');
  });

  it('une session v6 sans traduction ecrit (:::0) et non (0.0.0.0:0)', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping6 -c 1 ${V6_DROITE}`);

    const vue = sh.execute('diagnose sys session6 list');
    expect(vue).toContain('(:::0)');
    expect(vue).not.toContain('(0.0.0.0:0)');
  });

  it('les passerelles d une session v6 sont des adresses v6', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping6 -c 1 ${V6_DROITE}`);

    expect(sh.execute('diagnose sys session6 list'))
      .toContain('gwy=2001:db8:2::1/2001:db8:1::1');
  });

  it('chaque famille compte ses propres sessions', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping -c 1 ${V4_DROITE}`, `ping6 -c 1 ${V6_DROITE}`);

    expect(sh.execute('diagnose sys session stat'))
      .toContain('session_count=1 setup_rate=0 exp_count=0 clash=0');
    expect(sh.execute('diagnose sys session stat')).toContain('created=1 closed=0');
    expect(sh.execute('diagnose sys session6 stat')).toContain('created=1 closed=0');
  });

  it('vider la table v6 laisse la table v4 intacte', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping -c 1 ${V4_DROITE}`, `ping6 -c 1 ${V6_DROITE}`);

    expect(sh.execute('diagnose sys session6 clear')).toContain('1 sessions cleared');

    expect(sh.execute('diagnose sys session6 list')).toBe('total session 0');
    expect(sh.execute('diagnose sys session list')).toContain(V4_GAUCHE);
    expect(sh.execute('diagnose sys session6 stat')).toContain('created=1 closed=1');
    expect(sh.execute('diagnose sys session stat')).toContain('created=1 closed=0');
  });

  it('le filtre v6 ne restreint pas la liste v4', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping -c 1 ${V4_DROITE}`, `ping6 -c 1 ${V6_DROITE}`);

    sh.execute('diagnose sys session6 filter src 2001:db8:9::9');

    expect(sh.execute('diagnose sys session6 list')).toBe('total session 0');
    expect(sh.execute('diagnose sys session list')).toContain('total session 1');
  });

  it('le filtre v4 reste celui d execute set system session filter', async () => {
    const { sh, gauche } = await laboratoire();
    await runOn(gauche, `ping -c 1 ${V4_DROITE}`);

    sh.execute(`execute set system session filter src ${V4_GAUCHE}`);
    expect(sh.execute('diagnose sys session list')).toContain('total session 1');

    sh.execute('execute set system session filter src 10.9.9.9');
    expect(sh.execute('diagnose sys session list')).toBe('total session 0');
  });

  it('l aide annonce les deux tables et les quatre verbes de la v6', async () => {
    const { sh } = await laboratoire();

    const sys = sh.execute('diagnose sys ?');
    expect(sys).toContain('session6');
    const aide = sh.execute('diagnose sys session6 ?');
    for (const verbe of ['list', 'stat', 'filter', 'clear']) {
      expect(aide).toContain(verbe);
    }
  });
});
