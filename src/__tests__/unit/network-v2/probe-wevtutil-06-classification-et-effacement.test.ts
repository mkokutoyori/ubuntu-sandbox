/**
 * wevtutil et Get-WinEvent disent la même chose d'un événement, et un
 * journal effacé le dit à son tour.
 *
 * L'AUTORITE : la référence `wevtutil` de Windows Commands (official_docs/
 * microsoft/windows-server) pour les verbes et les options (`gl /f:xml`,
 * `sl /rt /ab /ms /l /k /ca /c`, `qe /e /bm /sbm`, `cl /bu`) ; pour le
 * contenu d'un événement, le schéma Microsoft-Windows-Security-Auditing tel
 * que Windows l'écrit (Level 0 + Keywords 0x8020…/0x8010… pour un audit,
 * Task = sous-catégorie d'audit, 1102 dans Security et 104 dans System
 * quand un journal est effacé). Le texte de ces événements n'a pas pu être
 * relu à la source (learn.microsoft.com n'est pas joignable d'ici).
 *
 * MESURE DE DEPART (git stash push -- src/network src/powershell) : 24 cas sur 27 tombent. `qe /f:text` rendait
 * « Task: N/A », « Level: SuccessAudit » et « Keyword: N/A » pour tout ;
 * `/f:xml` n'avait ni Version, ni Task, ni Keywords ; Get-WinEvent rendait
 * le NOM du type d'entrée dans `Level` ; `gl /f:xml` ignorait `/f` ;
 * `/e:` de `qe`, `/bm`, `/sbm`, `/ms` minimal, `/ab`, `/l`, `/k`, `/ca`, `/c`
 * étaient ignorés ou refusés ; un `wevtutil cl Security` laissait un
 * journal VIDE (Windows y écrit un 1102) et un `cl Application` n'écrivait
 * aucun 104 dans System ; un journal plein ne perdait ni ses anciennes
 * entrées ni ses nouvelles.
 * Passent des deux côtés : le TEMOIN (l'entrée 4624 de démarrage existe),
 * `/uni` accepté (une option d'encodage sans effet à observer) et l'égalité
 * entre `Clear-EventLog` et `wevtutil cl`, vraie avant le correctif pour la
 * mauvaise raison (aucun des deux n'écrivait de 104) : elle garde qu'un seul
 * chemin écrit la trace.
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

const field = (out: string, name: string): string =>
  out.split('\n').find((l) => l.trim().startsWith(`${name}:`))?.split(':').slice(1).join(':').trim() ?? '';

const wevtutil = async (dc: WindowsServer, args: string): Promise<string> =>
  String(await dc.executeCmdCommand(`wevtutil ${args}`));

const records = async (dc: WindowsServer, log: string): Promise<number> =>
  Number(field(await wevtutil(dc, `gli ${log}`), 'numberOfLogRecords'));

const powershell = (dc: WindowsServer) => PowerShellSubShell.create(dc).subShell;
const run = async (sh: ReturnType<typeof powershell>, line: string): Promise<string> =>
  (await sh.processLine(line)).output.join('\n');

describe('la classification d\'un événement', () => {
  it('TEMOIN: l\'entrée 4624 de démarrage existe', async () => {
    const dc = new WindowsServer('DC01');
    expect(await wevtutil(dc, 'qe Security /q:"*[System[EventID=4624]]" /c:1 /f:text')).toContain('Event ID: 4624');
  });

  it('qe /f:text: un audit de succès est Information / Audit Success / Logon', async () => {
    const dc = new WindowsServer('DC01');
    const text = await wevtutil(dc, 'qe Security /q:"*[System[EventID=4624]]" /c:1 /f:text');
    expect(text).toContain('Task: Logon');
    expect(text).toContain('Level: Information');
    expect(text).toContain('Keyword: Audit Success');
  });

  it('qe /f:text: un audit d\'échec porte Audit Failure', async () => {
    const dc = new WindowsServer('DC01');
    const text = await wevtutil(dc, 'qe Security /q:"*[System[EventID=4625]]" /c:1 /f:text');
    expect(text).toContain('Keyword: Audit Failure');
    expect(text).toContain('Task: Logon');
  });

  it('qe /f:text: la date n\'a pas de Z et porte les millisecondes', async () => {
    const dc = new WindowsServer('DC01');
    const text = await wevtutil(dc, 'qe Security /c:1 /f:text');
    expect(text).toMatch(/Date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\n/);
  });

  it('qe /f:xml: Level 0, Task numérique, Keywords hexadécimaux et GUID du fournisseur', async () => {
    const dc = new WindowsServer('DC01');
    const xml = await wevtutil(dc, 'qe Security /q:"*[System[EventID=4624]]" /c:1 /f:xml');
    expect(xml).toContain("<Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-A5BA-3E3B0328C30D}'/>");
    expect(xml).toContain('<Version>2</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords>');
    expect(xml).toMatch(/<TimeCreated SystemTime='\d{4}-\d{2}-\d{2}T[\d:]+\.\d{7}Z'\/>/);
  });

  it('qe /q: sur Level=0 retient les audits, plus Level=4', async () => {
    const dc = new WindowsServer('DC01');
    expect(await wevtutil(dc, 'qe Security /q:"*[System[Level=0]]" /c:1 /f:text')).toContain('Event ID:');
    expect(await wevtutil(dc, 'qe Security /q:"*[System[Level=4]]" /c:1 /f:text')).toContain('No events found');
  });

  it('qe /f:renderedxml: le niveau, la tâche et les mots-clés sont rendus en clair', async () => {
    const dc = new WindowsServer('DC01');
    const xml = await wevtutil(dc, 'qe Security /q:"*[System[EventID=4624]]" /c:1 /f:renderedxml');
    expect(xml).toContain('<Task>Logon</Task>');
    expect(xml).toContain('<Keywords><Keyword>Audit Success</Keyword></Keywords>');
  });

  it('Get-WinEvent: Level est numérique et les noms affichés sont ceux de wevtutil', async () => {
    const dc = new WindowsServer('DC01');
    const out = await run(powershell(dc),
      "Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624 } | Select-Object -First 1 | ForEach-Object { \"$($_.Level)|$($_.LevelDisplayName)|$($_.TaskDisplayName)|$($_.KeywordsDisplayNames)|$($_.ProviderId)\" }");
    expect(out).toBe('0|Information|Logon|Audit Success|{54849625-5478-4994-A5BA-3E3B0328C30D}');
  });

  it('Get-WinEvent: ToXml et wevtutil /f:xml sont le même document', async () => {
    const dc = new WindowsServer('DC01');
    const viaPowerShell = await run(powershell(dc),
      "Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624 } | Select-Object -First 1 | ForEach-Object { $_.ToXml() }");
    const viaWevtutil = await wevtutil(dc, 'qe Security /q:"*[System[EventID=4624]]" /rd:true /c:1 /f:xml');
    expect(viaPowerShell).toBe(viaWevtutil);
  });

  it('une source classique (Service Control Manager) est Classic, sans tâche', async () => {
    const dc = new WindowsServer('DC01');
    const text = await wevtutil(dc, 'qe System /q:"*[System[EventID=7036]]" /c:1 /f:text');
    expect(text).toContain('Keyword: Classic');
    expect(text).toContain('Task: N/A');
  });
});

describe('effacer un journal', () => {
  it('wevtutil cl Security laisse un 1102 dans Security, avec le compte', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'cl Security');
    expect(await records(dc, 'Security')).toBe(1);
    const text = await wevtutil(dc, 'qe Security /f:text');
    expect(text).toContain('Event ID: 1102');
    expect(text).toContain('Task: Log clear');
    expect(text).toMatch(/Account Name:\tAdministrator/);
  });

  it('wevtutil cl Application laisse un 104 dans System, qui nomme le journal', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'cl Application');
    const xml = await wevtutil(dc, 'qe System /q:"*[System[EventID=104]]" /c:1 /f:xml');
    expect(xml).toContain("<Provider Name='Microsoft-Windows-Eventlog'");
    expect(xml).toContain('<Channel>Application</Channel>');
  });

  it('cl /bu: consigne le fichier de sauvegarde dans le 104', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'cl Application /bu:C:\\Bak\\App.evtx');
    const xml = await wevtutil(dc, 'qe System /q:"*[System[EventID=104]]" /c:1 /f:xml');
    expect(xml).toContain('<BackupPath>C:\\Bak\\App.evtx</BackupPath>');
  });

  it('Clear-EventLog et wevtutil cl écrivent la même trace (un seul chemin)', async () => {
    const viaTool = new WindowsServer('DC01');
    await wevtutil(viaTool, 'cl Application');
    const viaCmdlet = new WindowsServer('DC02');
    await run(powershell(viaCmdlet), 'Clear-EventLog -LogName Application');
    const count = async (dc: WindowsServer): Promise<string> =>
      field(await wevtutil(dc, 'gli System'), 'numberOfLogRecords');
    expect(await count(viaCmdlet)).toBe(await count(viaTool));
  });
});

describe('gl et sl', () => {
  it('gl /f:xml rend un élément channel que sl /c: sait relire', async () => {
    const dc = new WindowsServer('DC01');
    const xml = await wevtutil(dc, 'gl Application /f:xml');
    expect(xml).toMatch(/^<channel name='Application' chid='Application' symbol='' type='Admin' enabled='true' isolation='Application' xmlns='http:\/\/schemas.microsoft.com\/win\/2004\/08\/events'>/);
    expect(xml).toContain('<retention>false</retention><autoBackup>false</autoBackup><maxSize>');
  });

  it('gl: channelAccess et publishing sont renseignés', async () => {
    const dc = new WindowsServer('DC01');
    const text = await wevtutil(dc, 'gl Security');
    expect(field(text, 'channelAccess')).toMatch(/^O:BAG:SYD:/);
    expect(text).toContain('publishing:\n  fileMax: 1');
  });

  it('sl /ms: arrondit au multiple de 64 Ko, minimum 1 Mo', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'sl Application /ms:100000');
    expect(field(await wevtutil(dc, 'gl Application'), 'maxSize')).toBe('1048576');
    await wevtutil(dc, 'sl Application /ms:2000000');
    expect(field(await wevtutil(dc, 'gl Application'), 'maxSize')).toBe('2031616');
  });

  it('sl /rt /ab: l\'archivage automatique exige la rétention', async () => {
    const dc = new WindowsServer('DC01');
    expect(await wevtutil(dc, 'sl Application /ab:true')).toContain('The parameter is incorrect');
    expect(await wevtutil(dc, 'sl Application /rt:true /ab:true')).toBe('');
    const text = await wevtutil(dc, 'gl Application');
    expect(field(text, 'retention')).toBe('true');
    expect(field(text, 'autoBackup')).toBe('true');
    expect(await wevtutil(dc, 'sl Application /rt:false')).toContain('The parameter is incorrect');
    expect(await wevtutil(dc, 'sl Application /ab:false /rt:false')).toBe('');
    expect(field(await wevtutil(dc, 'gl Application'), 'retention')).toBe('false');
  });

  it('sl /l: /k: /ca: /i: /lfn: sont rangés et relus par gl', async () => {
    const dc = new WindowsServer('DC01');
    expect(await wevtutil(dc, 'sl Application /l:3 /k:0x10 /ca:O:BAG:SYD:(A;;0x1;;;WD) /i:custom /lfn:C:\\Logs\\app.evtx')).toBe('');
    const text = await wevtutil(dc, 'gl Application');
    expect(text).toContain('  level: 3');
    expect(text).toContain('  keywords: 0x10');
    expect(field(text, 'channelAccess')).toBe('O:BAG:SYD:(A;;0x1;;;WD)');
    expect(field(text, 'isolation')).toBe('Custom');
    expect(text).toContain('logFileName: C:\\Logs\\app.evtx');
  });

  it('sl /c: lit le fichier de configuration de la référence', async () => {
    const dc = new WindowsServer('DC01');
    dc.getFileSystem().createFile('C:\\config.xml',
      "<?xml version='1.0' encoding='UTF-8'?><channel name='Application' isolation='Application' xmlns='https://schemas.microsoft.com/win/2004/08/events'><logging><retention>true</retention><autoBackup>true</autoBackup><maxSize>9000000</maxSize></logging><publishing></publishing></channel>");
    expect(await wevtutil(dc, 'sl /c:C:\\config.xml')).toBe('');
    const text = await wevtutil(dc, 'gl Application');
    expect(field(text, 'retention')).toBe('true');
    expect(field(text, 'autoBackup')).toBe('true');
    expect(field(text, 'maxSize')).toBe('8978432');
  });

  it('une option inconnue est refusée pour le verbe, pas ignorée', async () => {
    const dc = new WindowsServer('DC01');
    expect(await wevtutil(dc, 'gl Security /zzz:1')).toContain('Option "/zzz" is not recognized');
    expect(await wevtutil(dc, 'el /ms:1')).toContain('Option "/ms" is not recognized');
  });

  it('/uni est accepté partout', async () => {
    const dc = new WindowsServer('DC01');
    expect(await wevtutil(dc, 'el /uni:true')).toContain('Security');
  });
});

describe('qe /e /bm /sbm', () => {
  it('/e: enveloppe la sortie XML dans l\'élément racine demandé', async () => {
    const dc = new WindowsServer('DC01');
    const xml = await wevtutil(dc, 'qe System /c:2 /f:xml /e:root');
    expect(xml.startsWith('<root>\n<Event ')).toBe(true);
    expect(xml.endsWith('</Event>\n</root>')).toBe(true);
  });

  it('/sbm puis /bm: la seconde requête reprend après le dernier événement lu', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'qe Application /c:2 /f:text /sbm:C:\\bm.xml');
    expect(String(dc.getFileSystem().readFile('C:\\bm.xml').content)).toMatch(/<Bookmark Channel='Application' RecordId='\d+' IsCurrent='true'\/>/);
    const first = await wevtutil(dc, 'qe Application /f:text');
    const resumed = await wevtutil(dc, 'qe Application /f:text /bm:C:\\bm.xml');
    expect([...resumed.matchAll(/Event\[/g)].length).toBeLessThan([...first.matchAll(/Event\[/g)].length);
    expect([...resumed.matchAll(/Event\[/g)].length).toBe(4);
  });
});

describe('un journal plein', () => {
  const fill = (dc: WindowsServer, log: string, count: number): void => {
    for (let i = 0; i < count; i++) dc.eventLog.writeEventLog(log, 'Probe', 7000 + (i % 10), 'Information', `entrée ${i}`);
  };

  it('sans rétention, les plus anciennes entrées cèdent la place', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'sl Setup /ms:1048576');
    fill(dc, 'Setup', 2200);
    expect(await records(dc, 'Setup')).toBe(2097);
    expect(field(await wevtutil(dc, 'gli Setup'), 'oldestRecordNumber')).not.toBe('1000');
  });

  it('avec rétention, les nouvelles entrées sont perdues', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'sl Setup /ms:1048576 /rt:true');
    fill(dc, 'Setup', 2200);
    expect(await records(dc, 'Setup')).toBe(2097);
    expect(await wevtutil(dc, 'qe Setup /rd:true /c:1 /f:text')).toContain('entrée 2096');
  });

  it('avec rétention et archivage, le journal est sauvegardé puis repart de zéro', async () => {
    const dc = new WindowsServer('DC01');
    await wevtutil(dc, 'sl Setup /ms:1048576 /rt:true /ab:true');
    fill(dc, 'Setup', 2100);
    expect(await records(dc, 'Setup')).toBe(3);
    const listing = String(await dc.executeCmdCommand('dir C:\\Windows\\System32\\winevt\\Logs\\Archive-Setup-*.evtx'));
    expect(listing).toMatch(/Archive-Setup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.evtx/);
  });
});
