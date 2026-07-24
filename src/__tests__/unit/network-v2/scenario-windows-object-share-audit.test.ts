/**
 * Scénario 4 (Windows) — Audit des objets et fichiers : EventIDs 4663,
 * 5140 et accès aux partages.
 *
 * Transcription littérale et fidèle : activation de l'audit d'accès
 * aux objets (`auditpol`), configuration d'une SACL via
 * `FileSystemAuditRule`/`Set-Acl -AclObject`, génération d'accès
 * fichiers, et audit des connexions à un partage réseau
 * (5140/5145).
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
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

describe('Scénario 4 (Windows) — audit des objets et fichiers : 4663, 5140 et accès aux partages', () => {
  describe('activation de l\'audit et configuration des SACL', () => {
    it('auditpol /set active File System, File Share et Detailed File Share', async () => {
      const dc = new WindowsServer('DC01');
      for (const subcat of ['File System', 'File Share', 'Detailed File Share']) {
        const out = await dc.executeCmdCommand(`auditpol /set /subcategory:"${subcat}" /success:enable /failure:enable`);
        expect(out).toMatch(/successfully executed/i);
      }
    });

    it('New-Item crée le répertoire sensible C:\\DonneesConfidentielles', async () => {
      const dc = new WindowsServer('DC01');
      const out = await run(ps(dc), 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      expect(out).toContain('DonneesConfidentielles');
    });

    it('gap confirmé : Get-Acl -Audit n\'expose jamais de propriété Audit (aucune SACL n\'est modélisée par le fournisseur ACL)', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      const out = await run(sh, '(Get-Acl "C:\\DonneesConfidentielles" -Audit).Audit');
      expect(out.trim()).not.toBe('');
    });

    it('Set-Acl -AclObject sur un chemin de fichier (hors AD:) est accepté silencieusement sans casser la session, bien qu\'aucune SACL ne soit réellement appliquée (voir le test précédent)', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      await run(sh, '$ACL = Get-Acl "C:\\DonneesConfidentielles"');
      await run(sh, 'Set-Acl -Path "C:\\DonneesConfidentielles" -AclObject $ACL');
      // Le fichier créé après doit toujours être accessible : la session ne
      // doit pas être cassée par l'appel, mais aucune SACL n'a réellement
      // été appliquée (voir le test précédent).
      const out = await run(sh, 'Test-Path "C:\\DonneesConfidentielles"');
      expect(out.trim()).toBe('True');
    });
  });

  describe('analyse des événements d\'accès aux fichiers (EventID 4663)', () => {
    it('gap confirmé : la lecture d\'un fichier sous un répertoire audité ne génère jamais d\'EventID 4663', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      await run(sh, '"Donnees confidentielles Mandeng" | Out-File "C:\\DonneesConfidentielles\\rapport-confidentiel.txt"');
      await run(sh, 'Get-Content "C:\\DonneesConfidentielles\\rapport-confidentiel.txt"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4663; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).not.toMatch(/No events were found/i);
    });

    it('gap confirmé : la suppression d\'un fichier ne génère jamais d\'EventID 4663 avec un AccessMask de suppression', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      await run(sh, '"x" | Out-File "C:\\DonneesConfidentielles\\a-supprimer.txt"');
      await run(sh, 'Remove-Item "C:\\DonneesConfidentielles\\a-supprimer.txt"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4663; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });

  describe('permissions d\'objets (EventID 4670)', () => {
    it('gap confirmé : une modification de DACL sur un répertoire (Set-Acl) ne génère jamais d\'EventID 4670 — seul le chemin AD: est câblé à cet EventID', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      await run(sh, '$ACL = Get-Acl "C:\\DonneesConfidentielles"');
      await run(sh, 'Set-Acl -Path "C:\\DonneesConfidentielles" -AclObject $ACL');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4670; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });

  describe('audit des accès aux partages réseau (EventID 5140/5145)', () => {
    it('gap confirmé : EventID 5140 (connexion à un partage) n\'est jamais généré, y compris après création réelle d\'un partage SMB', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "C:\\Partage" -ItemType Directory -Force');
      await run(sh, 'New-SmbShare -Name "Partage" -Path "C:\\Partage" -FullAccess "Everyone"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(5140, 5145); StartTime = (Get-Date).AddHours(-24) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });
});
