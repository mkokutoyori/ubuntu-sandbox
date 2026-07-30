/**
 * Probes — la surface de `wevtutil` (PRD-Wevtutil.md phase 1).
 *
 * Le défaut que cette phase supprime : l'outil annonçait douze commandes
 * et en tenait quatre, les huit autres retombant sur le texte d'aide. Un
 * script ne pouvait donc pas distinguer une erreur de syntaxe d'une
 * commande absente.
 *
 * La probe la plus importante du fichier est la dernière : elle corrèle
 * `wevtutil el` et `Get-WinEvent -ListLog`. C'est ce genre de corrélation
 * — deux commandes du même système interrogées sur le même fait — qui a
 * fait tomber l'écart d'origine, où `el` rendait une liste écrite dans le
 * code pendant que le fournisseur connaissait un canal de plus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('Scénario 1 — une commande absente le dit', () => {
  it('un verbe inconnu est refusé, pas documenté', async () => {
    const dc = new WindowsServer('DC01');
    const out = await dc.executeCmdCommand('wevtutil zz');
    expect(out).toContain('The specified command was not found');
    expect(
      out,
      'répondre par le texte d\'aide empêche de distinguer une faute de frappe d\'une commande absente',
    ).not.toContain('Windows Events Command Line Utility');
  });

  it('les commandes retirées du périmètre sont refusées comme les autres', async () => {
    const dc = new WindowsServer('DC01');
    // `ep`/`gp`/`im`/`um` supposent un registre d'éditeurs qui n'existe
    // pas ici. Elles ne sont donc ni annoncées, ni acceptées.
    for (const verb of ['ep', 'gp', 'im', 'um', 'enum-publishers']) {
      expect(await dc.executeCmdCommand(`wevtutil ${verb}`))
        .toContain('The specified command was not found');
    }
  });

  it('l\'aide n\'annonce que ce qui existe', async () => {
    const dc = new WindowsServer('DC01');
    const help = await dc.executeCmdCommand('wevtutil /?');
    for (const verb of ['el | enum-logs', 'gl | get-log', 'sl | set-log',
      'gli | get-log-info', 'qe | query-events', 'epl | export-log',
      'al | archive-log', 'cl | clear-log']) {
      expect(help).toContain(verb);
    }
    for (const absent of ['enum-publishers', 'get-publisher', 'install-manifest']) {
      expect(help, `${absent} n'est pas tenue, donc pas annoncée`).not.toContain(absent);
    }
  });

  it('les formes longues valent les formes courtes', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil enum-logs'))
      .toBe(await dc.executeCmdCommand('wevtutil el'));
  });

  it('l\'exécution distante est refusée, pas ignorée', async () => {
    const dc = new WindowsServer('DC01');
    // RPC/DCOM n'est pas modélisé ; l'accepter en silence ferait croire
    // qu'on interroge une autre machine alors qu'on lit la sienne.
    const out = await dc.executeCmdCommand('wevtutil el /r:AUTRE-PC');
    expect(out).toContain('is not recognized');
  });

  it('la porte du service EventLog tient toujours', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.setCurrentUser('Administrator'); // `net stop` exige l'élévation
    await pc.executeCommand('net stop EventLog');
    expect(await pc.executeCommand('wevtutil qe System /c:5'))
      .toMatch(/Event Log service is not running/i);
  });
});

describe('Scénario 2 — `el` et `Get-WinEvent -ListLog` voient le même lien', () => {
  it('les deux commandes énumèrent le même ensemble de journaux', async () => {
    const dc = new WindowsServer('DC01');
    const viaWevtutil = String(await dc.executeCmdCommand('wevtutil el'))
      .split('\n').map((l) => l.trim()).filter(Boolean).sort();
    const viaPowerShell = String(await run(ps(dc),
      'Get-WinEvent -ListLog * | Select-Object -ExpandProperty LogName'))
      .split('\n').map((l) => l.trim()).filter(Boolean).sort();

    expect(viaWevtutil.length).toBeGreaterThan(0);
    expect(
      viaWevtutil,
      'une liste écrite dans le code diverge du registre dès qu\'un canal apparaît',
    ).toEqual(viaPowerShell);
  });

  it('le canal PowerShell/Operational en fait partie', async () => {
    const dc = new WindowsServer('DC01');
    // C'est précisément le canal qui a révélé l'écart : ajouté au
    // fournisseur, il restait invisible de `wevtutil`.
    expect(await dc.executeCmdCommand('wevtutil el'))
      .toContain('Microsoft-Windows-PowerShell/Operational');
  });
});
