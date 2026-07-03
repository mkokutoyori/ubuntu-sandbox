import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-PC1'): WindowsPC {
  const pc = new WindowsPC('windows-pc', name);
  pc.setCurrentUser('Administrator');
  return pc;
}

function createPS(pc: WindowsPC) {
  const sh = PowerShellSubShell.create(pc).subShell;
  return {
    execute: async (line: string): Promise<string> => {
      const r = await sh.processLine(line);
      return r.output.join('\n');
    },
  };
}

async function buildBaseline(pc: WindowsPC): Promise<{ execute: (l: string) => Promise<string> }> {
  const ps = createPS(pc);
  await ps.execute(
    'New-Service -Name "AppSyncSvc" -BinaryPathName "C:\\Program Files\\AppSync\\appsync.exe" -DisplayName "Application Sync Service" -StartupType Automatic',
  );
  await ps.execute('Start-Service -Name AppSyncSvc');
  pc.getFileSystem().mkdirp('C:\\Program Files\\AppSync');
  pc.getFileSystem().createFile('C:\\Program Files\\AppSync\\appsync.exe', 'MZ-fake-signed-binary');

  if (!pc.getFileSystem().exists('C:\\Baselines')) pc.getFileSystem().mkdirp('C:\\Baselines');

  await ps.execute(
    'Get-WmiObject Win32_Service | Select-Object Name, DisplayName, PathName, StartName, StartMode, State | Export-Csv "C:\\Baselines\\baseline-services.csv" -NoTypeInformation',
  );
  await ps.execute(
    '(Get-FileHash "C:\\Baselines\\baseline-services.csv" -Algorithm SHA256).Hash | Out-File "C:\\Baselines\\baseline-services.sha256"',
  );
  return ps;
}

describe('Scénario 6 — Détection d\'un service malveillant par audit comparatif (baseline hardening)', () => {
  describe('Établissement et protection de la baseline', () => {
    it('la baseline capture tous les services et son hash est stocké', async () => {
      const pc = createPC();
      await buildBaseline(pc);

      const csv = pc.getFileSystem().readFile('C:\\Baselines\\baseline-services.csv');
      expect(csv.ok).toBe(true);
      expect(csv.content).toContain('AppSyncSvc');
      expect(csv.content).toContain('Name');
      expect(csv.content).toContain('StartName');

      const hashFile = pc.getFileSystem().readFile('C:\\Baselines\\baseline-services.sha256');
      expect(hashFile.ok).toBe(true);
      expect((hashFile.content ?? '').trim()).toMatch(/^[0-9A-Fa-f]{64}$/);
    });
  });

  describe('Détection de service non déclaré', () => {
    it('détecte un service ajouté hors baseline et le corrèle avec 4697/7045', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      // Attacker (already-elevated session) installs a rogue implant service:
      // legitimate-sounding name, binary dropped in an unusual user-writable
      // path, running as LocalSystem.
      await ps.execute(
        'New-Service -Name "WinUpdateHelper" -BinaryPathName "C:\\Users\\Public\\svc32.exe" -DisplayName "Windows Update Helper" -StartupType Automatic',
      );
      await ps.execute('sc.exe config WinUpdateHelper obj= "LocalSystem"');
      pc.getFileSystem().mkdirp('C:\\Users\\Public');
      pc.getFileSystem().createFile('C:\\Users\\Public\\svc32.exe', 'MZ-unsigned-implant');

      const detectScript = String.raw`
$baselineCsv = "C:\Baselines\baseline-services.csv"
$baselineHashFile = "C:\Baselines\baseline-services.sha256"
$storedHash = (Get-Content $baselineHashFile).Trim()
$actualHash = (Get-FileHash $baselineCsv -Algorithm SHA256).Hash
$integrityOk = $storedHash -eq $actualHash

$baseline = Get-Content $baselineCsv | ConvertFrom-Csv
$current = Get-WmiObject Win32_Service | Select-Object Name, DisplayName, PathName, StartName, StartMode, State

$diff = Compare-Object -ReferenceObject $baseline -DifferenceObject $current -Property Name
$added = $diff | Where-Object { $_.SideIndicator -eq "=>" }

Write-Output "IntegrityOk=$integrityOk"
Write-Output "AddedCount=$($added.Count)"
foreach ($a in $added) { Write-Output "Added=$($a.Name)" }
`;
      const detectOut = await ps.execute(detectScript);
      expect(detectOut).toContain('IntegrityOk=True');
      expect(detectOut).toContain('AddedCount=1');
      expect(detectOut).toContain('Added=WinUpdateHelper');

      const suspectOut = await ps.execute(
        'Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "WinUpdateHelper" } | Select-Object Name, PathName, StartName',
      );
      expect(suspectOut).toContain('WinUpdateHelper');
      expect(suspectOut).toContain('C:\\Users\\Public\\svc32.exe');
      expect(suspectOut).toContain('LocalSystem');

      const sigOut = await ps.execute('(Get-AuthenticodeSignature "C:\\Users\\Public\\svc32.exe").Status');
      expect(sigOut.trim()).toBe('NotSigned');

      const secLog = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 4697 } | Select-Object -First 1',
      );
      expect(secLog).toContain('WinUpdateHelper');
      expect(secLog).toContain('Administrator');

      const sysLog = await ps.execute(
        'Get-WinEvent -LogName System | Where-Object { $_.Id -eq 7045 } | Select-Object -First 1',
      );
      expect(sysLog).toContain('WinUpdateHelper');
    });

    it("l'intégrité de la baseline elle-même est vérifiée avant toute comparaison (résistance à la falsification)", async () => {
      const pc = createPC();
      await buildBaseline(pc);

      // Tamper with the baseline file directly (bypassing PowerShell) —
      // simulating an attacker with limited filesystem access trying to
      // hide their tracks by editing the reference file.
      const original = pc.getFileSystem().readFile('C:\\Baselines\\baseline-services.csv');
      pc.getFileSystem().createFile(
        'C:\\Baselines\\baseline-services.csv',
        (original.content ?? '') + '\n"WinUpdateHelper","Windows Update Helper","C:\\Users\\Public\\svc32.exe","LocalSystem","Automatic","Running"',
      );

      const ps = createPS(pc);
      const checkOut = await ps.execute(String.raw`
$storedHash = (Get-Content "C:\Baselines\baseline-services.sha256").Trim()
$actualHash = (Get-FileHash "C:\Baselines\baseline-services.csv" -Algorithm SHA256).Hash
$storedHash -eq $actualHash
`);
      expect(checkOut.trim()).toBe('False');
    });
  });

  describe('Neutralisation et journalisation de l\'incident', () => {
    it('neutralise sans supprimer le binaire et journalise EventId 8001 avec attribution complète', async () => {
      const pc = createPC();
      const ps = await buildBaseline(pc);

      await ps.execute(
        'New-Service -Name "WinUpdateHelper" -BinaryPathName "C:\\Users\\Public\\svc32.exe" -DisplayName "Windows Update Helper" -StartupType Automatic',
      );
      pc.getFileSystem().mkdirp('C:\\Users\\Public');
      pc.getFileSystem().createFile('C:\\Users\\Public\\svc32.exe', 'MZ-unsigned-implant');
      await ps.execute('Start-Service -Name WinUpdateHelper');

      const installEvt = await ps.execute(
        'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 4697 -and $_.Message -like "*WinUpdateHelper*" } | Select-Object -First 1',
      );
      expect(installEvt).toContain('WinUpdateHelper');

      // Neutralize: stop + disable, but do NOT delete — preserves forensic
      // evidence (binary + registry key remain in place for analysis).
      await ps.execute('Stop-Service -Name WinUpdateHelper -Force');
      await ps.execute('Set-Service -Name WinUpdateHelper -StartupType Disabled');

      const status = (await ps.execute('(Get-Service -Name WinUpdateHelper).Status')).trim();
      expect(status).toBe('Stopped');
      const startType = (await ps.execute('(Get-Service -Name WinUpdateHelper).StartType')).trim();
      expect(startType).toBe('Disabled');

      // The binary itself must survive neutralization (forensic preservation).
      expect(pc.getFileSystem().exists('C:\\Users\\Public\\svc32.exe')).toBe(true);

      await ps.execute(
        'Write-EventLog -LogName Application -Source "SecurityAudit" -EventId 8001 -EntryType Error ' +
        '-Message "Service non declare neutralise: WinUpdateHelper, Binaire=C:\\Users\\Public\\svc32.exe, Compte=LocalSystem, Action=Neutralise sans suppression"',
      );

      const incidentEvt = await ps.execute(
        'Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 8001 } | Select-Object -First 1',
      );
      expect(incidentEvt).toContain('WinUpdateHelper');
      expect(incidentEvt).toContain('Neutralise sans suppression');

      if (!pc.getFileSystem().exists('C:\\Incidents')) pc.getFileSystem().mkdirp('C:\\Incidents');
      await ps.execute(
        '[PSCustomObject]@{ Service = "WinUpdateHelper"; BinaryPath = "C:\\Users\\Public\\svc32.exe"; Account = "LocalSystem"; Action = "Neutralized" } | ' +
        'ConvertTo-Json | Out-File "C:\\Incidents\\WIN-PC1-incident.json"',
      );
      const incidentFile = pc.getFileSystem().readFile('C:\\Incidents\\WIN-PC1-incident.json');
      expect(incidentFile.ok).toBe(true);
      expect(incidentFile.content).toContain('WinUpdateHelper');
    });
  });
});
