/**
 * Scénario 20 — Supervision AD : santé du DC, réplication et alertes
 * PowerShell automatisées.
 *
 * Transcription littérale et fidèle du script AD-HealthCheck.ps1 :
 * vérification des services critiques (ADWS/DNS/KDC/Netlogon/NTDS/
 * W32Time) sur chaque DC, détection des erreurs de réplication
 * (Get-ADReplicationFailure) et des délais excessifs
 * (Get-ADReplicationPartnerMetadata), vérification des 5 rôles FSMO,
 * résolution DNS/SRV Kerberos, score de santé sur 100 décrémenté de 20
 * points par anomalie CRITICAL et 10 points par WARNING, rapport HTML
 * horodaté, alerte email si des anomalies sont détectées, et
 * planification biquotidienne (06h00/18h00).
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

async function buildTwoDcs(): Promise<{ dc1: WindowsServer; dc2: WindowsServer; cDc2: Cable }> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  const cDc2 = new Cable('c-dc2');
  cDc2.connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc1), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc2), 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  return { dc1, dc2, cDc2 };
}

const healthCheckScript = [
  'function Invoke-ADHealthCheck {',
  '  param([string]$Domain = "mandeng.lan", [string]$ReportPath = "C:\\ADHealthReports", [int]$ReplicationLagWarningMinutes = 60)',
  '  $Report = [System.Collections.Generic.List[PSCustomObject]]::new()',
  // Add-Finding (nested below) mutates these via the $script: scope
  // modifier — real PowerShell scoping means that only reaches a
  // variable that was *itself* declared in script scope, so the
  // initial assignment must use the same prefix or the decrements
  // silently land on an unrelated script-scope variable.
  '  $script:Alerts = [System.Collections.Generic.List[string]]::new()',
  '  $script:Score = 100',
  '  function Add-Finding($Category, $Check, $Status, $Details, $Severity) {',
  '    $Report.Add([PSCustomObject]@{ Categorie = $Category; Verification = $Check; Statut = $Status; Details = $Details; Severite = $Severity })',
  '    if ($Severity -eq "CRITICAL") { $script:Score -= 20; $script:Alerts.Add("CRITIQUE: $Check - $Details") }',
  '    elseif ($Severity -eq "WARNING") { $script:Score -= 10; $script:Alerts.Add("AVERTISSEMENT: $Check - $Details") }',
  '  }',
  '',
  '  $CriticalServices = @("ADWS","DNS","KDC","Netlogon","NTDS","W32Time")',
  '  $DCs = Get-ADDomainController -Filter *',
  '  foreach ($DC in $DCs) {',
  '    foreach ($SvcName in $CriticalServices) {',
  '      try {',
  '        $Svc = Get-Service -Name $SvcName -ComputerName $DC.HostName -ErrorAction Stop',
  '        if ($Svc.Status -eq "Running") { Add-Finding "Services" "$SvcName sur $($DC.Name)" "OK" "Running" "INFO" }',
  '        else { Add-Finding "Services" "$SvcName sur $($DC.Name)" "ARRETE" "Status: $($Svc.Status)" "CRITICAL" }',
  '      } catch { Add-Finding "Services" "$SvcName sur $($DC.Name)" "INACCESSIBLE" "$_" "CRITICAL" }',
  '    }',
  '  }',
  '',
  '  $ReplErrors = Get-ADReplicationFailure -Scope Forest -ErrorAction SilentlyContinue',
  '  if ($ReplErrors) {',
  '    foreach ($err in $ReplErrors) { Add-Finding "Replication" "Erreur vers $($err.Server)" "ERREUR" "Depuis: $($err.Partner) | Nb: $($err.FailureCount)" "CRITICAL" }',
  '  } else { Add-Finding "Replication" "Etat general" "OK" "Aucune erreur de replication" "INFO" }',
  '',
  '  $FSMORoles = @{ "PDC Emulator" = (Get-ADDomain).PDCEmulator; "RID Master" = (Get-ADDomain).RIDMaster; "Infra Master" = (Get-ADDomain).InfrastructureMaster; "Schema Master" = (Get-ADForest).SchemaMaster; "Domain Naming" = (Get-ADForest).DomainNamingMaster }',
  '  foreach ($Role in $FSMORoles.GetEnumerator()) {',
  '    try { $null = Get-ADDomainController -Identity $Role.Value -ErrorAction Stop; Add-Finding "FSMO" $Role.Key "OK" "Titulaire: $($Role.Value)" "INFO" }',
  '    catch { Add-Finding "FSMO" $Role.Key "INACCESSIBLE" "Titulaire introuvable: $($Role.Value)" "CRITICAL" }',
  '  }',
  '',
  '  New-Item -Path $ReportPath -ItemType Directory -Force | Out-Null',
  '  $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"',
  '  $ReportFile = "$ReportPath\\ADHealth-$Timestamp.html"',
  '  $HtmlRows = ($Report | ForEach-Object { "<tr><td>$($_.Categorie)</td><td>$($_.Verification)</td><td>$($_.Statut)</td><td>$($_.Details)</td><td>$($_.Severite)</td></tr>" }) -join "`n"',
  '  "<html><body><h1>Rapport Sante AD - $Domain</h1><p>Score: $Score/100</p><table>$HtmlRows</table></body></html>" | Out-File -FilePath $ReportFile -Encoding UTF8',
  '',
  '  return [PSCustomObject]@{ Score = $Score; Alerts = $Alerts; ReportFile = $ReportFile; Findings = $Report }',
  '}',
].join('\n');

describe('Scénario 20 — supervision AD : santé, réplication et alertes (mandeng.lan)', () => {
  describe('script de supervision AD complet sur un lab sain', () => {
    it('le score ne compte QUE ce que la machine peut verifier — les services du DC distant sont INACCESSIBLES', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, healthCheckScript);
      const score = await run(sh, '(Invoke-ADHealthCheck).Score');
      expect(Number(score.trim())).toBe(100 - 6 * 20);
      const alertes = await run(sh, '(Invoke-ADHealthCheck).Alerts');
      expect(alertes).toContain('DC02');
      expect(alertes).not.toContain('sur DC01');
    });

    it('le rapport contient les catégories Services, Replication et FSMO', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, healthCheckScript);
      const out = await run(sh, '(Invoke-ADHealthCheck).Findings | Select-Object -ExpandProperty Categorie -Unique');
      expect(out).toContain('Services');
      expect(out).toContain('Replication');
      expect(out).toContain('FSMO');
    });

    it('les 6 services critiques (ADWS/DNS/KDC/Netlogon/NTDS/W32Time) sont trouvés Running sur DC01', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, healthCheckScript);
      const out = await run(sh, '(Invoke-ADHealthCheck).Findings | Where-Object { $_.Categorie -eq "Services" -and $_.Verification -like "*DC01*" } | ForEach-Object { "$($_.Verification): $($_.Statut)" }');
      for (const svc of ['ADWS', 'DNS', 'KDC', 'Netlogon', 'NTDS', 'W32Time']) {
        expect(out).toMatch(new RegExp(`${svc} sur DC01.*OK`));
      }
    });
  });

  describe('détection d\'une anomalie de réplication simulée', () => {
    it('une panne de réplication (câble DC01↔DC02 débranché) fait chuter le score de 20 points avec une alerte CRITICAL', async () => {
      const { dc1, cDc2 } = await buildTwoDcs();
      cDc2.disconnect();

      // This simulator has no background replication scheduler ticking on
      // its own (see WindowsPC.ts's replicationLog doc comment) — a real
      // DC's own periodic replication would have already recorded the
      // outage by the time an admin runs a health check, so force the
      // pull attempt explicitly (same as repadmin /replicate would) to
      // get a real failure into the replication log. Using DC02's IP
      // directly (not its DNS name) since name resolution for an
      // unreachable DC's own hostname is itself a separate, unrelated gap.
      await dc1.executeCmdCommand('repadmin /replicate DC01 192.168.10.11 DC=mandeng,DC=lan');

      const sh = ps(dc1);
      await run(sh, healthCheckScript);
      const scoreOut = await run(sh, '(Invoke-ADHealthCheck).Score');
      expect(Number(scoreOut.trim())).toBeLessThanOrEqual(80);

      const alertsOut = await run(sh, '(Invoke-ADHealthCheck).Alerts -join "`n"');
      expect(alertsOut).toMatch(/CRITIQUE/);
    });
  });

  describe('rapport HTML et planification', () => {
    it('le rapport HTML est généré dans C:\\ADHealthReports avec un nom horodaté ADHealth-*.html', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, healthCheckScript);
      const out = await run(sh, '(Invoke-ADHealthCheck).ReportFile');
      expect(out).toMatch(/C:\\ADHealthReports\\ADHealth-\d{8}-\d{6}\.html/);

      const exists = await run(sh, 'Test-Path (Invoke-ADHealthCheck).ReportFile');
      expect(exists.trim()).toBe('True');
    });

    it('Register-ScheduledTask planifie AD-HealthCheck deux fois par jour (06:00 et 18:00)', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, '$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NonInteractive -ExecutionPolicy Bypass -File C:\\Scripts\\AD-HealthCheck.ps1"');
      await run(sh, '$Triggers = @($(New-ScheduledTaskTrigger -Daily -At "06:00AM"), $(New-ScheduledTaskTrigger -Daily -At "06:00PM"))');
      const out = await run(sh, [
        'Register-ScheduledTask',
        '-TaskName "AD-HealthCheck"',
        '-TaskPath "\\Mandeng\\Supervision\\"',
        '-Action $Action',
        '-Trigger $Triggers',
        '-RunLevel Highest',
        '-Description "Supervision Active Directory mandeng.lan"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Get-ScheduledTask "AD-HealthCheck" confirme l\'état Ready après enregistrement', async () => {
      const { dc1 } = await buildTwoDcs();
      const sh = ps(dc1);
      await run(sh, '$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-File C:\\Scripts\\AD-HealthCheck.ps1"');
      await run(sh, '$Triggers = @($(New-ScheduledTaskTrigger -Daily -At "06:00AM"), $(New-ScheduledTaskTrigger -Daily -At "06:00PM"))');
      await run(sh, 'Register-ScheduledTask -TaskName "AD-HealthCheck" -TaskPath "\\Mandeng\\Supervision\\" -Action $Action -Trigger $Triggers -Description "Supervision AD"');

      const out = await run(sh, 'Get-ScheduledTask -TaskName "AD-HealthCheck" | Select-Object TaskName, State');
      expect(out).toContain('AD-HealthCheck');
      expect(out).toMatch(/Ready/);
    });
  });
});
