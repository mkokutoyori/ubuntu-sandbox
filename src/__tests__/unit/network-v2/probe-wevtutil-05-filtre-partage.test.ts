/**
 * Probes — le langage de filtre partagé entre `wevtutil` et
 * `Get-WinEvent` (PRD-Wevtutil.md §11, dernier reste déclaré).
 *
 * `wevtutil qe /q:` et `Get-WinEvent -FilterXml` / `-FilterXPath`
 * prennent la même chose : une requête XPath sur un événement. Les
 * faire reposer sur deux analyseurs distincts, c'est garantir qu'un jour
 * l'un comprendra une requête que l'autre refusera. Ces probes tiennent
 * l'invariant qui l'empêche : **pour une même requête, les deux
 * surfaces retiennent les mêmes événements**.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

/** Les EventID retenus par `wevtutil qe` pour cette requête. */
const viaWevtutil = async (dc: WindowsServer, log: string, q: string): Promise<string[]> =>
  [...String(await dc.executeCmdCommand(`wevtutil qe ${log} /q:"${q}" /f:text`))
    .matchAll(/Event ID:\s*(\d+)/g)].map((m) => m[1]).sort();

/** Une requête XPath porte des apostrophes : PowerShell les double. */
const cite = (q: string) => `'${q.replace(/'/g, "''")}'`;

/** Les mêmes, vus par `Get-WinEvent -FilterXPath`. */
const viaPowerShell = async (dc: WindowsServer, log: string, q: string): Promise<string[]> =>
  String(await run(ps(dc), `Get-WinEvent -LogName ${log} -FilterXPath ${cite(q)} | Select-Object -ExpandProperty Id`))
    .split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).sort();

describe('Scénario 1 — une requête, deux surfaces, le même résultat', () => {
  for (const [nom, log, requete] of [
    ['par EventID', 'Security', '*[System[EventID=4624]]'],
    ['par un « ou »', 'Security', '*[System[(EventID=4624 or EventID=4625)]]'],
    ['par niveau', 'System', '*[System[(Level=2 or Level=3)]]'],
    ['par fournisseur', 'System', "*[System[Provider[@Name='Disk']]]"],
    ['sans filtre', 'Application', '*'],
  ] as const) {
    it(nom, async () => {
      const dc = new WindowsServer('DC01');
      const wev = await viaWevtutil(dc, log, requete);
      const psh = await viaPowerShell(dc, log, requete);
      expect(wev.length).toBeGreaterThan(0);
      expect(
        psh,
        'deux analyseurs distincts finiraient par diverger ; celui-ci est partagé',
      ).toEqual(wev);
    });
  }

  it('et refusent la même requête incomprise', async () => {
    const dc = new WindowsServer('DC01');
    const requete = "*[System[Computer='PC1']]";
    expect(await dc.executeCmdCommand(`wevtutil qe System /q:"${requete}"`))
      .toContain('is not supported');
    expect(await run(ps(dc), `Get-WinEvent -LogName System -FilterXPath ${cite(requete)}`))
      .toContain('is not supported');
  });
});

describe('Scénario 2 — `-FilterXml` et son enveloppe `QueryList`', () => {
  it('le canal vient de l\'enveloppe, pas de `-LogName`', async () => {
    const dc = new WindowsServer('DC01');
    const out = await run(ps(dc), [
      "$q = '<QueryList><Query Id=\"0\" Path=\"Security\">"
      + '<Select Path="Security">*[System[EventID=4624]]</Select>'
      + "</Query></QueryList>'",
      'Get-WinEvent -FilterXml $q | Select-Object -ExpandProperty Id',
    ].join('\n'));
    expect(new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))).toEqual(new Set(['4624']));
  });

  it('`Suppress` retire ce que `Select` a retenu', async () => {
    const dc = new WindowsServer('DC01');
    const out = await run(ps(dc), [
      "$q = '<QueryList><Query Id=\"0\" Path=\"Security\">"
      + '<Select Path="Security">*[System[(EventID=4624 or EventID=4625)]]</Select>'
      + '<Suppress Path="Security">*[System[EventID=4625]]</Suppress>'
      + "</Query></QueryList>'",
      'Get-WinEvent -FilterXml $q | Select-Object -ExpandProperty Id',
    ].join('\n'));
    const ids = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
    expect(
      ids,
      'ignorer Suppress rendrait des événements que la requête excluait',
    ).toEqual(new Set(['4624']));
  });

  it('un canal inexistant est signalé, pas rendu vide', async () => {
    const dc = new WindowsServer('DC01');
    const out = await run(ps(dc), [
      "$q = '<QueryList><Query Id=\"0\" Path=\"Fantome\">"
      + '<Select Path="Fantome">*</Select></Query></QueryList>\'',
      'Get-WinEvent -FilterXml $q',
    ].join('\n'));
    // Zéro événement et « ce journal n'existe pas » ne se disent pas de
    // la même façon à qui interroge.
    expect(out).toMatch(/not an event log|matches "Fantome"/i);
  });

  it('une enveloppe malformée est refusée', async () => {
    const dc = new WindowsServer('DC01');
    expect(await run(ps(dc), "Get-WinEvent -FilterXml 'ceci n''est pas du XML'"))
      .toContain('<QueryList>');
  });

  it('`-FilterXPath` sans `-LogName` est refusé', async () => {
    const dc = new WindowsServer('DC01');
    // La forme courte ne porte pas le canal : il faut le donner.
    expect(await run(ps(dc), "Get-WinEvent -FilterXPath '*[System[EventID=4624]]'"))
      .toContain('requires -LogName');
  });

  it('`-MaxEvents` s\'applique aussi au chemin XML', async () => {
    const dc = new WindowsServer('DC01');
    const out = await run(ps(dc), [
      "$q = '<QueryList><Query Id=\"0\" Path=\"System\">"
      + '<Select Path="System">*</Select></Query></QueryList>\'',
      '(Get-WinEvent -FilterXml $q -MaxEvents 3 | Measure-Object).Count',
    ].join('\n'));
    expect(out.trim()).toBe('3');
  });
});
