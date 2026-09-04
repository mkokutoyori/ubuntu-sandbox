/**
 * Une session ICMP vivait une HEURE, et le profil qui dit soixante
 * secondes n'etait lu par personne.
 *
 * `FirewallProfile.timeouts` declare les six delais d'inactivite d'une
 * session — `tcpEstablished`, `tcpHandshake`, `tcpTimeWait`, `udp`,
 * `icmp`, `other` — et `FortiProfile` les remplit avec les valeurs
 * reelles d'un FortiGate (3600 / 30 / 120 / 180 / 60 / 180). **Aucun
 * lecteur.** Le point d'installation d'une session ecrivait
 * `services.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC`, et
 * `defaultTimeoutSec` n'etait POSE par personne : toute session non-TCP
 * heritait donc de 3600 secondes. Mesure avant correctif :
 * `expire=3599 timeout=3600` sur une session ICMP, la ou une vraie
 * machine ecrit 60 — un facteur soixante sur la duree de vie du flux le
 * plus courant d'un laboratoire, et l'ecart se LIT dans les deux vues
 * de sessions.
 *
 * Ce n'est pas seulement une duree affichee : c'est la fenetre pendant
 * laquelle un paquet de retour est encore accepte sans repasser par la
 * politique, donc la difference entre un pare-feu a etat et un pare-feu
 * qui garde tout ouvert une heure.
 *
 * **`config system session-ttl` arrive avec**, et c'est ce qui rend la
 * commande de lecture utile. La regle est celle de la reference 6.0.4,
 * citee plutot que devinee : `set default` « affects TCP and SCTP
 * sessions that do not have a timeout specified in a defined config
 * port entry » — donc il ne gouverne NI l'UDP NI l'ICMP, qui gardent
 * leurs propres defauts (180 et 60, attestes). Une entree `config port`
 * prime sur tout, se choisit par protocole et par plage de ports de
 * DESTINATION, et vaut 300 secondes par defaut ; `protocol 0` vaut pour
 * tous les protocoles.
 *
 * La table vit par DOMAINE VIRTUEL et non sur l'equipement, au meme
 * rang que la table de routes de politique — `config system session-ttl`
 * est de portee `vdom`, et une table d'equipement ferait qu'un VDOM
 * imposerait ses delais a l'autre.
 *
 * `get system session-info ttl` rend ce que la machine APPLIQUE :
 * `session timeout:` puis `Default timeout=<n>`, format atteste, suivi
 * d'une ligne par entree configuree.
 *
 * **Le delai TCP se decide a DEUX endroits**, et le second a failli
 * etre oublie : la machine a etats TCP repose le delai a chaque
 * transition (`sessions.setTimeout(session, machine.timeoutSec)`), et
 * elle portait sa PROPRE table `DEFAULT_TCP_TIMEOUTS`. Sans la lui
 * fournir, `set default 900` etait accepte, rendu par la configuration,
 * lu par la vue — et inerte pour le seul protocole qu'il gouverne. Elle
 * lit desormais le profil et le defaut configure ; au passage les deux
 * tables cessent de se contredire sur `timeWait`, que le profil met a
 * 120 et l'autre a 30.
 *
 * Discrimine par `git stash push -- src/network/` : 9 des 12 cas
 * tombent. Les 3 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le laboratoire relaie vraiment » est le TEMOIN, et c'est son
 *     objet de passer des deux cotes : sans lui, une session absente et
 *     un delai mal lu seraient indiscernables ;
 *   - « une session TCP etablie dure une heure » passait deja, la
 *     machine a etats posant cette valeur elle-meme — il garde que le
 *     nouveau chemin ne l'a pas changee ;
 *   - « un defaut hors des bornes attestees est refuse » passait parce
 *     que la table entiere n'existait pas, donc le refus etait
 *     indiscernable de l'absence ; il vaut desormais pour la borne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
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
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', -200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0',
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a, b };
}

function timeoutsOf(fw: FortiGate, protocol: number): number[] {
  return fw.getSessionTable().view().all()
    .filter(session => session.c2s.protocol === protocol && session.state !== 'discard')
    .map(session => session.timeoutSec);
}

function udp(a: LinuxPC, port: number, source = 40000): void {
  a.sendUdpDatagram(new IPAddress('10.2.2.10'), port, source, { kind: 'probe' });
}

describe('les delais de session par protocole', () => {
  it('le laboratoire relaie vraiment', async () => {
    const { fw, a } = await laboratoire();

    expect(await runOn(a, 'ping -c 1 10.2.2.10')).toContain('0% packet loss');
    expect(fw.getSessionTable().view().count()).toBe(1);
  });

  it('une session ICMP dure soixante secondes', async () => {
    const { fw, a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.2.2.10');

    expect(timeoutsOf(fw, 1)).toEqual([60]);
  });

  it('une session UDP dure cent quatre-vingts secondes', async () => {
    const { fw, a } = await laboratoire();
    udp(a, 5353);

    expect(timeoutsOf(fw, 17)).toEqual([180]);
  });

  it('une session TCP etablie dure une heure', async () => {
    const { fw, a, b } = await laboratoire();
    b.getTcpStack().listen(80, { onAccept: () => {} });
    await a.tcpConnect('10.2.2.10', 80);

    expect(timeoutsOf(fw, 6)).toEqual([3600]);
  });

  it('la vue de session montre le delai applique', async () => {
    const { sh, a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.2.2.10');

    expect(sh.execute('diagnose sys session list')).toContain('timeout=60');
  });
});

describe('config system session-ttl', () => {
  it('sans configuration, la vue annonce le defaut atteste', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get system session-info ttl'))
      .toBe('session timeout:\nDefault timeout=3600');
  });

  it('`set default` gouverne le TCP et rien d autre', async () => {
    const { fw, sh, a, b } = await laboratoire();
    run(sh, 'config system session-ttl', 'set default 900', 'end');

    b.getTcpStack().listen(80, { onAccept: () => {} });
    await a.tcpConnect('10.2.2.10', 80);
    await runOn(a, 'ping -c 1 10.2.2.10');
    udp(a, 5353);

    expect(timeoutsOf(fw, 6)).toEqual([900]);
    expect(timeoutsOf(fw, 1)).toEqual([60]);
    expect(timeoutsOf(fw, 17)).toEqual([180]);
  });

  it('une entree `config port` prime sur le defaut du protocole', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config system session-ttl', 'config port', 'edit 1',
      'set protocol 17', 'set start-port 5353', 'set end-port 5353',
      'set timeout 30', 'next', 'end', 'end');

    udp(a, 5353);
    udp(a, 5354, 40001);

    expect(timeoutsOf(fw, 17)).toEqual([30, 180]);
  });

  it('`protocol 0` vaut pour tous les protocoles', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config system session-ttl', 'config port', 'edit 1',
      'set protocol 0', 'set start-port 0', 'set end-port 65535',
      'set timeout 45', 'next', 'end', 'end');

    await runOn(a, 'ping -c 1 10.2.2.10');

    expect(timeoutsOf(fw, 1)).toEqual([45]);
  });

  it('la vue rend le defaut et chaque entree configuree', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system session-ttl', 'set default 300',
      'config port', 'edit 1', 'set protocol 17',
      'set start-port 5353', 'set end-port 5353', 'set timeout 30',
      'next', 'end', 'end');

    expect(sh.execute('get system session-info ttl')).toBe(
      'session timeout:\nDefault timeout=300\n'
      + 'id=1 protocol=17 port=5353-5353 timeout=30');
  });

  it('la configuration se relit telle qu elle a ete tapee', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system session-ttl', 'set default 300',
      'config port', 'edit 1', 'set protocol 17',
      'set start-port 5353', 'set end-port 5353', 'set timeout 30',
      'next', 'end', 'end');

    const rendu = sh.execute('show system session-ttl');
    expect(rendu).toContain('set default 300');
    expect(rendu).toContain('set protocol 17');
    expect(rendu).toContain('set timeout 30');
  });

  it('un defaut hors des bornes attestees est refuse', async () => {
    const { sh } = await laboratoire();

    expect(run(sh, 'config system session-ttl', 'set default 60'))
      .toMatch(/value parse error|Command fail/);
    run(sh, 'end');
  });
});
