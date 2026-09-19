/**
 * Toute application de configuration BGP jetait les sessions.
 *
 * `FirewallBgp.apply` construisait un `BGPEngine` NEUF a chaque appel :
 *
 *   const engine = new BGPEngine(this.deps.deviceId);
 *   ...
 *   this.engine = engine;
 *
 * Un second `config router bgp ... end` -- ajouter un reseau, ajouter un
 * voisin, changer un poids -- remplacait donc le moteur, ses sessions,
 * ses compteurs et sa table. Mesure de depart, sur une session eBGP
 * etablie avec un CiscoRouter qui annonce 10.0.0.0/8 :
 *
 *   apres la premiere application    BGP table version is 1
 *                                    192.168.100.1 ... 00:00:00 1
 *   apres `config network' ajoute    BGP table version is 0
 *                                    192.168.100.1 ...    never Idle
 *
 * La session ne revient pas : le moteur neuf recompose, le pair d'en
 * face tient encore sa session sur l'ancienne, et la table retombe a
 * zero. C'est la sonde `probe-fortigate-bgp-table-version` qui l'a
 * rencontre -- ses laboratoires declarent pour cette raison leur reseau
 * local dans la MEME application que leurs voisins, ce qui n'est pas une
 * facon de configurer un pare-feu, seulement une facon de contourner ce
 * defaut.
 *
 * CE QUE FAIT UNE VRAIE MACHINE : rien de tout cela. Sur un FortiGate,
 * `config router bgp` modifie la configuration en place ; les sessions
 * restent montees, leurs compteurs continuent, et le prefixe ajoute part
 * dans un UPDATE. La remise a zero a sa propre commande,
 * `execute router clear bgp all`, et c'est la seule.
 *
 * CE QUI JUSTIFIE ENCORE UN REDEMARRAGE, et que cette sonde garde : le
 * NUMERO D'AS. Changer l'AS local invalide le `remote-as` que le pair
 * attend ; la session ne peut pas survivre, et une session qui se
 * pretendrait etablie sous un AS qu'elle n'annonce plus serait un
 * mensonge de la vue.
 *
 * Discrimine par `git stash push -- src/network` : 3 cas sur 6 tombent.
 * Les 3 qui passent des deux cotes sont nommes, sans quoi le compte
 * flatterait le lot :
 *  - le TEMOIN, qui prouve que la session monte vraiment ;
 *  - `execute router clear bgp all` et le changement d'AS passent AVANT
 *    correctif pour une raison qui ne prouve rien : tout redemarrait, ils
 *    tombaient donc juste. Ce sont des NON-REGRESSIONS, et c'est la
 *    moitie du lot -- garder la session debout ne doit pas emporter les
 *    deux seules facons legitimes de la faire tomber.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const PAIR = '192.168.100.1';

async function laboratoire(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);
  new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);

  await taper(fgt, [
    'config system interface', 'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await taper(r1, [
    'enable', 'configure terminal',
    'interface Loopback0', 'ip address 10.0.0.1 255.0.0.0', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${PAIR} 255.255.255.0`, 'no shutdown', 'exit',
    'router bgp 65001', 'bgp router-id 10.255.255.254',
    'neighbor 192.168.100.99 remote-as 65002',
    'network 10.0.0.0 mask 255.0.0.0', 'end',
  ]);
  await taper(fgt, [
    'config router bgp', 'set as 65002', 'set router-id 10.255.255.1',
    'config neighbor', 'edit 192.168.100.1', 'set remote-as 65001', 'next', 'end',
    'end',
  ]);
  return fgt;
}

const resume = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get router info bgp summary').then(String);

function lignePair(vue: string): string {
  return vue.split('\n').find(l => l.startsWith(PAIR)) ?? '';
}

function messagesRecus(vue: string): number {
  return Number(lignePair(vue).slice(28, 36).trim());
}

const etabli = (vue: string): boolean => !lignePair(vue).includes('never');

describe('config router bgp ne jette pas les sessions', () => {
  it('TEMOIN : la session monte et une route est apprise', async () => {
    const vue = await resume(await laboratoire());
    expect(etabli(vue)).toBe(true);
    expect(messagesRecus(vue)).toBeGreaterThan(0);
  }, 30000);

  it('ajouter un reseau laisse la session DEBOUT', async () => {
    const fgt = await laboratoire();
    const avant = messagesRecus(await resume(fgt));
    await taper(fgt, [
      'config router bgp', 'config network',
      'edit 1', 'set prefix 192.168.100.0 255.255.255.0', 'next', 'end', 'end',
    ]);
    const apres = await resume(fgt);
    expect(etabli(apres)).toBe(true);
    expect(messagesRecus(apres)).toBeGreaterThanOrEqual(avant);
  }, 30000);

  it('le prefixe ajoute part vraiment chez le voisin', async () => {
    const fgt = await laboratoire();
    await taper(fgt, [
      'config router bgp', 'config network',
      'edit 1', 'set prefix 192.168.100.0 255.255.255.0', 'next', 'end', 'end',
    ]);
    expect(await resume(fgt)).toContain('2 BGP AS-PATH entries');
  }, 30000);

  it('ajouter un SECOND voisin ne reinitialise pas le premier', async () => {
    const fgt = await laboratoire();
    const avant = messagesRecus(await resume(fgt));
    await taper(fgt, [
      'config router bgp', 'config neighbor',
      'edit 10.9.9.9', 'set remote-as 65003', 'next', 'end', 'end',
    ]);
    const apres = await resume(fgt);
    expect(etabli(apres)).toBe(true);
    expect(messagesRecus(apres)).toBeGreaterThanOrEqual(avant);
    expect(apres).toContain('10.9.9.9');
  }, 30000);

  it('NON-REGRESSION : `execute router clear bgp all` remet bien a zero', async () => {
    const fgt = await laboratoire();
    expect(etabli(await resume(fgt))).toBe(true);
    await fgt.executeCommand('execute router clear bgp all');
    expect(messagesRecus(await resume(fgt))).toBe(0);
  }, 30000);

  it('changer le NUMERO D AS fait tomber la session, comme il se doit', async () => {
    const fgt = await laboratoire();
    await taper(fgt, ['config router bgp', 'set as 65009', 'end']);
    expect(etabli(await resume(fgt))).toBe(false);
  }, 30000);
});
