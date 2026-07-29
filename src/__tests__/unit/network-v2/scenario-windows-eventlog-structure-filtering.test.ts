/**
 * Scénario 1 (Windows) — Observateur d'événements : structure des
 * canaux, EventIDs clés et filtrage avancé.
 *
 * Transcription littérale et fidèle : inventaire des journaux Windows
 * via `Get-WinEvent -ListLog`, filtrage avancé (`-FilterXml` / XPath,
 * `-FilterHashtable`), et vérification de quelques EventIDs clés du
 * tableau de référence de l'énoncé.
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

const ps = (d: WindowsPC | WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

describe('Scénario 1 (Windows) — observateur d\'événements : structure, EventIDs clés, filtrage avancé', () => {
  describe('structure des journaux Windows (poste et serveur)', () => {
    it('Get-WinEvent -ListLog * liste les quatre canaux principaux (Security, System, Application, Setup)', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const out = await run(ps(pc), 'Get-WinEvent -ListLog * | Select-Object LogName, RecordCount | Format-Table -AutoSize');
      expect(out).toContain('Security');
      expect(out).toContain('System');
      expect(out).toContain('Application');
      expect(out).toContain('Setup');
    });

    it('la même structure de journaux est disponible sur un serveur (WindowsServer)', async () => {
      const dc = new WindowsServer('DC01');
      const out = await run(ps(dc), 'Get-WinEvent -ListLog *');
      expect(out).not.toMatch(/requires -LogName/i);
    });

    it('les objets retournés par -ListLog n\'exposent ni LogType ni IsEnabled : le filtre Where-Object {$_.IsEnabled} ne retient jamais aucun journal', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const sh = ps(pc);
      await run(sh, '$AllLogs = Get-WinEvent -ListLog *');
      const total = await run(sh, '($AllLogs | Measure-Object).Count');
      expect(Number(total)).toBeGreaterThan(0);

      const enabled = await run(sh, '($AllLogs | Where-Object {$_.IsEnabled -and $_.RecordCount -gt 0} | Measure-Object).Count');
      expect(Number(enabled)).toBe(0);
    });

    it('Get-WinEvent -ListLog "Microsoft-Windows-*" ne filtre pas par motif : le nom passé après -ListLog est ignoré, la liste complète est retournée telle quelle', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const sh = ps(pc);
      const allOut = await run(sh, '(Get-WinEvent -ListLog *).Count');
      const patternOut = await run(sh, '(Get-WinEvent -ListLog "Microsoft-Windows-*").Count');
      expect(patternOut).toBe(allOut);

      // Le motif est ignoré, et c'est ce que ce test mesure : la liste
      // rendue contient `Security`, qui ne correspond pourtant pas à
      // `Microsoft-Windows-*`. (L'énoncé vérifiait auparavant l'absence
      // de tout canal `Microsoft-Windows-`, ce qui confondait deux
      // choses : le filtre inopérant, et l'inexistence du canal
      // PowerShell/Operational — lequel existe désormais.)
      const names = await run(sh, "Get-WinEvent -ListLog 'Microsoft-Windows-*' | Select-Object -ExpandProperty LogName");
      expect(names).toMatch(/Security/);
    });

    it('Get-WinEvent -ListLog <journal précis inexistant> -ErrorAction Stop ne lève jamais d\'erreur (aucun journal Microsoft-Windows-*/Operational n\'existe réellement)', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const out = await run(ps(pc), 'Get-WinEvent -ListLog "Microsoft-Windows-Sysmon/Operational" -ErrorAction Stop');
      expect(out).not.toMatch(/error|exception/i);
    });
  });

  describe('filtrage avancé via XPath (-FilterXml)', () => {
    it('-FilterXml n\'est pas un paramètre reconnu par Get-WinEvent : la requête retombe sur l\'erreur de paramètres manquants', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const sh = ps(pc);
      await run(sh, "$XPath_Connexions = '<QueryList><Query Id=\"0\" Path=\"Security\"><Select Path=\"Security\">*[System[(EventID=4624 or EventID=4625)]]</Select></Query></QueryList>'");
      const out = await run(sh, 'Get-WinEvent -FilterXml $XPath_Connexions');
      expect(out).toMatch(/requires -LogName, -FilterHashtable, or -ListLog/i);
    });

    it('à défaut de XPath, le filtre HashTable équivalent (LogName + Id, sans bornes temporelles) fonctionne réellement', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'user');
      pc.getUserManager().checkPassword('user', 'WRONG');

      const out = await run(ps(pc), [
        '$Filter = @{',
        "  LogName   = 'Security'",
        '  Id        = @(4624, 4625, 4634, 4647)',
        '  MaxEvents = 100',
        '}',
        '$Events = Get-WinEvent -FilterHashtable $Filter',
        '$Events | Group-Object Id | Select-Object Name, Count',
      ].join('\n'));
      expect(out).toContain('4624');
      expect(out).toContain('4625');
    });

    it('le filtre HashTable respecte la plage horaire : StartTime dans le futur ne retourne aucun événement passé', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'user');

      const out = await run(ps(pc), "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4624; StartTime = (Get-Date).AddHours(1) }");
      expect(out).toMatch(/No events were found/i);
    });

    it('le filtre HashTable de l\'énoncé (StartTime + EndTime encadrant les dernières 24h) retrouve bien les événements récents', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'user');

      const out = await run(ps(pc), [
        '$Filter = @{',
        "  LogName   = 'Security'",
        '  Id        = @(4624, 4625, 4634, 4647)',
        '  StartTime = (Get-Date).AddHours(-24)',
        '  EndTime   = Get-Date',
        '}',
        'Get-WinEvent -FilterHashtable $Filter -MaxEvents 100',
      ].join('\n'));
      expect(out).toContain('4624');
    });
  });

  describe('tableau des EventIDs clés par catégorie', () => {
    it('EventID 4647 (déconnexion initiée par l\'utilisateur) n\'est jamais généré : seul 4634 existe dans ce simulateur', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const ctx = pc.getSshServerContext();
      ctx.auth.checkPassword('user', 'user');
      ctx.recordLogout?.('user', '10.0.0.5');

      const ids = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
      expect(ids).toContain(4634);
      expect(ids).not.toContain(4647);
    });

    it('sans la stratégie de journalisation, exécuter des commandes ne produit aucun 4104', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, '$env:Test = 1');
      await run(sh, 'Get-Process | Select-Object -First 1');

      // Le canal existe désormais — c'est le cas sur tout Windows
      // moderne — mais il reste vide tant que le Script Block Logging
      // n'est pas demandé. Un canal absent et un canal vide ne se disent
      // pas de la même façon, et c'est bien la stratégie qui décide.
      const logs = await run(sh, "Get-WinEvent -ListLog * | Select-Object -ExpandProperty LogName");
      expect(logs).toMatch(/Microsoft-Windows-PowerShell\/Operational/);

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PowerShell/Operational'; Id = 4104 }");
      expect(out).toMatch(/No events were found/i);
    });

    it('EventID 4697 (service installé) fait partie des EventIDs de configuration système réellement câblés', async () => {
      const dc = new WindowsServer('DC01');
      await run(ps(dc), 'New-Service -Name "TestSvc" -BinaryPathName "C:\\svc.exe" -StartupType Automatic');

      const ids = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
      expect(ids).toContain(4697);
    });
  });
});
