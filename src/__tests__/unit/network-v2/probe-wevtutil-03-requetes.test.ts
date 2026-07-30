/**
 * Probes — `qe` (PRD-Wevtutil.md phase 3).
 *
 * Trois défauts corrigés ici : un détournement par correspondance de
 * chaîne sur le mot « dhcp », des options acceptées sans effet, et un
 * format de sortie inventé.
 *
 * Le dernier scénario est l'aller-retour `epl` → `qe /lf:` : exporter
 * puis relire ce qu'on a exporté. C'est la corrélation qui vaut le plus
 * ici, parce qu'elle met deux commandes en face du même fait au lieu de
 * figer une chaîne de caractères.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ids = (out: string): number[] =>
  [...out.matchAll(/Event ID:\s*(\d+)/g)].map((m) => Number(m[1]));

describe('Scénario 1 — les options ont un effet', () => {
  it('`/c:` limite réellement', async () => {
    const dc = new WindowsServer('DC01');
    expect(ids(String(await dc.executeCmdCommand('wevtutil qe System /c:3 /f:text'))))
      .toHaveLength(3);
    expect(ids(String(await dc.executeCmdCommand('wevtutil qe System /c:1 /f:text'))))
      .toHaveLength(1);
  });

  it('`wevtutil` lit du plus ancien au plus récent, `/rd:true` inverse', async () => {
    const dc = new WindowsServer('DC01');
    const direct = String(await dc.executeCmdCommand('wevtutil qe System /c:1 /f:text'));
    const reverse = String(await dc.executeCmdCommand('wevtutil qe System /c:1 /rd:true /f:text'));
    // C'est le défaut opposé à celui de `Get-WinEvent`, et un piège
    // classique : sans `/rd:true`, `/c:1` rend la *plus ancienne* entrée.
    expect(direct).not.toBe(reverse);
    const oldest = new Date(/Date: (\S+)/.exec(direct)![1]).getTime();
    const newest = new Date(/Date: (\S+)/.exec(reverse)![1]).getTime();
    expect(oldest).toBeLessThanOrEqual(newest);
  });

  it('les trois formats sont distincts et réels', async () => {
    const dc = new WindowsServer('DC01');
    const text = String(await dc.executeCmdCommand('wevtutil qe System /c:1 /f:text'));
    const xml = String(await dc.executeCmdCommand('wevtutil qe System /c:1 /f:xml'));
    const rendered = String(await dc.executeCmdCommand('wevtutil qe System /c:1 /f:renderedxml'));

    expect(text).toContain('  Log Name: System');
    expect(xml).toContain('<Event xmlns=');
    expect(xml).toContain('<EventRecordID>');
    expect(xml, 'le XML brut ne porte pas le message rendu').not.toContain('<RenderingInfo');
    expect(rendered, 'c\'est ce qui distingue RenderedXml de XML').toContain('<RenderingInfo');
  });

  it('un format inconnu est refusé', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil qe System /f:json'))
      .toContain('is not recognized');
  });
});

describe('Scénario 2 — le filtre XPath filtre', () => {
  it('par EventID', async () => {
    const dc = new WindowsServer('DC01');
    const out = String(await dc.executeCmdCommand(
      'wevtutil qe Security /q:"*[System[EventID=4624]]" /f:text'));
    const found = ids(out);
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([4624]));
  });

  it('par fournisseur — sans être détourné par un mot de la ligne de commande', async () => {
    const dc = new WindowsServer('DC01');
    // L'implémentation d'origine bifurquait dès que la ligne contenait
    // « dhcp », où qu'il soit. Une requête sur Security qui mentionne ce
    // mot doit interroger Security, et rien d'autre.
    const out = String(await dc.executeCmdCommand(
      'wevtutil qe Security /q:"*[EventData[Data=\'dhcp-relay\']]" /f:text'));
    expect(out).toContain('No events found');
    expect(out, 'la requête portait sur Security, pas sur le journal DHCP')
      .not.toContain('Dhcp-Client');
  });

  it('par intervalle de temps', async () => {
    const dc = new WindowsServer('DC01');
    const recent = String(await dc.executeCmdCommand(
      'wevtutil qe System /q:"*[System[TimeCreated[timediff(@SystemTime) <= 3600000]]]" /f:text'));
    const all = String(await dc.executeCmdCommand('wevtutil qe System /f:text'));
    expect(ids(recent).length).toBeLessThan(ids(all).length);
  });

  it('par niveau, avec un « ou »', async () => {
    const dc = new WindowsServer('DC01');
    const out = String(await dc.executeCmdCommand(
      'wevtutil qe System /q:"*[System[(Level=2 or Level=3)]]" /f:text'));
    // Level 2 = Error, 3 = Warning — le journal System en contient.
    expect(ids(out).length).toBeGreaterThan(0);
    expect(out).not.toContain('Level: Information');
  });

  it('par champ d\'EventData nommé', async () => {
    const dc = new WindowsServer('DC01');
    dc.getUserManager().checkPassword('Administrator', 'admin');
    const out = String(await dc.executeCmdCommand(
      'wevtutil qe Security /q:"*[EventData[Data[@Name=\'SubjectUserName\']=\'Administrator\']]" /f:text'));
    expect(ids(out).length).toBeGreaterThan(0);
  });

  it('une requête qu\'on ne sait pas évaluer est refusée, pas ignorée', async () => {
    const dc = new WindowsServer('DC01');
    const out = String(await dc.executeCmdCommand(
      'wevtutil qe System /q:"*[System[Computer=\'PC1\']]" /f:text'));
    expect(out).toContain('Failed to process query');
    expect(
      ids(out),
      'un filtre qu\'on ne sait pas appliquer et qui rend tout est pire qu\'absent',
    ).toHaveLength(0);
  });
});

describe('Scénario 3 — exporter puis relire dit la même chose', () => {
  it('`qe /lf:` retrouve ce que `epl` a écrit', async () => {
    const dc = new WindowsServer('DC01');
    const live = ids(String(await dc.executeCmdCommand('wevtutil qe Security /f:text')));

    expect(await dc.executeCmdCommand('wevtutil epl Security C:\\Exp\\Sec.evtx')).toBe('');
    const fromFile = ids(String(await dc.executeCmdCommand(
      'wevtutil qe C:\\Exp\\Sec.evtx /lf:true /f:text')));

    expect(fromFile.length).toBeGreaterThan(0);
    expect(
      fromFile,
      'un export qu\'on ne peut pas relire n\'est pas un export',
    ).toEqual(live);
  });

  it('le filtre s\'applique aussi à un fichier', async () => {
    const dc = new WindowsServer('DC01');
    await dc.executeCmdCommand('wevtutil epl Security C:\\Exp\\Sec.evtx');
    const out = String(await dc.executeCmdCommand(
      'wevtutil qe C:\\Exp\\Sec.evtx /lf:true /q:"*[System[EventID=4625]]" /f:text'));
    expect(new Set(ids(out))).toEqual(new Set([4625]));
  });

  it('un fichier absent est refusé', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil qe C:\\Exp\\Rien.evtx /lf:true'))
      .toContain('cannot find the file');
  });

  it('un journal inconnu aussi', async () => {
    const dc = new WindowsServer('DC01');
    expect(await dc.executeCmdCommand('wevtutil qe Fantome'))
      .toContain('The specified channel could not be found');
  });
});
