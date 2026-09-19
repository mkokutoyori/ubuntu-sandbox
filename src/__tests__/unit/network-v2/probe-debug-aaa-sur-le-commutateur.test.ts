/**
 * Un commutateur qui PORTE AAA ne pouvait pas le deboguer.
 *
 * Mesure de depart, sur un `CiscoSwitch` neuf :
 *
 *   SW(config)# aaa new-model            -> acceptee
 *   SW(config)# radius-server host 1.1.1.1 -> acceptee
 *   SW(config)# aaa ?                    -> accounting / authentication /
 *                                           authorization / group / local /
 *                                           new-model / session-id
 *   SW# debug aaa ?                      -> % Invalid input detected
 *   SW# debug aaa accounting             -> % Invalid input detected
 *
 * La famille `debug aaa` est declaree UNE FOIS, dans `CiscoShellBase`,
 * avec ses trois suites. `CiscoSwitchShell` la filtre par plateforme
 * (`categoryOnPlatform(c, 'switch')`), et `SWITCH_CATEGORIES` ne listait
 * ni `aaa.*`, ni `radius`, ni `tacacs`. Les deux plateformes repondaient
 * donc deux choses differentes a la meme declaration.
 *
 * CE QUI TRANCHE, et qui n'est pas une preference : les emetteurs de ces
 * lignes sont des ABONNEMENTS DE BUS deja ecrits et deja partages --
 * `radius.auth.completed` et `radius.auth.rejected` emettent
 * `AAA/AUTHEN: status = PASS|FAIL`, `radius.accounting.record` emet
 * `AAA/ACCT:`. Rien la-dedans n'est propre au routeur, et le commutateur
 * simule porte `dot1x` et `radius-server`, c'est-a-dire precisement ce
 * qui produit ces evenements. `RouterDebugService` groupe d'ailleurs
 * lui-meme `['AAA', ['aaa.authentication', 'aaa.authorization',
 * 'aaa.accounting', 'radius', 'tacacs']]` : le groupe existait, seule la
 * plateforme le coupait en deux.
 *
 * Discrimine par `git stash push -- src/network` : 5 cas sur 6 tombent.
 * Le sixieme est le TEMOIN -- le routeur, lui, les portait deja ; c'est
 * ce qui distingue « la famille manque » de « la famille n'existe pas ».
 *
 * Le cas `undebug all` a du etre RENFORCE avant d'etre garde : ecrit
 * d'abord comme une simple absence, il passait AVANT correctif pour une
 * raison qui ne prouve rien -- `debug aaa authentication` etant refuse,
 * rien n'etait arme, donc rien ne pouvait paraitre. Il exige maintenant
 * la PRESENCE avant l'absence.
 *
 * Limite assumee, la meme sur les DEUX plateformes et donc pas introduite
 * ici : aucune ligne `AAA/AUTHOR:` n'est emise, faute d'evenement
 * d'autorisation sur le bus. `debug aaa authorization` s'arme et ne dira
 * rien, sur le routeur comme sur le commutateur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = {
  cliHelp(s: string): string;
  executeCommand(c: string): Promise<string>;
};

const SUITES = ['accounting', 'authentication', 'authorization'] as const;

const mots = (aide: string): string[] =>
  aide.split('\n').map(l => /^\s\s(\S+)/.exec(l)?.[1]).filter((m): m is string => !!m);

async function commutateur(nom: string): Promise<Dev> {
  const s = new CiscoSwitch('switch-cisco', nom) as unknown as Dev;
  await s.executeCommand('enable');
  return s;
}

async function routeur(nom: string): Promise<Dev> {
  const r = new CiscoRouter(nom) as unknown as Dev;
  await r.executeCommand('enable');
  return r;
}

describe('debug aaa — une declaration, deux plateformes', () => {
  it('TEMOIN : le routeur offre deja les trois suites', async () => {
    const r = await routeur('R1');
    expect(mots(r.cliHelp('debug aaa '))).toEqual(expect.arrayContaining([...SUITES]));
  });

  it('le commutateur offre les MEMES trois suites', async () => {
    const s = await commutateur('S1');
    expect(mots(s.cliHelp('debug aaa '))).toEqual(expect.arrayContaining([...SUITES]));
  });

  it('`debug ?` du commutateur annonce `aaa`', async () => {
    const s = await commutateur('S2');
    expect(mots(s.cliHelp('debug '))).toContain('aaa');
  });

  it('chaque suite s ARME vraiment et parait dans `show debugging`', async () => {
    const s = await commutateur('S3');
    for (const suite of SUITES) {
      expect(await s.executeCommand(`debug aaa ${suite}`)).not.toContain('Invalid input');
    }
    const vue = await s.executeCommand('show debugging');
    for (const attendu of ['AAA Accounting', 'AAA Authentication', 'AAA Authorization']) {
      expect(vue, attendu).toContain(attendu);
    }
  });

  it('les emetteurs de ces lignes sont debogables aussi', async () => {
    const s = await commutateur('S4');
    for (const famille of ['radius', 'tacacs']) {
      expect(await s.executeCommand(`debug ${famille}`)).not.toContain('Invalid input');
    }
    expect(mots(s.cliHelp('debug '))).toEqual(expect.arrayContaining(['radius', 'tacacs']));
  });

  it('`undebug all` les desarme toutes', async () => {
    const s = await commutateur('S5');
    await s.executeCommand('debug aaa authentication');
    expect(await s.executeCommand('show debugging')).toContain('AAA Authentication');
    await s.executeCommand('undebug all');
    expect(await s.executeCommand('show debugging')).not.toContain('AAA Authentication');
  });
});
