/**
 * `capture-packet` etait accepte, rendu, et ne capturait rien — et la
 * commande censee effacer ces captures vidait le tampon du RENIFLEUR.
 *
 * Deux defauts, dont le second est le plus couteux. `set capture-packet
 * enable` est declare sur `firewall policy`, rendu par `show firewall
 * policy` — donc rejoue a l'import d'une topologie — et lu par
 * personne. Et `execute policy-packet-capture delete-all`, qui existait
 * deja, appelait `getPacketCapture().clear()` : le tampon de `diagnose
 * sniffer packet`. Une commande dont le nom dit « efface les captures de
 * POLITIQUE » detruisait donc l'historique du renifleur, c'est-a-dire
 * l'outil de diagnostic qu'un operateur est justement en train
 * d'utiliser quand il tape cette commande. Mesure avant correctif : 20
 * trames dans le renifleur, zero capture de politique, et `delete-all`
 * annoncait « 20 captured packets deleted » en vidant le mauvais
 * magasin.
 *
 * **Le magasin de politique est un `PacketCapture` par politique**, la
 * classe qui existe deja, plutot qu'un second anneau. Elle gagne une
 * notion qui lui manquait et qui n'est pas propre a FortiOS — un
 * BUDGET EN OCTETS, a cote de son plafond en nombre de trames — parce
 * que `max-policy-packet-capture-size` se compte en megaoctets et
 * qu'un plafond en trames ne peut pas l'exprimer.
 *
 * **`capture-packet` n'est offert que sous `logtraffic all` ou `utm`**,
 * et ce n'est pas une deduction : la reference l'ecrit, « This is
 * available if the logtraffic setting is all or utm ». La capture est
 * une consequence de la journalisation, pas un reglage independant.
 *
 * **La taille vit sous `config log disk setting`**, l'objet que la
 * reference lui donne, et cet objet n'existait pas. Il est declare avec
 * le SEUL attribut que ce simulateur sait honorer : un objet a moitie
 * rempli d'attributs inertes serait le defaut qu'on vient de refermer.
 * Le disque, lui, existe deja — le profil FortiGate en declare un de
 * 32 Go — donc la commande a bien un support et n'est pas un decor.
 *
 * Deux limites mesurees et ecrites plutot que tues. La plus petite
 * valeur que la CLI accepte est UN megaoctet, ce qu'aucun laboratoire
 * n'atteint en pingant : le budget est donc eprouve sur le magasin
 * lui-meme, et le chemin CLI sur ce qu'il pose. Et a un megaoctet, avec
 * des trames de taille ordinaire, c'est le plafond en NOMBRE de trames
 * de l'anneau (512) qui mord le premier — le budget en octets ne devient
 * la contrainte active que pour des trames tres grandes ou un budget
 * plus petit que la CLI ne sait exprimer. Et la capture retient la trame ENTRANTE :
 * c'est le point ou la politique est connue, et le seul ou une trame
 * existe encore telle qu'elle est arrivee.
 *
 * Discrimine par `git stash push -- src/network/` : 9 des 11 cas
 * tombent, et le dire ainsi serait flatteur sans la precision qui suit —
 * SEPT d'entre eux tombent pour une raison de STRUCTURE, le magasin de
 * captures et l'objet `log disk setting` n'existant pas du tout avant le
 * correctif ; DEUX portent une mesure de comportement, « delete-all
 * efface les captures de politique » et surtout « delete-all NE TOUCHE
 * PAS au tampon du renifleur », qui est le defaut observable de ce lot.
 * Les 2 cas qui passent des deux cotes sont nommes ici :
 *
 *   - « le laboratoire relaie vraiment » est le TEMOIN ;
 *   - « le reglage est accepte et rendu » passait deja, et c'est
 *     l'enonce meme du defaut : accepte, rendu, lu par personne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { PolicyCaptureStore } from '@/network/devices/firewall/diag/PolicyCaptureStore';
import { resetCounters, MACAddress, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(command: string): Promise<string> }

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

async function laboratoire(reglages: readonly string[] = []) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', -200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    ...reglages, 'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0',
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a };
}

const CAPTURE = Object.freeze(['set capture-packet enable']);

function trameDe(octets: number) {
  return {
    at: 0,
    iface: 'port1',
    direction: 'in' as const,
    frame: {
      srcMAC: MACAddress.broadcast(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: { totalLength: octets },
    },
  };
}

describe('la capture par politique', () => {
  it('le laboratoire relaie vraiment', async () => {
    const { a } = await laboratoire();

    expect(await runOn(a, 'ping -c 1 10.2.2.10')).toContain('0% packet loss');
  });

  it('sans le reglage, rien n_est capture par la politique', async () => {
    const { fw, a } = await laboratoire();
    await runOn(a, 'ping -c 2 10.2.2.10');

    expect(fw.getPolicyCaptures().total()).toBe(0);
  });

  it('le reglage est accepte et rendu', async () => {
    const { sh } = await laboratoire(CAPTURE);

    expect(sh.execute('show firewall policy 1')).toContain('set capture-packet enable');
  });

  it('avec le reglage, la politique capture ses paquets', async () => {
    const { fw, a } = await laboratoire(CAPTURE);
    await runOn(a, 'ping -c 2 10.2.2.10');

    expect(fw.getPolicyCaptures().countOf('1')).toBeGreaterThan(0);
  });

  it('la capture est rangee SOUS la politique qui a correspondu', async () => {
    const { fw, a } = await laboratoire(CAPTURE);
    await runOn(a, 'ping -c 1 10.2.2.10');

    expect(fw.getPolicyCaptures().policyIds()).toEqual(['1']);
  });

  it('delete-all efface les captures de politique', async () => {
    const { fw, sh, a } = await laboratoire(CAPTURE);
    await runOn(a, 'ping -c 2 10.2.2.10');

    expect(sh.execute('execute policy-packet-capture delete-all'))
      .toMatch(/captured packets deleted/);
    expect(fw.getPolicyCaptures().total()).toBe(0);
  });

  it('delete-all NE TOUCHE PAS au tampon du renifleur', async () => {
    const { fw, sh, a } = await laboratoire(CAPTURE);
    await runOn(a, 'ping -c 2 10.2.2.10');
    const avant = fw.getPacketCapture().count();
    sh.execute('execute policy-packet-capture delete-all');

    expect(avant).toBeGreaterThan(0);
    expect(fw.getPacketCapture().count()).toBe(avant);
  });

  it('capture-packet n_est pas offert sous logtraffic disable', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1', 'set logtraffic disable');

    expect(sh.execute('set capture-packet enable')).toMatch(/Command fail/);
    sh.execute('abort');
  });

  it('config log disk setting pose la taille et la rend', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config log disk setting',
      'set max-policy-packet-capture-size 8', 'end');

    expect(sh.execute('show log disk setting'))
      .toContain('set max-policy-packet-capture-size 8');
    expect(fw.getPolicyCaptures().getMaxSizeMb()).toBe(8);
  });

  it('le budget en octets evince les plus anciennes trames', () => {
    const magasin = new PolicyCaptureStore();
    magasin.setMaxSizeMb(0);
    for (let index = 0; index < 8; index++) magasin.record('1', trameDe(200_000));
    const sansBudget = magasin.countOf('1');

    magasin.setMaxSizeMb(1);

    expect(sansBudget).toBe(8);
    expect(magasin.countOf('1')).toBe(5);
  });

  it('une taille nulle veut dire illimitee', () => {
    const magasin = new PolicyCaptureStore();
    magasin.setMaxSizeMb(0);
    for (let index = 0; index < 40; index++) magasin.record('1', trameDe(200_000));

    expect(magasin.countOf('1')).toBe(40);
  });
});
