/**
 * Scénario 10 — Rôles FSMO : vérification, transfert et saisie.
 *
 * Transcription littérale et fidèle : répartition initiale des 5 rôles
 * FSMO sur DC01 (Get-ADForest/Get-ADDomain/netdom query fsmo), transfert
 * planifié de PDCEmulator/RIDMaster vers DC02 via
 * Move-ADDirectoryServerOperationMasterRole, panne simulée de DC01
 * (câble débranché) puis saisie forcée (-Force) des rôles restants sur
 * DC02, et nettoyage des métadonnées (ntdsutil / Remove-ADDomainController).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
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

async function buildTwoDcs(): Promise<{ dc1: WindowsServer; dc2: WindowsServer; cDc1: Cable }> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const cDc1 = new Cable('c-dc1');
  cDc1.connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc1), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc2), 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  return { dc1, dc2, cDc1 };
}

describe('Scénario 10 — rôles FSMO : vérification, transfert et saisie (mandeng.lan)', () => {
  describe('vérification de la répartition initiale des rôles FSMO', () => {
    it('Get-ADForest | Select DomainNamingMaster, SchemaMaster retourne DC01', async () => {
      const { dc1 } = await buildTwoDcs();
      const out = await run(ps(dc1), 'Get-ADForest | Select-Object DomainNamingMaster, SchemaMaster');
      expect(out).toMatch(/DC01/);
    });

    it('Get-ADDomain | Select InfrastructureMaster, PDCEmulator, RIDMaster retourne DC01', async () => {
      const { dc1 } = await buildTwoDcs();
      const out = await run(ps(dc1), 'Get-ADDomain | Select-Object InfrastructureMaster, PDCEmulator, RIDMaster');
      expect(out).toMatch(/DC01/);
    });

    it('netdom query fsmo liste DC01.mandeng.lan pour les 5 rôles', async () => {
      const { dc1 } = await buildTwoDcs();
      const out = await dc1.executeCmdCommand('netdom query fsmo');
      expect(out).toContain('Schema owner');
      expect(out).toContain('Domain role owner');
      expect(out).toContain('PDC');
      expect(out).toContain('RID pool manager');
      expect(out).toContain('Infrastructure');
      expect(out).toMatch(/DC01\.mandeng\.lan/);
    });
  });

  describe('transfert planifié des rôles FSMO vers DC02', () => {
    it('Move-ADDirectoryServerOperationMasterRole transfère PDCEmulator et RIDMaster vers DC02, InfrastructureMaster reste sur DC01', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      const out = await run(sh, 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole PDCEmulator, RIDMaster -Confirm:$false');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADDomain | Select-Object PDCEmulator, RIDMaster, InfrastructureMaster');
      expect(check).toMatch(/PDCEmulator\s*:\s*DC02/);
      expect(check).toMatch(/RIDMaster\s*:\s*DC02/);
      expect(check).toMatch(/InfrastructureMaster\s*:\s*DC01/);
    });

    it('w32tm /query /status indique DC02.mandeng.lan comme source NTP après transfert du PDC Emulator', async () => {
      const { dc1, dc2 } = await buildTwoDcs();
      await run(ps(dc1), 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole PDCEmulator -Confirm:$false');
      const out = await dc2.executeCmdCommand('w32tm /query /status');
      expect(out).toMatch(/DC02\.mandeng\.lan/);
    });
  });

  describe('saisie forcée (Seizure) en cas de DC défaillant', () => {
    it('Test-Connection DC01.mandeng.lan échoue une fois le câble de DC01 débranché', async () => {
      const { dc2, cDc1 } = await buildTwoDcs();
      cDc1.disconnect();
      const out = await run(ps(dc2), 'Test-Connection DC01.mandeng.lan -Count 2 -ErrorAction SilentlyContinue');
      expect(out).not.toMatch(/TimeToLive|Bytes/);
    });

    it('Move-ADDirectoryServerOperationMasterRole -Force saisit SchemaMaster/DomainNamingMaster/InfrastructureMaster sur DC02 même avec DC01 hors ligne', async () => {
      const { dc1, dc2, cDc1 } = await buildTwoDcs();
      cDc1.disconnect();

      const out = await run(ps(dc2), 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole SchemaMaster, DomainNamingMaster, InfrastructureMaster -Force -Confirm:$false');
      expect(out).not.toMatch(/not recognized/i);

      const forest = await run(ps(dc2), 'Get-ADForest | Select-Object DomainNamingMaster, SchemaMaster');
      expect(forest).toMatch(/DC02/);
      const domain = await run(ps(dc2), 'Get-ADDomain | Select-Object InfrastructureMaster, PDCEmulator, RIDMaster');
      expect(domain).toMatch(/DC02/);
      void dc1;
    });

    it('après saisie complète, tous les rôles FSMO pointent vers DC02.mandeng.lan', async () => {
      const { dc2, cDc1 } = await buildTwoDcs();
      cDc1.disconnect();
      await run(ps(dc2), 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole PDCEmulator, RIDMaster, InfrastructureMaster, SchemaMaster, DomainNamingMaster -Force -Confirm:$false');

      const forest = await run(ps(dc2), 'Get-ADForest | Select-Object DomainNamingMaster, SchemaMaster');
      const domain = await run(ps(dc2), 'Get-ADDomain | Select-Object InfrastructureMaster, PDCEmulator, RIDMaster');
      for (const out of [forest, domain]) {
        expect(out).not.toMatch(/DC01/);
        expect(out).toMatch(/DC02/);
      }
    });

    it('ntdsutil supprime les métadonnées de DC01 après la saisie (nettoyage obligatoire)', async () => {
      const { dc2, cDc1 } = await buildTwoDcs();
      cDc1.disconnect();
      await run(ps(dc2), 'Move-ADDirectoryServerOperationMasterRole -Identity "DC02.mandeng.lan" -OperationMasterRole PDCEmulator, RIDMaster, InfrastructureMaster, SchemaMaster, DomainNamingMaster -Force -Confirm:$false');

      const out = await run(ps(dc2), 'Get-ADDomainController -Filter {Name -eq "DC01"} | Remove-ADDomainController -Confirm:$false');
      expect(out).not.toMatch(/not recognized/i);

      const remaining = await run(ps(dc2), 'Get-ADDomainController -Filter *');
      expect(remaining).not.toContain('DC01');
    });
  });

  describe('documentation de l\'impact de chaque rôle FSMO indisponible', () => {
    it('le script $FSMOImpact documente les 5 rôles et est affichable via Write-Host', async () => {
      const { dc1 } = await buildTwoDcs();
      const out = await run(ps(dc1), [
        '$FSMOImpact = "IMPACT DE L\'INDISPONIBILITE DES ROLES FSMO`n' +
          'Schema Master: Aucun (lecture OK), Modif schema bloquee`n' +
          'Domain Naming: Aucun (lecture OK), Ajout domaine bloque`n' +
          'RID Master: Aucun (pool en cours), Plus de nouveaux SIDs`n' +
          'PDC Emulator: Verrouillages lents, NTP desynchronise, IMMEDIAT`n' +
          'Infrastructure Master: Aucun (domaine unique), Refs cross-domain KO"',
        'Write-Host $FSMOImpact',
      ].join('\n'));
      expect(out).toContain('PDC Emulator');
      expect(out).toContain('IMMEDIAT');
      expect(out).toContain('Schema Master');
    });
  });
});
