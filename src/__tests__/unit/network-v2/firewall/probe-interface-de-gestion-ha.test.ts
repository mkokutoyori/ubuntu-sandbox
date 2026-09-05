/**
 * `set ha-mgmt-intf-only enable` restreignait une politique local-in a
 * une interface qui n'existait pour personne.
 *
 * L'attribut etait declare sur `firewall local-in-policy`, rendu par
 * `show` — donc rejoue a l'import d'une topologie — et jete par
 * `onCommit`. La politique s'appliquait donc sur TOUTES les interfaces
 * la ou l'operateur l'avait reservee a une seule, ce qui est encore la
 * posture d'echec que ce depot interdit : le critere ignore rend la
 * regle plus large que ce qui est ecrit. Mesure avant correctif : la
 * meme politique de refus mord sur `port1` comme sur `port2`, sans
 * distinction, alors que `ha-mgmt-intf-only` dit qu'elle ne concerne
 * que l'interface de gestion reservee.
 *
 * **Et cette interface n'existait pas** : `config system ha` ne portait
 * ni `ha-mgmt-status` ni `config ha-mgmt-interfaces`. Le critere
 * n'etait donc pas seulement non evalue, il etait INEVALUABLE — il
 * nommait une notion absente du modele de grappe. C'est le cas ou la
 * regle du depot demande d'ameliorer le sous-systeme la ou il vit
 * plutot que de contourner : la configuration HA gagne les deux
 * commandes que la reference decrit (« Enable to reserve interfaces to
 * manage individual cluster units », puis la table `ha-mgmt-interfaces`
 * et son `interface`), et le critere devient decidable.
 *
 * **Le critere est resolu au moment du MATCH, pas au commit.**
 * `localInVerdict` ecarte les regles marquees quand l'interface
 * d'arrivee n'est pas reservee ; figer la liste dans la regle au commit
 * aurait fait mentir toute reconfiguration ulterieure de
 * `config system ha`, et donne deux ecritures d'un meme fait.
 *
 * **Ce qui n'est pas modelise n'est pas declare.** La reference donne
 * aussi `dst`, `gateway` et `gateway6` a la table reservee — la route
 * par defaut propre a cette interface, que la FGCP ne synchronise pas.
 * Rien ici ne porte de route non synchronisee par unite, donc ces trois
 * attributs ne sont pas declares du tout : mieux vaut une commande
 * absente qu'une commande acceptee sans effet, qui est exactement le
 * defaut que ce lot referme.
 *
 * Discrimine par `git stash push -- src/network/` : 5 des 9 cas
 * tombent. Les 4 qui passent des deux cotes sont nommes ici :
 *
 *   - « sans politique local-in, les deux interfaces repondent » est le
 *     TEMOIN ;
 *   - « ha-mgmt-intf-only est accepte et rendu » passait deja, et c'est
 *     l'enonce meme du defaut ;
 *   - « la politique mord sur l_interface reservee » passait avant pour
 *     une raison qui ne prouve rien : elle mordait PARTOUT, donc aussi
 *     la. Son jumeau, « elle ne s_applique pas sur l_interface non
 *     reservee », est celui qui porte la mesure ;
 *   - « sans ha-mgmt-intf-only, la politique s_applique partout » est le
 *     cas de non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
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

async function laboratoire(options: {
  reserve?: boolean; restrict?: boolean; policy?: boolean;
} = {}) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 100);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end');

  run(sh, 'config system ha',
    `set ha-mgmt-status ${options.reserve === false ? 'disable' : 'enable'}`,
    'config ha-mgmt-interfaces', 'edit 1', 'set interface "port2"', 'next', 'end',
    'end');

  if (options.policy !== false) {
    run(sh, 'config firewall local-in-policy', 'edit 1',
      ...(options.restrict === false ? [] : ['set ha-mgmt-intf-only enable']),
      'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set action deny', 'next', 'end');
  }

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0');

  return { fw, sh, a, b };
}

describe('l_interface de gestion HA reservee', () => {
  it('sans politique local-in, les deux interfaces repondent', async () => {
    const labo = await laboratoire({ policy: false });

    expect(await runOn(labo.a, 'ping -c 2 10.1.1.1')).toContain(', 0% packet loss');
    expect(await runOn(labo.b, 'ping -c 2 10.2.2.1')).toContain(', 0% packet loss');
  }, 25000);

  it('ha-mgmt-intf-only est accepte et rendu', async () => {
    const labo = await laboratoire();

    expect(labo.sh.execute('show firewall local-in-policy'))
      .toContain('set ha-mgmt-intf-only enable');
  }, 25000);

  it('la reservation est acceptee et rendue', async () => {
    const labo = await laboratoire();
    const rendered = labo.sh.execute('show system ha');

    expect(rendered).toContain('set ha-mgmt-status enable');
    expect(rendered).toContain('set interface "port2"');
  }, 25000);

  it('l_interface nommee est reconnue comme reservee', async () => {
    const labo = await laboratoire();

    expect(labo.fw.isHaManagementInterface('port2')).toBe(true);
  }, 25000);

  it('une interface non nommee ne l_est pas', async () => {
    const labo = await laboratoire();

    expect(labo.fw.isHaManagementInterface('port1')).toBe(false);
  }, 25000);

  it('la politique mord sur l_interface reservee', async () => {
    const labo = await laboratoire();

    expect(await runOn(labo.b, 'ping -c 2 10.2.2.1')).toContain(', 100% packet loss');
  }, 25000);

  it('elle ne s_applique pas sur l_interface non reservee', async () => {
    const labo = await laboratoire();

    expect(await runOn(labo.a, 'ping -c 2 10.1.1.1')).toContain(', 0% packet loss');
  }, 25000);

  it('sans ha-mgmt-intf-only, la politique s_applique partout', async () => {
    const labo = await laboratoire({ restrict: false });

    expect(await runOn(labo.a, 'ping -c 2 10.1.1.1')).toContain(', 100% packet loss');
    expect(await runOn(labo.b, 'ping -c 2 10.2.2.1')).toContain(', 100% packet loss');
  }, 25000);

  it('reservation desactivee, la politique restreinte ne s_applique nulle part', async () => {
    const labo = await laboratoire({ reserve: false });

    expect(await runOn(labo.a, 'ping -c 2 10.1.1.1')).toContain(', 0% packet loss');
    expect(await runOn(labo.b, 'ping -c 2 10.2.2.1')).toContain(', 0% packet loss');
  }, 25000);
});
