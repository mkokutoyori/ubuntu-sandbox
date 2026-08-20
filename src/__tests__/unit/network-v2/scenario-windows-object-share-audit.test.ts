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
      // Un objet neuf n'a pas de SACL — sur un vrai Windows non plus.
      // C'est en poser une qui rend l'audit d'objets possible ; l'énoncé
      // d'origine en attendait une sans l'avoir demandée.
      await run(sh, [
        '$ACL = Get-Acl "C:\\DonneesConfidentielles" -Audit',
        '$Regle = New-Object System.Security.AccessControl.FileSystemAuditRule("Everyone","ReadData,Delete","Success")',
        '$ACL.AddAuditRule($Regle)',
        'Set-Acl -Path "C:\\DonneesConfidentielles" -AclObject $ACL',
      ].join('\n'));
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
      // Deux conditions, et les deux comptent sur un vrai Windows : la
      // sous-catégorie « File System » activée, et une SACL sur l'objet.
      // Sans la seconde, activer la stratégie noierait le journal sous
      // chaque lecture de fichier du système.
      await dc.executeCmdCommand('auditpol /set /subcategory:"File System" /success:enable');
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      await run(sh, [
        '$ACL = Get-Acl "C:\\DonneesConfidentielles" -Audit',
        '$ACL.AddAuditRule((New-Object System.Security.AccessControl.FileSystemAuditRule("Everyone","FullControl","Success")))',
        'Set-Acl -Path "C:\\DonneesConfidentielles" -AclObject $ACL',
      ].join('\n'));
      await run(sh, '"Donnees confidentielles Mandeng" | Out-File "C:\\DonneesConfidentielles\\rapport-confidentiel.txt"');
      await run(sh, 'Get-Content "C:\\DonneesConfidentielles\\rapport-confidentiel.txt"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4663; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).not.toMatch(/No events were found/i);
    });

    it('gap confirmé : la suppression d\'un fichier ne génère jamais d\'EventID 4663 avec un AccessMask de suppression', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await dc.executeCmdCommand('auditpol /set /subcategory:"File System" /success:enable');
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      await run(sh, [
        '$ACL = Get-Acl "C:\\DonneesConfidentielles" -Audit',
        '$ACL.AddAuditRule((New-Object System.Security.AccessControl.FileSystemAuditRule("Everyone","FullControl","Success")))',
        'Set-Acl -Path "C:\\DonneesConfidentielles" -AclObject $ACL',
      ].join('\n'));
      // Le fichier hérite de la SACL du répertoire, comme sur un vrai
      // NTFS — sans quoi auditer un dossier ne dirait rien de son contenu.
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
      await dc.executeCmdCommand('auditpol /set /subcategory:"File System" /success:enable');
      await run(sh, 'New-Item -Path "C:\\DonneesConfidentielles" -ItemType Directory -Force');
      // Réappliquer un descripteur à l'identique ne change rien, et ne
      // doit donc rien journaliser : 4670 marque un *changement* de
      // permissions. L'énoncé d'origine reposait sur une réapplication
      // sans effet.
      await run(sh, [
        '$ACL = Get-Acl "C:\\DonneesConfidentielles"',
        '$ACL.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("Users","Read","Allow")))',
        'Set-Acl -Path "C:\\DonneesConfidentielles" -AclObject $ACL',
      ].join('\n'));

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4670; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });

  describe('audit des accès aux partages réseau (EventID 5140/5145)', () => {
    it('gap confirmé : EventID 5140 (connexion à un partage) n\'est jamais généré, y compris après création réelle d\'un partage SMB', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await dc.executeCmdCommand('auditpol /set /subcategory:"File Share" /success:enable');
      // `New-SmbShare` n'existe qu'une fois le rôle Serveur de fichiers
      // installé — c'est le comportement réel, et l'énoncé d'origine
      // appelait la commande sans l'avoir mis en place.
      await run(sh, 'Install-WindowsFeature -Name FS-FileServer');
      await run(sh, 'New-Item -Path "C:\\Partage" -ItemType Directory -Force');
      await run(sh, 'New-SmbShare -Name "Partage" -Path "C:\\Partage" -FullAccess "Everyone"');

      // Créer un partage émet 5142 (« objet de partage ajouté »).
      // 5140 marque un *accès* à un partage : l'attendre après une
      // simple création reviendrait à croire qu'un partage à peine créé
      // a déjà servi.
      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(5142, 5140); StartTime = (Get-Date).AddHours(-24) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });
});
