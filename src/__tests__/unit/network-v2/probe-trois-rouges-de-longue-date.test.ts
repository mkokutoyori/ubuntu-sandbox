/**
 * Les trois rouges de longue date, et les DEUX defauts de produit qu'ils
 * cachaient.
 *
 * Ecrit A L'AVEUGLE. Chacun des trois cas rouges de la suite s'est revele
 * etre un laboratoire qui decrivait ce qu'une vraie machine REFUSE — mais
 * deux d'entre eux cachaient un defaut de produit, et c'est ce que ce
 * fichier epingle. Le troisieme (`class-map type ?` annoncant `<cr>`) est
 * garde par le garde-fou `probe-aide-cr-tient-sa-promesse`, qui le
 * balayait deja.
 *
 * (1) `Export-Csv` vers un repertoire absent rendait « The system cannot
 * find the path specified. », c'est-a-dire le libelle de Win32 que `cd`
 * et `copy` affichent, sans le nom de l'applet. PowerShell, lui, remonte
 * l'exception .NET du fournisseur : `DirectoryNotFoundException` ecrit
 * « Could not find a part of the path '<chemin>'. » et l'applet la
 * prefixe de son nom. La traduction se fait a la FRONTIERE entre les deux
 * mondes — le fournisseur PowerShell — donc toute applet qui ecrit un
 * fichier en herite, et `cd` garde les mots de Win32.
 *
 * (2) `redistribute ospf metric 2` sous `router rip` etait refuse — c'est
 * juste, IOS exige l'identifiant de processus (`redistribute ospf ?`
 * repond `<1-65535>  Process ID`) — mais le refus arrivait SANS le
 * marqueur `^`, alors que c'est tout ce que ce message apporte. Le
 * gestionnaire rendait une constante la ou le depot a `CliInvalidInput`,
 * qui place le curseur sous le mot fautif.
 *
 * Discrimination : 2 cas tombent avant correctif, et pas trois. Les cas
 * `class-map type` / `policy-map type` passent des DEUX cotes, ce qui est
 * la mesure exacte : le gestionnaire refusait deja correctement, seule
 * l'AIDE mentait — et un `<cr>` annonce ne se lit pas depuis un appel a
 * la commande. Ils sont ici pour garantir que la grammaire desormais
 * partagee n'a pas change ce que la machine repond ; le mensonge, lui,
 * est garde par `probe-aide-cr-tient-sa-promesse`. Meme role pour les
 * deux autres TEMOINS : `cd`, qui doit GARDER les mots de Win32, et la
 * forme complete de `redistribute`, que le correctif ne touche pas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('PowerShell rend l erreur .NET, pas celle de Win32', () => {
  it('`Export-Csv` vers un repertoire absent nomme l applet et le chemin', async () => {
    const dc = new WindowsServer('DC01');
    const sh = PowerShellSubShell.create(dc).subShell;

    const out = (await sh.processLine(
      '1 | Export-Csv -Path "C:\\Absent\\x.csv" -NoTypeInformation')).output.join('\n');

    expect(out).toContain("Export-Csv : Could not find a part of the path 'C:\\Absent\\x.csv'.");
    expect(out).not.toContain('The system cannot find the path specified');
  });

  it('TEMOIN: `cd` garde les mots de Win32', async () => {
    const dc = new WindowsServer('DC01');

    const out = await dc.executeCmdCommand('cd C:\\Absent');

    expect(out).toContain('The system cannot find the path specified');
  });
});

describe('un identifiant de processus manquant porte son marqueur', () => {
  it('`redistribute ospf metric 2` place le curseur sous `metric`', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['enable', 'configure terminal', 'router rip']) await r.executeCommand(c);

    const out = await r.executeCommand('redistribute ospf metric 2');

    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(out.split('\n')[0].trim()).toBe('^');
  });

  it('`redistribute ospf` seul est INCOMPLET, pas invalide', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['enable', 'configure terminal', 'router rip']) await r.executeCommand(c);

    const out = await r.executeCommand('redistribute ospf');

    expect(out).toContain('% Incomplete command.');
    expect(out).not.toContain('Invalid input');
  });

  it('TEMOIN: la forme complete est acceptee et RANGEE', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['enable', 'configure terminal', 'router rip']) await r.executeCommand(c);

    expect(await r.executeCommand('redistribute ospf 1 metric 2')).not.toContain('Invalid');
    expect([...r.getRIPConfig().redistribute.entries()])
      .toEqual([['ospf', { metric: 2, routePolicy: undefined }]]);
  });
});

describe('`class-map` et `policy-map` lisent UNE grammaire', () => {
  it('`class-map type` est incomplet, et son aide ne promet pas `<cr>`', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['enable', 'configure terminal']) await r.executeCommand(c);

    expect(await r.executeCommand('class-map type')).toContain('% Incomplete command.');
    expect(await r.executeCommand('policy-map type')).toContain('% Incomplete command.');
  });

  it('TEMOIN: la forme nommee entre bien dans le sous-mode', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['enable', 'configure terminal']) await r.executeCommand(c);

    expect(await r.executeCommand('class-map type inspect MAP1')).not.toContain('Invalid');
    expect(await r.executeCommand('class-map match-any MAP2')).not.toContain('Invalid');
  });
});
