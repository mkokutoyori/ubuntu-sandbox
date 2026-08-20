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

async function getServicePid(pc: WindowsPC, serviceName: string): Promise<number> {
  const out = await pc.executeCommand(`sc queryex ${serviceName}`);
  const m = /PID\s*:\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : -1;
}

const MONITOR_SCRIPT = String.raw`
$targets = @("ServiceNominal","ServiceFuite")

foreach ($svcName in $targets) {
  $svcWmi = Get-WmiObject Win32_Service | Where-Object { $_.Name -eq $svcName }
  if (-not $svcWmi) { continue }
  $procId = $svcWmi.ProcessId
  $proc = Get-Process -Id $procId
  $procName = $proc.Name

  $wsSample = Get-Counter "\Process($procName)\Working Set - Private"
  $cpuSample = Get-Counter "\Process($procName)\% Processor Time"
  $wsBytes = $wsSample.CounterSamples[0].CookedValue
  $cpuPct = $cpuSample.CounterSamples[0].CookedValue

  $wmiPerf = Get-WmiObject Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -eq $procName }

  $sample = [PSCustomObject]@{
    Timestamp    = Get-Date
    Service      = $svcName
    ProcessId    = $procId
    WorkingSetMB = [Math]::Round($wsBytes / 1MB, 2)
    CpuPercent   = [Math]::Round($cpuPct, 2)
    HandleCount  = $wmiPerf.HandleCount
    ThreadCount  = $wmiPerf.ThreadCount
  }

  if (-not (Test-Path "C:\PerfLogs")) { New-Item -ItemType Directory -Path "C:\PerfLogs" | Out-Null }
  $csvPath = "C:\PerfLogs\perf-$svcName-$(Get-Date -Format 'yyyyMMdd').csv"

  $history = @()
  if (Test-Path $csvPath) { $history = @(Get-Content $csvPath | ConvertFrom-Csv) }

  $baseline = if ($history.Count -gt 0) { [double]$history[0].WorkingSetMB } else { $sample.WorkingSetMB }
  $deltas = @()
  for ($i = 1; $i -lt $history.Count; $i++) {
    $deltas += ([double]$history[$i].WorkingSetMB - [double]$history[$i - 1].WorkingSetMB)
  }
  if ($history.Count -gt 0) {
    $deltas += ($sample.WorkingSetMB - [double]$history[$history.Count - 1].WorkingSetMB)
  }

  $sample | Export-Csv -Path $csvPath -Append -NoTypeInformation

  $growthAbsoluteMB = $sample.WorkingSetMB - $baseline
  $growthRelative = if ($baseline -gt 0) { $growthAbsoluteMB / $baseline } else { 0 }
  $trend = if ($deltas.Count -gt 0) { ($deltas | Select-Object -Last 10 | Measure-Object -Average).Average } else { 0 }

  if ($growthAbsoluteMB -gt 50 -and $growthRelative -gt 0.10) {
    Write-EventLog -LogName Application -Source "ResourceMonitor" -EventId 6001 -EntryType Warning -Message "Service $svcName (PID $procId): croissance memoire anormale. Baseline=$baseline Mo, Courant=$($sample.WorkingSetMB) Mo, Delta=$growthAbsoluteMB Mo, Tendance=$trend Mo/echantillon."
  }

  if ($growthAbsoluteMB -gt 200 -or $sample.CpuPercent -gt 90) {
    Write-EventLog -LogName Application -Source "ResourceMonitor" -EventId 6002 -EntryType Error -Message "Service $svcName (PID $procId): seuil critique depasse. Courant=$($sample.WorkingSetMB) Mo, CPU=$($sample.CpuPercent) pourcent."
    Get-Process -Id $procId | Export-Csv -Path "C:\PerfLogs\dump-pre-restart-$svcName-$(Get-Date -Format 'yyyyMMddHHmmss').csv" -NoTypeInformation
    Restart-Service -Name $svcName -Force
    Write-EventLog -LogName Application -Source "ResourceMonitor" -EventId 6003 -Message "Redemarrage automatique declenche suite a depassement critique"
  }
}
`;

async function buildServices(pc: WindowsPC): Promise<{ execute: (l: string) => Promise<string> }> {
  const ps = createPS(pc);
  await ps.execute(
    'New-Service -Name "ServiceNominal" -BinaryPathName "C:\\Services\\ServiceNominal.exe" -DisplayName "Service Nominal" -StartupType Automatic',
  );
  await ps.execute('Start-Service -Name ServiceNominal');
  await ps.execute(
    'New-Service -Name "ServiceFuite" -BinaryPathName "C:\\Services\\ServiceFuite.exe" -DisplayName "Service Fuite Memoire" -StartupType Automatic',
  );
  await ps.execute('Start-Service -Name ServiceFuite');

  if (!pc.getFileSystem().exists('C:\\Scripts')) {
    pc.getFileSystem().mkdirp('C:\\Scripts');
  }
  pc.getFileSystem().createFile('C:\\Scripts\\leak-monitor.ps1', MONITOR_SCRIPT);

  return ps;
}

function registerMonitorTask(pc: WindowsPC): Promise<string> {
  const ps = createPS(pc);
  return ps.execute(String.raw`
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-File "C:\Scripts\leak-monitor.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Seconds 30)
Register-ScheduledTask -TaskName "LeakMonitor" -Action $action -Trigger $trigger
`);
}

describe('Scénario 4 — Analyse de la consommation de ressources et détection de fuite mémoire (Performance Counters / WMI)', () => {
  describe('Collecte des métriques par service', () => {
    it('Get-Counter (Working Set - Private, % Processor Time) et corrélation PID via Get-Process / Win32_Service', async () => {
      const pc = createPC();
      const ps = await buildServices(pc);

      const pid = await getServicePid(pc, 'ServiceFuite');
      expect(pid).toBeGreaterThan(0);

      const wsOut = (await ps.execute(
        '(Get-Counter "\\Process(ServiceFuite)\\Working Set - Private").CounterSamples[0].CookedValue',
      )).trim();
      expect(Number(wsOut)).toBeGreaterThan(0);

      const cpuOut = (await ps.execute(
        '(Get-Counter "\\Process(ServiceFuite)\\% Processor Time").CounterSamples[0].CookedValue',
      )).trim();
      expect(Number(cpuOut)).toBeGreaterThanOrEqual(0);

      const perfOut = await ps.execute(
        'Get-WmiObject Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -eq "ServiceFuite" } | Select-Object HandleCount, ThreadCount, WorkingSetPrivate',
      );
      expect(perfOut).toMatch(/HandleCount/);
      expect(perfOut).toMatch(/ThreadCount/);
      expect(perfOut).toMatch(/WorkingSetPrivate/);

      const wmiPid = (await ps.execute(
        '(Get-WmiObject Win32_Service | Where-Object { $_.Name -eq "ServiceFuite" } | Select-Object -ExpandProperty ProcessId)',
      )).trim();
      expect(Number(wmiPid)).toBe(pid);

      const gpsPid = (await ps.execute('(Get-Process -Id ' + pid + ').Id')).trim();
      expect(Number(gpsPid)).toBe(pid);
    });
  });

  describe('Détection de tendance anormale sur fenêtre glissante', () => {
    it('détecte la fuite mémoire du service défaillant sans faux positif sur le service nominal', async () => {
      const pc = createPC();
      await buildServices(pc);

      const pidNominal = await getServicePid(pc, 'ServiceNominal');
      const pidFuite = await getServicePid(pc, 'ServiceFuite');

      // ServiceFuite leaks ~300KB/sec of private working set — over the
      // 300s (10-sample) window that's ~90MB, comfortably past both the
      // +50MB absolute and +10% relative thresholds. ServiceNominal has no
      // growth profile at all — its consumption never drifts.
      pc.getProcessManager().setLeakProfile(pidFuite, {
        wsKPerSec: 300, handlesPerSec: 2, threadsPerSec: 0.05, cpuPercentPerSec: 0.1,
      });

      await registerMonitorTask(pc);

      // 10 sampling cycles at the configured 30s interval, advanced in
      // discrete steps so the leak profile progresses between firings
      // (a single big advanceTime() would apply all the growth before any
      // catch-up firing runs, making every sample look identical).
      for (let i = 0; i < 10; i++) pc.advanceTime(30_000);

      const ps = createPS(pc);
      const alerts = await ps.execute(
        'Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 6001 }',
      );
      expect(alerts).toContain('ServiceFuite');
      expect(alerts).not.toContain('ServiceNominal');

      const dateStamp = formatYyyyMmDd(pc.simulatedDate());
      const nominalCsv = pc.getFileSystem().readFile(`C:\\PerfLogs\\perf-ServiceNominal-${dateStamp}.csv`);
      expect(nominalCsv.ok).toBe(true);
      const nominalRows = (nominalCsv.content ?? '').trim().split('\n').length - 1;
      expect(nominalRows).toBeGreaterThanOrEqual(9);

      void pidNominal;
    });
  });

  describe('Historique CSV horodaté', () => {
    it('stocke chaque échantillon dans perf-<service>-YYYYMMDD.csv', async () => {
      const pc = createPC();
      await buildServices(pc);
      pc.getProcessManager().setLeakProfile(await getServicePid(pc, 'ServiceFuite'), {
        wsKPerSec: 300, handlesPerSec: 2, threadsPerSec: 0.05, cpuPercentPerSec: 0.1,
      });
      await registerMonitorTask(pc);
      for (let i = 0; i < 10; i++) pc.advanceTime(30_000);

      const dateStamp = formatYyyyMmDd(pc.simulatedDate());
      const csvPath = `C:\\PerfLogs\\perf-ServiceFuite-${dateStamp}.csv`;
      expect(pc.getFileSystem().exists(csvPath)).toBe(true);
      const content = pc.getFileSystem().readFile(csvPath);
      expect(content.ok).toBe(true);
      const lines = (content.content ?? '').trim().split('\n');
      // header + at least 9 data rows (10 sampling cycles).
      expect(lines.length).toBeGreaterThanOrEqual(10);
      expect(lines[0]).toContain('WorkingSetMB');
    });
  });

  describe('Alerte critique, redémarrage automatique et dump pré-incident', () => {
    it('EventId 6002 + Restart-Service + EventId 6003 avec justification, capture pré-restart', async () => {
      const pc = createPC();
      await buildServices(pc);

      const pidBefore = await getServicePid(pc, 'ServiceFuite');
      // Aggressive leak: ~2000KB/sec ⇒ ~600MB over the 300s window, well
      // past the +200MB critical threshold.
      pc.getProcessManager().setLeakProfile(pidBefore, {
        wsKPerSec: 2000, handlesPerSec: 5, threadsPerSec: 0.1, cpuPercentPerSec: 0.1,
      });

      await registerMonitorTask(pc);
      for (let i = 0; i < 10; i++) pc.advanceTime(30_000);

      const ps = createPS(pc);

      const warn = await ps.execute('Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 6001 } | Select-Object -First 1');
      expect(warn).toContain('ServiceFuite');

      const critical = await ps.execute('Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 6002 } | Select-Object -First 1');
      expect(critical).toContain('ServiceFuite');
      expect(critical).toMatch(/PID\s*\d+/);

      const restartLog = await ps.execute('Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 6003 } | Select-Object -First 1');
      expect(restartLog).toContain('Redemarrage automatique declenche suite a depassement critique');

      const pidAfter = await getServicePid(pc, 'ServiceFuite');
      expect(pidAfter).toBeGreaterThan(0);
      expect(pidAfter).not.toBe(pidBefore);

      const dumpFiles = pc.getFileSystem().listDirectory('C:\\PerfLogs')
        .map(e => e.name)
        .filter(n => n.startsWith('dump-pre-restart-ServiceFuite-'));
      expect(dumpFiles.length).toBeGreaterThanOrEqual(1);
      const dump = pc.getFileSystem().readFile('C:\\PerfLogs\\' + dumpFiles[0]);
      expect(dump.ok).toBe(true);
      expect(dump.content).toContain(String(pidBefore));
    });
  });

  describe('Corrélation avec les événements système (REDS)', () => {
    it("le script détecte la dérive sans qu'un signal REDS natif (2004/2013) ne soit jamais requis", async () => {
      const pc = createPC();
      await buildServices(pc);
      pc.getProcessManager().setLeakProfile(await getServicePid(pc, 'ServiceFuite'), {
        wsKPerSec: 300, handlesPerSec: 2, threadsPerSec: 0.05, cpuPercentPerSec: 0.1,
      });
      await registerMonitorTask(pc);
      for (let i = 0; i < 10; i++) pc.advanceTime(30_000);

      const ps = createPS(pc);
      const ownAlert = await ps.execute('Get-WinEvent -LogName Application | Where-Object { $_.Id -eq 6001 } | Select-Object -First 1');
      expect(ownAlert).toContain('ServiceFuite');

      const reds = await ps.execute('Get-WinEvent -LogName System | Where-Object { $_.Id -in @(2004, 2013) }');
      expect(reds.trim()).toBe('');
    });
  });
});

function formatYyyyMmDd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
