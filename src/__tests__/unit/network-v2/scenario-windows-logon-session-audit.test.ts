/**
 * Scénario 2 (Windows) — Audit des connexions et sessions : EventIDs
 * 4624, 4625, 4634, 4647.
 *
 * Transcription littérale et fidèle : activation de l'audit via
 * auditpol, génération de connexions de différents LogonType (2
 * interactif via une vérification de mot de passe locale, 10
 * RemoteInteractive et 3 réseau via les deux chemins SSH du
 * simulateur), analyse des échecs 4625, et corrélation
 * connexion/déconnexion par LogonId.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

describe('Scénario 2 (Windows) — audit des connexions et sessions : 4624/4625/4634/4647', () => {
  describe('activation de l\'audit des connexions (auditpol)', () => {
    it('auditpol /set active Logon, Logoff et Other Logon/Logoff Events en succès et échec', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      for (const subcat of ['Logon', 'Logoff', 'Other Logon/Logoff Events']) {
        const out = await pc.executeCmdCommand(`auditpol /set /subcategory:"${subcat}" /success:enable /failure:enable`);
        expect(out).toMatch(/successfully executed/i);
      }
    });

    it('auditpol /get /subcategory:"Logon" reflète "Success and Failure" après activation', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      await pc.executeCmdCommand('auditpol /set /subcategory:"Logon" /success:enable /failure:enable');
      const out = await pc.executeCmdCommand('auditpol /get /subcategory:"Logon"');
      expect(out).toContain('Logon');
      expect(out).toMatch(/Success and Failure/);
    });
  });

  describe('analyse des types de connexion (LogonType)', () => {
    it('une vérification de mot de passe locale réussie journalise 4624 avec Logon Type 2 (Interactif)', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'user');

      const entries = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 4624);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].message).toContain('Logon Type:\t\t2');
    });

    it('une connexion SSH réussie journalise 4624 avec Logon Type 10 (Interactif distant / RemoteInteractive)', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const ctx = pc.getSshServerContext();
      ctx.auth.checkPassword('user', 'user');

      const entries = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 4624);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].message).toContain('Logon Type:\t\t10');
    });

    it('gap confirmé : le champ structuré LogonType est absent de l\'EventData XML — seul le texte libre du message le mentionne', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'user');

      const out = await run(ps(pc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4624 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'LogonType\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).toContain('2');
    });
  });

  describe('analyse des échecs d\'authentification (EventID 4625)', () => {
    it('un échec de connexion journalise 4625 avec TargetUserName correctement renseigné', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'WRONG');

      const out = await run(ps(pc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4625 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).toContain('user');
    });

    it('gap confirmé : le champ SubStatus (cause précise de l\'échec, ex. 0xC000006A) est absent de l\'EventData de 4625', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'WRONG');

      const out = await run(ps(pc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4625 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'SubStatus\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).toMatch(/0xC0000/);
    });

    it('détecte un compte ciblé par force brute (>10 échecs) via Group-Object sur TargetUserName', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      for (let i = 0; i < 11; i++) pc.getUserManager().checkPassword('user', 'WRONG');

      const out = await run(ps(pc), [
        '$Targets = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4625 } | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
        '$Targets | Group-Object | Where-Object {$_.Count -gt 10} | ForEach-Object { "FORCE BRUTE: $($_.Name) - $($_.Count)" }',
      ].join('\n'));
      expect(out).toMatch(/FORCE BRUTE: user - (1[1-9]|[2-9]\d)/);
    });
  });

  describe('corrélation connexion/déconnexion pour mesurer les durées de session', () => {
    it('gap confirmé : TargetLogonId est absent de l\'EventData de 4624 (impossible d\'obtenir l\'identifiant de session à corréler)', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      pc.getUserManager().checkPassword('user', 'user');

      const out = await run(ps(pc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4624 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetLogonId\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).not.toBe('');
    });

    it('gap confirmé : TargetLogonId est également absent de l\'EventData de 4634, la corrélation par LogonId est donc impossible de bout en bout', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const ctx = pc.getSshServerContext();
      ctx.auth.checkPassword('user', 'user');
      ctx.recordLogout?.('user', '10.0.0.5');

      const out = await run(ps(pc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4634 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetLogonId\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).not.toBe('');
    });

    it('une session SSH complète (connexion puis déconnexion) produit un 4624 et un 4634 pairés dans le temps, mais aucun 4647', async () => {
      const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
      const ctx = pc.getSshServerContext();
      ctx.auth.checkPassword('user', 'user');
      ctx.recordLogout?.('user', '10.0.0.5');

      const ids = (pc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
      expect(ids).toContain(4624);
      expect(ids).toContain(4634);
      expect(ids).not.toContain(4647);
    });
  });
});
